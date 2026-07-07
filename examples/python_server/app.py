"""
Python Flask server — CSV + Excel (XLSX) validation via the ImportValidator
native library.

Prerequisites:
    pip install -r requirements.txt
    ./scripts/build-native.sh          # build the native lib (run from repo root)
    export IMPORT_VALIDATOR_LIB=$PWD/crates/validator/target/release/libimport_validator.dylib
    #                          (.so on Linux, import_validator.dll on Windows)

Run:
    python app.py

Endpoints:
    POST /validate          multipart form-data with field 'file' (CSV) and 'schema' (JSON)
    POST /validate/json     JSON body with { "csv": "<base64>", "schema": {...} }
    POST /validate-xlsx     multipart form-data with field 'file' (.xlsx) and 'schema' (JSON)
"""

import base64
import json
import os
import sys

from flask import Flask, jsonify, request

# Add the bindings directory to the path. In a standalone project, install the
# binding module instead. The binding locates the native library through the
# IMPORT_VALIDATOR_LIB environment variable.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "bindings", "python"))
import import_validator as iv

app = Flask(__name__)


def _format_result(result) -> dict:
    return {
        "valid": result.valid,
        "errorCount": len(result.errors),
        "errors": [
            {
                "row": e.row,
                "col": e.col,
                "column": e.column_name,
                "kind": e.kind,
                "code": e.code,
                "codeName": e.code_name,
                "message": e.message,
            }
            for e in result.errors
        ],
        "schemaColumns": result.schema_columns,
        "inputColumns": result.input_columns,
    }


def _run_validation(csv_bytes: bytes, schema: dict) -> dict:
    schema_json = json.dumps(schema)
    result = iv.validate_bytes(csv_bytes, schema_json, max_errors=10_000)
    return _format_result(result)


def _run_xlsx_validation(xlsx_bytes: bytes, schema: dict) -> dict:
    schema_json = json.dumps(schema)
    result = iv.validate_xlsx_bytes(xlsx_bytes, schema_json, max_errors=10_000)
    return _format_result(result)


@app.post("/validate")
def validate_multipart():
    """Accept a multipart upload: field 'file' (CSV bytes) + 'schema' (JSON string)."""
    if "file" not in request.files:
        return jsonify({"error": "Missing 'file' field"}), 400
    if "schema" not in request.form:
        return jsonify({"error": "Missing 'schema' field"}), 400

    csv_bytes = request.files["file"].read()
    try:
        schema = json.loads(request.form["schema"])
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"Invalid schema JSON: {exc}"}), 400

    try:
        return jsonify(_run_validation(csv_bytes, schema))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422


@app.post("/validate/json")
def validate_json():
    """Accept JSON body: { "csv": "<base64-encoded CSV>", "schema": {...} }."""
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Expected JSON body"}), 400
    if "csv" not in body:
        return jsonify({"error": "Missing 'csv' field"}), 400
    if "schema" not in body:
        return jsonify({"error": "Missing 'schema' field"}), 400

    try:
        csv_bytes = base64.b64decode(body["csv"])
    except Exception as exc:
        return jsonify({"error": f"Invalid base64 CSV: {exc}"}), 400

    try:
        return jsonify(_run_validation(csv_bytes, body["schema"]))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422


@app.post("/validate-xlsx")
def validate_xlsx_multipart():
    """Accept a multipart upload: field 'file' (.xlsx bytes) + 'schema' (JSON string).

    The whole workbook is read into memory before validation: XLSX is a ZIP
    container and its central directory sits at the end of the file, so the
    engine needs the complete byte buffer (random access), unlike the
    streaming CSV path.
    """
    if "file" not in request.files:
        return jsonify({"error": "Missing 'file' field"}), 400
    if "schema" not in request.form:
        return jsonify({"error": "Missing 'schema' field"}), 400

    xlsx_bytes = request.files["file"].read()
    try:
        schema = json.loads(request.form["schema"])
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"Invalid schema JSON: {exc}"}), 400

    try:
        return jsonify(_run_xlsx_validation(xlsx_bytes, schema))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422


if __name__ == "__main__":
    print("ImportValidator Python server listening on http://localhost:5000")
    app.run(debug=False, port=5000)
