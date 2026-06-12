# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A high-performance browser-side CSV/Excel validation engine. The core validator is written in Rust and compiled to WebAssembly; a TypeScript worker pipeline streams files in chunks to the WASM engine; a browser SDK wraps the worker behind an event-driven API.

## Build Commands

```bash
# Prerequisites: Node.js 20+, pnpm 10+, Rust toolchain, wasm-pack

pnpm install                        # install all workspace deps

# Full production build (WASM → core → worker → node → sdk → demo)
pnpm run build

# Individual steps (must run in this order)
pnpm --filter @import-validator/core run build:wasm        # fast WASM (default)
pnpm --filter @import-validator/core run build:wasm:full   # full WASM (enables pattern/regex features)
pnpm --filter @import-validator/core run build:pkg         # compile core TS + copy WASM
pnpm --filter @import-validator/worker run build           # tsc + esbuild bundle (self-contained dist/worker.js)
pnpm --filter @import-validator/node run build
pnpm --filter @import-validator/sdk run build
pnpm --filter vite-ts-demo run build

# Build + type check gate (run before merging; build first — typecheck
# needs the generated wasm pkg and package dists)
pnpm run verify

# Tests (builds worker first, then runs Node test runner)
pnpm run test
pnpm --filter @import-validator/worker run test

# Run a single test file
node --test packages/worker/test/error-taxonomy.test.mjs   # after worker is built

# Native shared library (Python / C# / Go / etc.)
./scripts/build-native.sh                    # builds .dylib / .so / .dll for the host
./scripts/build-native.sh --features pattern # with regex support
cargo test                                   # Rust unit tests (native, no WASM)

# Dev server (Vite demo)
pnpm run dev:ex

# Build with per-step timing logs (for release/regression)
pnpm run build:trace

# Assemble customer distribution kit (tarballs + static worker/wasm + zip)
pnpm run dist:customer         # requires prior build → artifacts/import-validator-kit-v<version>.zip
pnpm run dist:customer:full    # rebuild + assemble
```

Rust tests (no WASM, just native):
```bash
cd crates/validator && cargo test
```

## Architecture

### Data Flow

```
Browser App
  └── @import-validator/sdk  (ValidatorClient)
        └── Web Worker  (@import-validator/worker/worker.ts)
              ├── WASM init  (@import-validator/core  →  crates/validator)
              ├── CSV path:  estimateCsv → runCsv → Engine.pushChunk (streaming)
              └── XLSX path: estimateXlsx → runXlsx (XML→CSV chunks) → Engine.pushChunk
```

### Package Responsibilities

| Package | Role |
|---|---|
| `crates/validator` | Rust WASM: CSV parser (csv-core), field validation, normalization, error packing |
| `packages/core` | WASM init/retry logic, `Engine` TS wrapper, `chooseChunkSizeSmart` |
| `packages/worker` | Worker protocol, CSV/XLSX pipelines, preflight guardrails, fatal taxonomy |
| `packages/sdk` | `createValidator()` browser API, profile defaults, worker factory |
| `packages/node` | Node.js server wrapper — runs WASM directly, no Web Worker |
| `examples/vite-ts-demo` | Integration demo using SDK + Vite URL helpers |
| `bindings/python` | Python `ctypes` wrapper for the native library |
| `bindings/csharp` | C# P/Invoke wrapper for the native library |
| `bindings/go` | Go `cgo` wrapper for the native library |
| `bindings/include` | C header (`import_validator.h`) for any C-FFI language |

### Key Design Points

**Two build tiers**: The default WASM build omits the regex engine for smaller binary and max throughput. The `pattern` feature adds regex support (enable with `WASM_FEATURES=pattern`). A schema using `pattern` or `regexReplacePattern` on the fast build will throw at engine init.

**Worker message protocol** (`packages/worker/src/protocol.ts`): Requests are `init | validate | estimate`. Responses are `ready | estimate | metrics | progress | errors | normalized | done | fatal`. All requests are serialized through a single promise queue (`operationQueue` in `worker.ts`) — concurrent validate calls queue, not race.

**Error packing**: The Rust engine stores errors as packed `u32` pairs: `[row, (kind<<31)|(col<<8)|code]`. TypeScript unpacks these in `Engine.takeErrors()` (raw) or `Engine.takeErrorsDecoded()` (with column names and human messages). Always drain errors in batches — unbounded accumulation fills `VecDeque<PackedError>` up to `max_errors`.

**Chunk size selection**: `chooseChunkSizeSmart(fileSizeBytes)` in core scales chunk size from 128 KB (small files) to 4 MB (large), capped by `navigator.deviceMemory`. Estimate pass is further capped to 512 KB.

**XLSX path**: Parsed entirely in TypeScript — no Rust XML parser. The worksheet XML is loaded as a string, then rows are iterated with regex and converted to CSV chunks fed to the same `runCsvChunks` pipeline. `estimateXlsx` tries the `<dimension ref="...">` attribute first (fast); falls back to full row iteration.

**WASM init retry**: `packages/core/src/wasm/index.ts` retries with cache-busting on `WebAssembly.instantiate()` import mismatch errors (stale worker/browser cache), then falls back to the adjacent WASM file for monorepo duplicate-package scenarios.

### Validation Schema Contract

Schema JSON is passed directly to the Rust engine. The full schema shape is in `docs/validation-config.schema.json`. Key fields:

- `hasHeaders` (bool, required)
- `delimiter` (char or byte, default `,`)
- `columns[]` — each with `name`, `type` (`string|int|decimal|float|double|number|email|date`), `required`, `nullable`, `unique`, `allowed[]`, `minLen`, `maxLen`, `precision`, `strictPrecision`, `dateFormat`, `pattern`, `modifiers`
- `uniqueGroups[]` — composite uniqueness across multiple columns
- `failOnExtraColumns`, `totalColumns`

`modifiers` on a column runs before type-checking: `trim` (default true), `collapseWhitespace`, `lowercase/uppercase/titleCase`, `prefix/suffix`, `ceil/floor/round/decimalScale`, `substringStart/substringEnd`, `replaceFrom/replaceTo`, `regexReplacePattern/regexReplaceWith`, `nullValues/nullValuesCaseInsensitive`.

### Fatal Error Codes

All fatal errors propagate via `onFatal(message, fatal)` where `fatal.code` is one of: `SCHEMA_VERSION_UNSUPPORTED`, `WASM_URL_REQUIRED`, `ENGINE_NOT_INITIALIZED`, `FILE_TOO_LARGE`, `ROWS_LIMIT_EXCEEDED`, `COLUMNS_LIMIT_EXCEEDED`, `TIMEOUT`, `WASM_RUNTIME`, `EXCEL_ROUTE_DISABLED`, `VALIDATION_FAILED`.

### Runtime Profiles

`profile: "fast" | "balanced" | "strict"` in `ValidatorOptions` / per `validate()` call. Defined in `packages/sdk/src/defaults.ts`. Controls `maxPostErrorsTotal`, `postErrorBatch`, and whether `estimate` is on by default.

## Important Invariants

- **Build order matters**: WASM must build before core; core before worker/node; worker before SDK.
- **`dist/worker.js` is a self-contained esbuild bundle** (no bare specifiers) so it can be hosted statically. The kit build fails if bare `@import-validator/*` imports are found in it. Library consumers import `@import-validator/worker` (index), never the bundle.
- **Relative imports in `packages/*/src` must carry `.js` extensions** — the compiled dist is consumed directly by Node (node package, tests); extensionless specifiers break Node ESM resolution.
- **schemaVersion**: Currently only `1` is supported. The worker rejects others immediately.
- **Pattern feature**: Schemas with `pattern` or `regexReplacePattern` fields fail at `Engine.create()` on the fast build. Switch to the full build with `WASM_FEATURES=pattern`.
- **XLSX limits**: Sheet XML ≤ 192 MB uncompressed; shared strings ≤ 128 MB; total decompressed ≤ 768 MB; max 20,000 ZIP entries; max compression ratio 1,000×. ZIP64 is not supported.
- **`.xls` is rejected**: Only `.xlsx` is supported in the Excel path.
- **`wasmUrl` must be provided**: The SDK client passes it to the worker in the `init` message. Omitting it causes `WASM_URL_REQUIRED` fatal.

## Docs Reference

- `docs/NATIVE_CLIENTS.md` — integration guide for Python, Node.js, C#, Go
- `docs/CURRENT_FLOW.md` — authoritative runtime + build flow description
- `docs/PRODUCT_READINESS.md` — multi-tenant policy and production guidance
- `docs/CUSTOMER_DISTRIBUTION.md` — customer handoff and integration guide
- `docs/ENGINEERING_STANDARDS.md` — CI/release standards
- `docs/validation-config.schema.json` — schema contract JSON Schema
- `docs/customer-profiles.json` — example tenant profiles
- `docs/MODIFIER_TASKS.md` — modifier feature roadmap (Phase 4 next)
