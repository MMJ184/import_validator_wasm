# C# Server Example

ASP.NET Core minimal API that validates CSV **and** Excel (`.xlsx`) uploads
through the ImportValidator **native library** (Rust cdylib, called via the
`bindings/csharp` P/Invoke wrapper).

What it shows:

- `POST /validate` — CSV multipart upload → `Validator.ValidateBytes`
- `POST /validate/json` — CSV as base64 in a JSON body
- `POST /validate-xlsx` — `.xlsx` multipart upload →
  `Validator.ValidateXlsxBytes`. The workbook is buffered fully in memory:
  XLSX is a ZIP container whose central directory sits at the end of the file,
  so the engine needs random access over the complete byte buffer.

## Prerequisites

.NET SDK 8.0+, Rust toolchain. From the **repo root**:

```bash
# Build the native shared library
./scripts/build-native.sh
#    → crates/validator/target/release/libimport_validator.dylib  (macOS)
#    → crates/validator/target/release/libimport_validator.so     (Linux)
#    → crates/validator/target/release/import_validator.dll       (Windows)
# Need regex `pattern` support in schemas? build with:
./scripts/build-native.sh --features pattern
```

The example project references `../../bindings/csharp/ImportValidator.csproj`
directly, so `dotnet build`/`dotnet run` compiles the binding automatically.

## Environment

Point the binding at the built library:

```bash
# macOS
export IMPORT_VALIDATOR_LIB=$PWD/crates/validator/target/release/libimport_validator.dylib
# Linux
export IMPORT_VALIDATOR_LIB=$PWD/crates/validator/target/release/libimport_validator.so
# Windows (PowerShell)
$env:IMPORT_VALIDATOR_LIB = "$PWD\crates\validator\target\release\import_validator.dll"
```

## Run

```bash
cd examples/csharp_server
dotnet run          # prints the listening URL (e.g. http://localhost:5000)
```

The curl samples below assume `http://localhost:5000` — substitute the port
`dotnet run` prints.

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
curl -X POST http://localhost:5000/validate \
  -F "schema=$(cat /tmp/schema.json)" \
  -F "file=@/tmp/sample.csv;type=text/csv"
```

Excel (generate `/tmp/sample.xlsx` from the CSV with Excel/LibreOffice, or use
`examples/csv-generator` with `--format=xlsx`):

```bash
curl -X POST http://localhost:5000/validate-xlsx \
  -F "schema=$(cat /tmp/schema.json)" \
  -F "file=@/tmp/sample.xlsx"
```

CSV via JSON body (base64):

```bash
curl -X POST http://localhost:5000/validate/json \
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
