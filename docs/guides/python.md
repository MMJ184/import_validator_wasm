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
    for chunk in read_chunks(source):            # any byte chunks
        progress = engine.push_chunk(chunk)
    engine.push_chunk(b"", final=True)

    for err in engine.iter_errors(batch_size=5_000):
        handle(err)
    normalized = engine.take_normalized()
    print(engine.rows_processed, engine.schema_columns())
```

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
