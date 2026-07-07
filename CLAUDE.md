# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A high-performance CSV + Excel (.xlsx) validation engine. One Rust core
(`crates/validator`) ships three ways: WebAssembly (browser worker + Node
package), a native C ABI (Python/C#/Go bindings), and a public Rust API.
Identical validation semantics on every surface.

Orientation docs (read these before large changes):
- `docs/ARCHITECTURE.md` — components, data flow, design decisions, invariants
- `docs/CODE_MAP.md` — every file's purpose + cross-cutting change recipes
- `docs/PERFORMANCE.md` — hot-path design, tuning, memory model
- `docs/INDEX.md` — all documentation

## Build Commands

```bash
# Prerequisites: Node.js 20+, pnpm 10+, Rust toolchain, wasm-pack

pnpm install                        # install all workspace deps

# Full production build (WASM → core → worker → node → sdk → demo; ORDER MATTERS)
pnpm run build

# Individual steps
pnpm --filter @import-validator/core run build:wasm        # fast WASM tier (default)
WASM_FEATURES=pattern pnpm --filter @import-validator/core run build:wasm  # full tier (regex)
IV_WASM_SIMD=1 pnpm --filter @import-validator/core run build:wasm         # opt-in SIMD build
pnpm --filter @import-validator/core run build:pkg         # compile core TS + copy WASM
pnpm --filter @import-validator/worker run build           # tsc + esbuild bundle (self-contained dist/worker.js)
pnpm --filter @import-validator/node run build
pnpm --filter @import-validator/sdk run build

# Merge gate: build + typecheck
pnpm run verify

# Tests
pnpm run test                                              # worker + node + sdk suites
node --test packages/worker/test/xlsx-validate.test.mjs    # single file (after build)
cd crates/validator && cargo test                          # Rust (also: --features pattern)
cargo fmt --check && cargo clippy --all-targets -- -D warnings   # CI-enforced lints

# Native shared library (Python / C# / Go)
./scripts/build-native.sh                    # → libimport_validator.{dylib,so} / import_validator.dll
./scripts/build-native.sh --features pattern

pnpm run dev:ex          # Vite demo
pnpm run bench           # rewrites docs/BENCHMARKS.md (CSV + XLSX + estimate scenarios)
node scripts/bench.mjs --quick   # smoke benchmark
pnpm run dist:customer   # customer kit (artifacts/import-validator-kit-v<version>.zip)
```

## Architecture (condensed — full version in docs/ARCHITECTURE.md)

```
Browser App → @import-validator/sdk (ValidatorClient, protocol v2, cancel())
  → Web Worker (@import-validator/worker)
      ├─ CSV:  chunked reads (read-ahead) → engine.push_chunk
      └─ XLSX: TS ZIP reader (opened ONCE per request) → DecompressionStream
               → engine.push_shared_strings_chunk / push_sheet_chunk
Node → @import-validator/node: CSV validateFile/Buffer/Stream + Excel validateXlsxFile/Buffer/Stream
Python/C#/Go → C ABI (ffi.rs): streaming CSV + one-shot iv_engine_validate_xlsx_bytes
Rust → import_validator::Validator
```

Key mechanics:
- **Errors are packed u32 pairs** `[row, (kind<<31)|(col<<8)|code]` in the
  engine; the worker posts them as transferable buffers (protocol v2) and the
  SDK decodes to `DecodedError[]`. Message wording lives ONLY in
  `packages/core/src/engine.ts::decodePackedErrors` (JS) and the bindings'
  equivalent tables.
- **XLSX is parsed in Rust** (`crates/validator/src/xlsx/`): streaming
  scanner, chunk-boundary safe, no CSV round-trip. Hosts do inflate (browser
  DecompressionStream, node:zlib, native miniz_oxide).
- **Estimates**: WASM RowCounter (CSV, exact, quote-aware) and
  XlsxRowCounter / `<dimension>` early-stop (XLSX).
- **Engine instances validate ONE stream** (CSV xor XLSX), are not
  thread-safe, and are created per file.

## Validation Schema Contract

Schema JSON goes directly to the Rust engine. Full shape:
`docs/validation-config.schema.json`; human reference:
`docs/SCHEMA_REFERENCE.md`. Key fields: `hasHeaders` (required), `delimiter`,
`caseInsensitiveHeaders`, `columns[]` (`name`, `type`
(`string|int|decimal|float|double|number|email|date`), `required`,
`nullable`, `unique`, `allowed[]`, `minLen`, `maxLen`, `precision`,
`strictPrecision`, `dateFormat`, `pattern`, `modifiers`), `uniqueGroups[]`,
`failOnExtraColumns`, `totalColumns`. Modifiers run before type checks:
trim (default true), collapseWhitespace, case transforms, prefix/suffix,
numeric rounding/decimalScale, substring, replace, regexReplace (full tier),
nullValues.

## Fatal Error Codes

Via `onFatal(message, fatal)`: `SCHEMA_VERSION_UNSUPPORTED`,
`WASM_URL_REQUIRED`, `ENGINE_NOT_INITIALIZED`, `FILE_TOO_LARGE`,
`ROWS_LIMIT_EXCEEDED`, `COLUMNS_LIMIT_EXCEEDED`, `TIMEOUT`, `CANCELLED`,
`WASM_RUNTIME`, `EXCEL_ROUTE_DISABLED`, `VALIDATION_FAILED`. Canonical table:
`docs/SDK_API.md`.

## Important Invariants

- **Build order matters**: WASM before core; core before worker/node; worker before SDK.
- **`dist/worker.js` is self-contained** (kit build fails on bare `@import-validator/*` imports). Library consumers import `@import-validator/worker` (index), never the bundle.
- **`.js` extensions on relative imports** in `packages/*/src` (Node ESM consumes dist directly).
- **schemaVersion 1 only**; `WORKER_PROTOCOL_VERSION` is 2 (old SDKs get v1 decoded errors automatically).
- **Contract surfaces are additive-only**: wasm-bindgen JS names (`wasm_api.rs` ↔ `core/src/engine.ts`), C ABI (`ffi.rs` ↔ `bindings/include/import_validator.h`), packed error layout (5 decoders: TS/Python/C#/Go/Rust).
- **Pattern feature**: schemas with `pattern`/`regexReplacePattern` fail engine init on the fast tier — use the full build.
- **XLSX guardrails** (identical constants in `core/src/xlsx/zip.ts` AND `crates/…/xlsx/zip.rs`): ≤20,000 ZIP entries, sheet XML ≤192 MB, shared strings ≤128 MB, total ≤768 MB, ratio ≤1000×, no ZIP64, `.xls` rejected.
- **`wasmUrl` must be provided** by the SDK client (else `WASM_URL_REQUIRED`).
- Cross-cutting changes (new error code, schema field, engine method): follow the recipes at the bottom of `docs/CODE_MAP.md`.

## Runtime Profiles

`profile: "fast" | "balanced" | "strict"` in `ValidatorOptions` / per
`validate()` call (`packages/sdk/src/defaults.ts`) — controls
`maxPostErrorsTotal`, `postErrorBatch`, and default `estimate`.

## Docs Reference

Everything is indexed in `docs/INDEX.md`. Per-language integration guides:
`docs/guides/{typescript-browser,node,python,csharp,go,rust}.md`.
Benchmarks are machine-written (`pnpm run bench`) — never hand-edit
`docs/BENCHMARKS.md`.
