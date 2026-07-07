# Native Clients Hub

ImportValidator ships a browser WebAssembly SDK **and** a native shared
library for server-side use from any language with C FFI. Per-language
integration guides (install, quick start, Excel, streaming, error decoding):

- **Node.js** → [guides/node.md](./guides/node.md) *(uses the WASM engine directly — no native library needed)*
- **Python** → [guides/python.md](./guides/python.md)
- **C# / .NET** → [guides/csharp.md](./guides/csharp.md)
- **Go** → [guides/go.md](./guides/go.md)
- **Rust** → [guides/rust.md](./guides/rust.md) *(crate dependency — no FFI)*
- Any other C-FFI language → `bindings/include/import_validator.h` (fully documented header)

All surfaces run the same engine: identical schema contract
([SCHEMA_REFERENCE.md](./SCHEMA_REFERENCE.md)), error codes, modifiers,
normalization, and Excel semantics.

## Get the native library (Python / C# / Go / C)

### Option A — Prebuilt binaries (no Rust required)

Every tagged release (and any manual run of the *Release Native Libraries*
workflow) produces prebuilt libraries — each in a default and a `-pattern`
(regex-enabled) variant — plus the C header. Download from the GitHub
Release assets:

| Platform | Asset |
|---|---|
| Linux x86_64 | `import-validator-linux-x86_64.so` |
| macOS arm64 | `import-validator-macos-arm64.dylib` |
| Windows x86_64 | `import-validator-windows-x86_64.dll` |

### Option B — Build from source

Prerequisite: Rust toolchain (`curl https://sh.rustup.rs | sh`).

```bash
./scripts/build-native.sh                      # from the repository root
./scripts/build-native.sh --features pattern   # with regex support
```

Output (note: since 0.2.0 the `_wasm` suffix is gone):

| Platform | File |
|---|---|
| macOS | `crates/validator/target/release/libimport_validator.dylib` |
| Linux | `crates/validator/target/release/libimport_validator.so` |
| Windows | `crates/validator/target/release/import_validator.dll` |

## Contract notes (all bindings)

- **Thread-safety**: an engine handle is NOT thread-safe. One engine per
  concurrent validation; separate engines on separate threads are fine.
- **One stream per engine**: CSV (`push_chunk`) xor XLSX (one-shot
  `validate_xlsx_bytes`, or shared-strings + sheet pushes). Create a new
  engine per file.
- **Packed errors**: 2×u32 per error `[row, (kind<<31)|(col<<8)|code]`; all
  shipped bindings decode this for you, including column names and human
  messages identical to the Node/browser SDK.
- **Versioning**: `iv_version()` returns the engine version; bindings expose
  it (`engine_version()` / `Engine.Version()` / `EngineVersion()`). Binding
  and library versions should match (both 0.2.0).
- **Validation error codes**: canonical table in
  [SCHEMA_REFERENCE.md](./SCHEMA_REFERENCE.md) — the bindings' `code_name`
  strings match it exactly.

## Server examples

Runnable servers with CSV + XLSX endpoints, each with its own README:
`examples/node_server` · `examples/python_server` · `examples/csharp_server`
· `examples/go_server`. Rust: `crates/validator/examples/`.

## Distribution checklist (per customer)

1. Native library for their platform(s) (+ `-pattern` variant only if their
   schemas use regex).
2. `bindings/include/import_validator.h` + the binding file(s) for their
   language(s) with the packaging manifests
   (`pyproject.toml` / `ImportValidator.csproj` / `go.mod`).
3. Docs: [INDEX.md](./INDEX.md), their language guide,
   [SCHEMA_REFERENCE.md](./SCHEMA_REFERENCE.md),
   [PERFORMANCE.md](./PERFORMANCE.md),
   [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
4. Their validated schema JSON (checked against
   `validation-config.schema.json`).
