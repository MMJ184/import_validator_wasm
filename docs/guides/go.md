# Go Integration Guide

CSV + Excel validation from Go via cgo and the native library.

## Get the library + binding

1. Native library: prebuilt release or `./scripts/build-native.sh`
   (see [../NATIVE_CLIENTS.md](../NATIVE_CLIENTS.md)).
2. Module: `github.com/mmj/import-validator/bindings/go` — inside this repo
   (or a vendored copy) use a `replace` directive:

```go
// go.mod
require github.com/mmj/import-validator/bindings/go v0.0.0
replace github.com/mmj/import-validator/bindings/go => ../../bindings/go
```

3. Build environment (adjust paths):

```bash
export CGO_CFLAGS="-I$REPO/bindings/include"
export CGO_LDFLAGS="-L$REPO/crates/validator/target/release"
# runtime: DYLD_LIBRARY_PATH (macOS) / LD_LIBRARY_PATH (Linux) / PATH (Windows)
```

## Quick start — CSV

```go
import iv "github.com/mmj/import-validator/bindings/go"

schema := `{
  "hasHeaders": true,
  "columns": [
    { "name": "id", "type": "int", "required": true, "unique": true },
    { "name": "email", "type": "email", "required": true,
      "modifiers": { "trim": true, "lowercase": true } }
  ]
}`

result, err := iv.ValidateFile("data.csv", schema, 10_000, false)
if err != nil { log.Fatal(err) }
fmt.Println(result.Valid)
for _, e := range result.Errors {
    // e.Row, e.Col, e.Kind, e.Code, e.CodeName, e.ColumnName, e.Message
    fmt.Println(e.Message)   // Row 2, column "email": invalid email format
}
```

Also: `ValidateBytes(csv, schema, maxErrors, emitNormalized)` and
`ValidateReader(r io.Reader, ...)` for streaming sources (multipart uploads).

## Excel (.xlsx)

```go
result, err := iv.ValidateXlsxBytes(xlsxBytes, schema, 10_000, false)
result, err := iv.ValidateXlsxFile("data.xlsx", schema, 10_000, false)
```

ZIP + DEFLATE are handled inside the engine; the first worksheet streams
through the same validation core as CSV.

## Streaming / advanced

```go
engine, err := iv.NewEngine(schema, 10_000, true)
defer engine.Close()

for chunk := range chunks {
    progress, err := engine.PushChunk(chunk, false)
    _ = progress // RowsProcessed / ErrorsAdded per chunk
}
engine.PushChunk(nil, true)

errs := engine.TakeErrors(100_000)
normalized := engine.TakeNormalized()
rows := engine.RowsProcessed()
```

XLSX streaming (when you inflate yourself): `PushSharedStringsChunk` to
completion, then `PushSheetChunk` — or the one-shot
`engine.ValidateXlsxBytes(xlsx)`.

Threading: an `Engine` is NOT thread-safe — one engine per concurrent
validation (engines on different goroutines are fine if not shared).
`iv.EngineVersion()` returns the native engine version.

## Full server example

`examples/go_server/` — net/http server with `/validate` (CSV) and
`/validate-xlsx` endpoints, runnable with its own README.

More: schema contract → [../SCHEMA_REFERENCE.md](../SCHEMA_REFERENCE.md) ·
tuning → [../PERFORMANCE.md](../PERFORMANCE.md) ·
failures → [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
