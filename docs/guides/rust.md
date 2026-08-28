# Rust Integration Guide

Use the engine directly as a Rust dependency — no WASM, no FFI, typed errors.

## Add the dependency

```toml
[dependencies]
import-validator = { path = "path/to/crates/validator" }   # or a git dependency
# regex support (pattern / regexReplacePattern):
# import-validator = { path = "...", features = ["pattern"] }
```

## Quick start — CSV

```rust
use import_validator::{Validator, ValidatorOptions};

let schema = r#"{
    "hasHeaders": true,
    "columns": [
        { "name": "id", "type": "int", "required": true, "unique": true },
        { "name": "email", "type": "email", "required": true,
          "modifiers": { "trim": true, "lowercase": true } }
    ]
}"#;

let mut v = Validator::new(schema, ValidatorOptions::default())
    .map_err(|e| anyhow::anyhow!(e))?;

// stream chunks of any size — records may split anywhere
for chunk in read_chunks(&mut file)? {
    v.push_chunk(&chunk).map_err(|e| anyhow::anyhow!(e))?;
}
let summary = v.finish().map_err(|e| anyhow::anyhow!(e))?;

// errors_count() is the live queue length; errors_suppressed() counts what did
// not fit. `max_errors` caps recording only — every row is always validated —
// so both must be zero for the file to be clean.
let valid = v.errors_count() == 0 && v.errors_suppressed() == 0;
println!("rows: {}, valid: {valid}", summary.rows_processed);
for err in v.take_errors(10_000) {
    // err.row, err.column_index, err.column_kind, err.column_name,
    // err.code, err.code_name — Display prints a readable line
    eprintln!("{err}");
}
```

`ValidatorOptions { max_errors, emit_normalized }`; normalized CSV bytes
drain via `v.take_normalized()`.

## Excel (.xlsx)

One-shot (the engine parses ZIP + DEFLATE internally):

```rust
let bytes = std::fs::read("data.xlsx")?;
let summary = v.validate_xlsx_bytes(&bytes).map_err(|e| anyhow::anyhow!(e))?;
```

Streaming (you provide decompressed worksheet XML — e.g. from your own ZIP
handling): push `xl/sharedStrings.xml` chunks via
`push_shared_strings_chunk(chunk, final)` to completion first, then the
worksheet via `push_sheet_chunk(chunk, final)`.

## Runnable examples

```bash
cd crates/validator
cargo run --release --example validate_csv  -- data.csv  [schema.json]
cargo run --release --example validate_xlsx -- data.xlsx [schema.json]
```

## Notes

- One `Validator` instance handles exactly one input stream (CSV xor XLSX);
  create one per file. Not `Sync` — one validator per concurrent job.
- Errors from constructors/pushes are `String` messages (schema problems,
  malformed containers); per-row validation issues come out of
  `take_errors`, they never abort the run.
- The full schema contract: [../SCHEMA_REFERENCE.md](../SCHEMA_REFERENCE.md);
  engine internals: [../ARCHITECTURE.md](../ARCHITECTURE.md); performance:
  [../PERFORMANCE.md](../PERFORMANCE.md).
