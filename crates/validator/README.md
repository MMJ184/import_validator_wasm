# import-validator (Rust core)

High-performance streaming CSV/XLSX validation engine. One core, three
adapters:

- **Rust API** (`import_validator::Validator`) — use the crate directly as a
  dependency.
- **WASM** (`wasm_api`, built with wasm-pack) — powers the browser worker and
  the Node.js package.
- **C ABI** (`ffi`, built as a cdylib) — powers the Python, C#, and Go
  bindings.

## Quick start (Rust)

```rust
use import_validator::{Validator, ValidatorOptions};

let schema = r#"{"hasHeaders":true,"columns":[
    {"name":"id","type":"int","required":true,"unique":true},
    {"name":"email","type":"email","required":true}
]}"#;

let mut v = Validator::new(schema, ValidatorOptions::default())?;
v.push_chunk(b"id,email\n1,a@example.com\n")?;
let summary = v.finish()?;
for err in v.take_errors(1_000) {
    eprintln!("{err}");
}
# Ok::<(), String>(())
```

XLSX: either stream decompressed worksheet XML through
`push_shared_strings_chunk` / `push_sheet_chunk`, or hand the engine a whole
`.xlsx` buffer with `validate_xlsx_bytes` (native targets).

Runnable examples live in `examples/` (`validate_csv.rs`, `validate_xlsx.rs`):

```bash
cargo run --release --example validate_csv -- data.csv schema.json
```

## Build matrix

```bash
cargo test                        # native unit + integration tests
cargo test --features pattern    # with the regex engine
../../scripts/build-native.sh    # native cdylib for Python/C#/Go
# WASM is built via packages/core (wasm-pack); see the repo root README.
```

The schema contract is documented in `docs/SCHEMA_REFERENCE.md` and
`docs/validation-config.schema.json` at the repo root; architecture and
performance notes live in `docs/ARCHITECTURE.md` and `docs/PERFORMANCE.md`.
