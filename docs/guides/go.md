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
fmt.Printf("showing %d of %d problems\n",
    len(result.Errors), uint64(len(result.Errors))+result.ErrorsSuppressed)
```

Also: `ValidateBytes(csv, schema, maxErrors, emitNormalized)` and
`ValidateReader(r io.Reader, ...)` for streaming sources (multipart uploads).

## maxErrors and ErrorsSuppressed

`maxErrors` caps how many errors are **recorded**, never how much of the file
is validated. Every row is always read, counted and validated, whatever the
cap — so `engine.RowsProcessed()` and the per-chunk
`progress.RowsProcessed` are complete counts, and raising `maxErrors` never
changes which rows were checked, only how many errors you get back.

Errors found after the cap is reached are counted in
`result.ErrorsSuppressed` (`uint64`) instead of being dropped silently:

```go
total := uint64(len(result.Errors)) + result.ErrorsSuppressed
```

`total` is the exact number of problems in the file. `result.Errors` holds at
most `maxErrors` of them — the first ones encountered, in file order — which
makes `maxErrors` an effective per-file total for this binding and lets you
render "showing 10,000 of 4,213,880 problems" without a second pass.

At engine level the same number is `engine.ErrorsSuppressed()` (alongside
`engine.ErrorsCount()`, the count still queued). Note it keeps counting as the
stream runs, so read it after the final chunk.

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

out, err := os.Create("normalized.csv") // any io.Writer sink
if err != nil {
    return err
}
defer out.Close()

for chunk := range chunks {
    progress, err := engine.PushChunk(chunk, false)
    if err != nil {
        return err
    }
    _ = progress // RowsProcessed / ErrorsAdded per chunk

    // Drain normalised bytes every chunk and write them straight to your sink.
    // Draining only at the end makes the engine hold the whole normalised
    // output in native memory.
    out.Write(engine.TakeNormalized())
}
engine.PushChunk(nil, true)
out.Write(engine.TakeNormalized()) // bytes emitted by the final flush

errs := engine.TakeErrors(100_000)
rows := engine.RowsProcessed()          // complete — never capped by maxErrors
missed := engine.ErrorsSuppressed()     // errors past the cap; len(errs)+missed = total
```

Unlike normalised bytes, do NOT drain errors every chunk unless you mean to:
each `TakeErrors` frees queue slots, so a per-chunk drain can return far more
than `maxErrors` errors for one file. The `Validate*` helpers drain only at the
end, which keeps `maxErrors` a per-file total.

XLSX streaming (when you inflate yourself): `PushSharedStringsChunk` to
completion, then `PushSheetChunk` — or the one-shot
`engine.ValidateXlsxBytes(xlsx)`.

Threading: an `Engine` is NOT thread-safe — one engine per concurrent
validation (engines on different goroutines are fine if not shared).
`iv.EngineVersion()` returns the native engine version.

Memory: normalised output is never truncated. `ValidateFile` / `ValidateBytes`
/ `ValidateReader` drain it after every chunk (so the native buffer stays
small), but they still materialise the complete output in
`result.Normalized` — expect Go heap proportional to the normalised size,
which is roughly the size of the input CSV. For outputs too large to hold in
memory, stream with `NewEngine` + `PushChunk` as above and write each
`TakeNormalized()` slice to a file or response body instead of accumulating.

## Full server example

`examples/go_server/` — net/http server with `/validate` (CSV) and
`/validate-xlsx` endpoints, runnable with its own README.

More: schema contract → [../SCHEMA_REFERENCE.md](../SCHEMA_REFERENCE.md) ·
tuning → [../PERFORMANCE.md](../PERFORMANCE.md) ·
failures → [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
