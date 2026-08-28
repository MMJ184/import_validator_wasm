# Python Integration Guide

CSV + Excel validation from Python (3.9+) via the native library and the
`ctypes` binding — no compilation step on your side, no Python dependencies.

## Get the library + binding

1. Native library: use a prebuilt release
   (`libimport_validator.so` / `.dylib` / `import_validator.dll` — see
   [../NATIVE_CLIENTS.md](../NATIVE_CLIENTS.md)) or build from source:
   `./scripts/build-native.sh`.
2. Binding: `bindings/python/import_validator.py` (installable:
   `pip install ./bindings/python`).
3. Point the binding at the library — either place it next to
   `import_validator.py` or:

```bash
export IMPORT_VALIDATOR_LIB=/abs/path/libimport_validator.dylib
```

## Quick start — CSV

```python
import json
import import_validator as iv

schema = json.dumps({
    "hasHeaders": True,
    "columns": [
        {"name": "id", "type": "int", "required": True, "unique": True},
        {"name": "email", "type": "email", "required": True,
         "modifiers": {"trim": True, "lowercase": True}},
    ],
})

result = iv.validate_bytes(b"id,email\n1,a@b.com\n1,broken\n", schema)
print(result.valid)              # False
for e in result.errors:
    # e.row, e.col, e.kind, e.code, e.code_name, e.column_name, e.message
    print(e.message)             # Row 2, column "id": duplicate value not allowed
```

Also: `iv.validate_file(path, schema, max_errors=..., emit_normalized=...)`.

`ValidationResult` fields: `errors`, `schema_columns`, `input_columns`,
`normalized`, `errors_suppressed`, plus the `valid` property.

## max_errors and `errors_suppressed`

`max_errors` caps how many errors are **recorded**, never how much of the file
is validated. Every row is always read, counted and checked; errors past the
cap are counted rather than dropped, and `result.errors_suppressed` reports how
many there were.

```python
result = iv.validate_bytes(data, schema, max_errors=2_000)
total = len(result.errors) + result.errors_suppressed   # exact problem count
print(f"showing {len(result.errors):,} of {total:,}")   # showing 2,000 of 47,331
```

`len(result.errors) + result.errors_suppressed` is the exact number of problems
in the file, so a UI can show a truncated list and still report the true total.
On the streaming `Engine`, the same number is available as
`engine.errors_suppressed` once the final chunk has been pushed.

## Excel (.xlsx)

```python
result = iv.validate_xlsx_bytes(open("data.xlsx", "rb").read(), schema)
result = iv.validate_xlsx_file("data.xlsx", schema)
```

The engine parses the ZIP container and streams the first worksheet
internally — peak memory tracks shared strings, not sheet size. Same schema
and error codes as CSV.

## Streaming / advanced

```python
with iv.Engine(schema, max_errors=10_000, emit_normalized=True) as engine:
    parts = []
    for chunk in read_chunks(source):            # any byte chunks
        progress = engine.push_chunk(chunk)
        parts.append(engine.take_normalized())   # drain per chunk, not at the end
    engine.push_chunk(b"", final=True)
    parts.append(engine.take_normalized())

    for err in engine.iter_errors(batch_size=5_000):
        handle(err)
    normalized = b"".join(parts)
    print(engine.rows_processed, engine.errors_suppressed, engine.schema_columns())
```

`engine.rows_processed` counts every data row in the file regardless of
`max_errors`. Draining with `iter_errors` mid-stream frees queue slots, so a
long-running `Engine` can surface more than `max_errors` errors in total; the
one-shot helpers drain only at the end, which makes `max_errors` an effective
per-file total there.

`take_normalized()` hands over only what accumulated since the last call, so
calling it once per chunk — or writing each piece straight to a file/socket —
keeps peak memory at one chunk instead of the whole output. The one-shot
helpers `validate_bytes` / `validate_file` drain per chunk internally but still
return the complete output as `result.normalized`. The one-shot XLSX helpers
(`validate_xlsx_bytes`, `validate_xlsx_file`) cannot drain mid-run — the engine
holds the entire normalized output until the single call returns, bounded by
the XLSX size guardrails. Either way, with
`emit_normalized=True` expect memory proportional to the normalized output
size, and prefer the `Engine` loop above for very large files.

XLSX streaming (when you inflate yourself):
`engine.push_shared_strings_chunk(chunk, final=...)` first, then
`engine.push_sheet_chunk(chunk, final=...)` — or just
`engine.validate_xlsx_bytes(xlsx_bytes)` for the one-shot.

Threading: an `Engine` is NOT thread-safe — one engine per concurrent
validation (engines on different threads are fine). Bad schemas raise
`ValueError` with the engine's message; runtime failures raise
`RuntimeError`.

## Full server example

`examples/python_server/` — Flask app with `/validate` (CSV) and
`/validate-xlsx` endpoints, runnable with its own README.

More: schema contract → [../SCHEMA_REFERENCE.md](../SCHEMA_REFERENCE.md) ·
tuning → [../PERFORMANCE.md](../PERFORMANCE.md) ·
failures → [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
