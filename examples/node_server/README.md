# Node.js Server Example

Express server that validates CSV **and** Excel (`.xlsx`) uploads with
`@import-validator/node`. The WASM engine runs in-process — no Web Worker, no
native library.

What it shows:

- `POST /validate` — CSV multipart upload validated **while it streams** in
  (busboy file stream → `validateStream`); memory stays flat for any file size.
- `POST /validate/buffer` — CSV as base64 in a JSON body → `validateBuffer`.
- `POST /validate-xlsx` — `.xlsx` multipart upload buffered in memory →
  `validateXlsxBuffer`. XLSX is a ZIP container whose central directory sits at
  the end of the file, so the validator needs random access over the whole
  container — a forward-only upload stream cannot be fed to it chunk by chunk.
  For large workbooks, save the upload to disk and use `validateXlsxFile`
  instead (random access on disk, streaming inflate, no full buffer in RAM).

## Prerequisites

Node.js 20+ and pnpm 10+. Build the workspace packages from the repo root:

```bash
pnpm install
pnpm --filter @import-validator/core run build:wasm
pnpm --filter @import-validator/core run build:pkg
pnpm --filter @import-validator/node run build
```

No native library or env vars are needed — this example uses the WASM engine
bundled with `@import-validator/core`.

## Run

```bash
cd examples/node_server
pnpm install --ignore-workspace   # installs express + busboy locally
node server.mjs                   # or: pnpm start   (PORT=3000 by default)
```

## Try it

Create a small schema and test files:

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

CSV (send `schema` **before** `file` — validation starts streaming as soon as
the file part appears, so the schema must already be known):

```bash
curl -X POST http://localhost:3000/validate \
  -F "schema=$(cat /tmp/schema.json)" \
  -F "file=@/tmp/sample.csv;type=text/csv"
```

Excel (generate `/tmp/sample.xlsx` from the CSV with Excel/LibreOffice, or use
`examples/csv-generator` with `--format=xlsx`):

```bash
curl -X POST http://localhost:3000/validate-xlsx \
  -F "schema=$(cat /tmp/schema.json)" \
  -F "file=@/tmp/sample.xlsx"
```

CSV via JSON body (base64):

```bash
curl -X POST http://localhost:3000/validate/buffer \
  -H 'Content-Type: application/json' \
  -d "{\"csv\": \"$(base64 < /tmp/sample.csv | tr -d '\n')\", \"schema\": $(cat /tmp/schema.json)}"
```

Sample response (same shape for all endpoints):

```json
{
  "valid": false,
  "errorCount": 2,
  "rowsProcessed": 3,
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
