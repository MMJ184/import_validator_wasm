# Go Server Example

`net/http` server that validates CSV **and** Excel (`.xlsx`) uploads through
the ImportValidator **native library** (Rust cdylib, called via the
`bindings/go` cgo wrapper).

What it shows:

- `POST /validate` — CSV multipart upload streamed through the engine via
  `importvalidator.ValidateReader` (chunked, flat memory).
- `POST /validate/json` — CSV as base64 in a JSON body → `ValidateBytes`.
- `POST /validate-xlsx` — `.xlsx` multipart upload buffered in memory →
  `ValidateXlsxBytes`. XLSX is a ZIP container whose central directory sits at
  the end of the file, so the engine needs random access over the complete
  byte buffer — unlike the streaming CSV path.

## Prerequisites

Go 1.21+, a C toolchain (cgo), Rust toolchain. From the **repo root**:

```bash
# Build the native shared library
./scripts/build-native.sh
#    → crates/validator/target/release/libimport_validator.dylib  (macOS)
#    → crates/validator/target/release/libimport_validator.so     (Linux)
#    → crates/validator/target/release/import_validator.dll       (Windows)
# Need regex `pattern` support in schemas? build with:
./scripts/build-native.sh --features pattern
```

## Environment

cgo needs the C header at build time and the dynamic linker needs the library
at run time (run from the repo root):

```bash
export CGO_CFLAGS="-I$(pwd)/bindings/include"
export CGO_LDFLAGS="-L$(pwd)/crates/validator/target/release"
export DYLD_LIBRARY_PATH=$(pwd)/crates/validator/target/release   # macOS
export LD_LIBRARY_PATH=$(pwd)/crates/validator/target/release     # Linux
```

The binding links with `-limport_validator`.

## Run

```bash
cd examples/go_server
go run main.go          # listens on http://localhost:8080 (override with PORT)
```

The local `go.mod` resolves the binding through a `replace` directive pointing
at `../../bindings/go`, so no `go get` is needed.

## Try it

Create a small schema and test file:

```bash
cat > /tmp/schema.json <<'EOF'
{
  "hasHeaders": true,
  "columns": [
    { "name": "id",     "type": "int",     "required": true, "unique": true },
    { "name": "email",  "type": "email",   "required": true },
    { "name": "amount", "type": "decimal", "precision": 2 }
  ]
}
EOF

printf 'id,email,amount\n1,alice@example.com,10.50\n2,not-an-email,3.20\n2,carol@example.com,7.10\n' > /tmp/sample.csv
```

CSV:

```bash
curl -X POST http://localhost:8080/validate \
  -F "schema=$(cat /tmp/schema.json)" \
  -F "file=@/tmp/sample.csv;type=text/csv"
```

Excel (generate `/tmp/sample.xlsx` from the CSV with Excel/LibreOffice, or use
`examples/csv-generator` with `--format=xlsx`):

```bash
curl -X POST http://localhost:8080/validate-xlsx \
  -F "schema=$(cat /tmp/schema.json)" \
  -F "file=@/tmp/sample.xlsx"
```

CSV via JSON body (base64):

```bash
curl -X POST http://localhost:8080/validate/json \
  -H 'Content-Type: application/json' \
  -d "{\"csv\": \"$(base64 < /tmp/sample.csv | tr -d '\n')\", \"schema\": $(cat /tmp/schema.json)}"
```

Sample response (same shape for all endpoints):

```json
{
  "valid": false,
  "errorCount": 2,
  "errors": [
    {
      "row": 2, "col": 1, "column": "email", "kind": "schema",
      "code": 9, "codeName": "InvalidEmail",
      "message": "Row 2, column \"email\": invalid email format"
    },
    {
      "row": 3, "col": 0, "column": "id", "kind": "schema",
      "code": 13, "codeName": "DuplicateValue",
      "message": "Row 3, column \"id\": duplicate value not allowed"
    }
  ],
  "schemaColumns": ["id", "email", "amount"],
  "inputColumns": ["id", "email", "amount"]
}
```
