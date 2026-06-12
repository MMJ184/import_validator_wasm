"""
Python Flask server — CSV validation via ImportValidator native library.

Prerequisites:
    pip install flask
    ./scripts/build-native.sh          # build the native lib
    export IMPORT_VALIDATOR_LIB=/path/to/libimport_validator_wasm.dylib

Run:
    python app.py

Endpoints:
    POST /validate          multipart form-data with field 'file' (CSV) and 'schema' (JSON)
    POST /validate/json     JSON body with { "csv": "<base64>", "schema": {...} }
"""

import base64
import json
import os
import sys

from flask import Flask, jsonify, request

# Add the bindings directory to the path.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "bindings", "python"))
import import_validator as iv

app = Flask(__name__)

# Initialise once at startup.
_lib_path = os.environ.get("IMPORT_VALIDATOR_LIB")
iv.load_library(_lib_path)  # Uses IMPORT_VALIDATOR_LIB env-var when _lib_path is None.


def _run_validation(csv_bytes: bytes, schema: dict) -> dict:
    schema_json = json.dumps(schema)
    result = iv.validate_bytes(csv_bytes, schema_json, max_errors=10_000)
    return {
        "valid": result.valid,
        "errorCount": len(result.errors),
        "errors": [
            {
                "row": e.row,
                "col": e.col,
                "kind": e.kind,
                "code": e.code,
                "codeName": e.code_name,
            }
            for e in result.errors
        ],
        "schemaColumns": result.schema_columns,
        "inputColumns": result.input_columns,
    }


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


if __name__ == "__main__":
    print("ImportValidator Python server listening on http://localhost:5000")
    app.run(debug=False, port=5000)
