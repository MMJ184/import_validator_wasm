# Current Runtime And Build Flow

This document reflects the implemented flow in this repository as of March 16, 2026.

## 1) Package Responsibilities
- `crates/validator`: Rust validation engine compiled to WebAssembly.
- `packages/core`: WASM init, `Engine` wrapper, error decoding, chunk-size helpers.
- `packages/worker`: worker protocol, CSV/XLSX pipelines, preflight guardrails, fatal taxonomy.
- `packages/sdk`: browser client API (`createValidator`) and worker wiring.
- `examples/vite-ts-demo`: browser integration example using SDK + worker + WASM URLs.

## 2) Build Flow
- Root build command:
  - `pnpm run build`
  - Runs, in order: `build:wasm`, core package build, worker build, SDK build, demo build.
- WASM build:
  - `packages/core/scripts/build-wasm.mjs` runs `wasm-pack build` against `crates/validator`.
  - Default is fast build; full pattern-enabled build uses `WASM_FEATURES=pattern`.
- Core package build:
  - TypeScript compile + `copy-wasm.mjs` to place WASM artifacts in `packages/core/dist/wasm`.
- Traced build:
  - `pnpm run build:trace` writes step logs and summaries under `artifacts/build-traces/<timestamp>/`.
- Customer kit:
  - `pnpm run dist:customer` copies built package outputs and docs into `artifacts/customer-kit/`.

## 3) Browser Runtime Flow (SDK + Worker)
1. App creates client with `createValidator(options, events)`.
2. SDK creates Worker from either:
   - `workerFactory`, or
   - `workerUrl` (module worker).
3. SDK sends `init` message with:
   - `schema`, `schemaVersion` (default `1`), `wasmUrl`, `maxErrors`, `emitNormalized`.
4. Worker validates init inputs:
   - rejects unsupported `schemaVersion`,
   - rejects missing `wasmUrl`,
   - warms engine and posts `ready` with schema columns.
5. App calls `validate(file, options)`:
   - if worker not ready yet, SDK queues this call.
6. SDK computes runtime defaults, then posts `validate`:
   - format route (`auto` => extension based),
   - chunk sizes,
   - estimate flags,
   - guardrails (`maxFileBytes`, `maxRowsEstimate`, `maxColumns`, `timeoutMs`),
   - progress/error posting controls.

## 4) Worker Validate Orchestration
- Requests are serialized with an internal promise queue (`operationQueue`).
- `maxFileBytes` is enforced before any heavy work.
- `timeoutMs` is enforced with `AbortController`.
- Route selection:
  - `format: "csv"` -> CSV estimate/validate path.
  - `format: "excel"` -> XLSX estimate/validate path.

## 5) CSV Path
1. Decide whether estimate preflight is required:
   - required for `estimate`, `estimateOnly`, or row/column guardrails.
2. Estimate pass (`estimateCsv`):
   - streamed parsing with quote-aware row/column counting,
   - uses schema delimiter and `hasHeaders`.
3. Apply estimate guardrails:
   - throw on row/column limit exceed.
4. If `estimateOnly=true`, emit `done` and stop.
5. Validation pass (`runCsv`):
   - stream file chunks,
   - `engine.pushChunk(...)`,
   - coalesced `progress` events,
   - decoded `errors` in batches with total cap and optional row cap,
   - optional normalized chunk posts,
   - final flush and `done`.

## 6) Excel Path
1. Extension check:
   - `.xlsx` supported,
   - `.xls` rejected with explicit message.
2. Estimate pass (`estimateXlsx`) when needed:
   - first tries worksheet `<dimension>` for fast estimate,
   - falls back to row iteration if needed.
3. XLSX safety checks are enforced:
   - ZIP entry count,
   - entry size limits,
   - total decompressed size limit,
   - compression ratio checks,
   - UTF-8 validity for XML payloads.
4. If `estimateOnly=true`, emit `done` and stop.
5. Validation pass (`runXlsx`):
   - parses worksheet XML rows,
   - converts rows to CSV chunks,
   - reuses the same CSV chunk validation engine path.

## 7) Events Emitted To Client
- `ready`
- `estimate`
- `metrics`
- `progress`
- `errors`
- `normalized`
- `done`
- `fatal`

`fatal` payloads include structured context: `code`, `phase`, `retryable`, `format`, `fileName`, `fileSizeBytes`, and optional `details`.

## 8) Fatal Codes In Use
- `SCHEMA_VERSION_UNSUPPORTED`
- `WASM_URL_REQUIRED`
- `ENGINE_NOT_INITIALIZED`
- `FILE_TOO_LARGE`
- `ROWS_LIMIT_EXCEEDED`
- `COLUMNS_LIMIT_EXCEEDED`
- `TIMEOUT`
- `WASM_RUNTIME`
- `EXCEL_ROUTE_DISABLED`
- `VALIDATION_FAILED`

## 9) Default Behavior Highlights
- `chooseMaxErrorsSmart(file.size)` scales default max errors by file size.
- `chooseEmitNormalizedSmart(file.size)` disables normalized output for large files.
- `chooseChunkSizeSmart(file.size)` chooses chunk size from `128 KB` to `4 MB` with device-memory caps.
- Estimate chunk size is capped to `512 KB` by default.
- Profile defaults:
  - `fast`: no estimate by default, lower post limits.
  - `balanced`: moderate post limits, no estimate by default.
  - `strict`: estimate enabled by default, tighter post batch size.

## 10) Main Files For Flow Changes
- SDK client/runtime defaults:
  - `packages/sdk/src/client.ts`
  - `packages/sdk/src/defaults.ts`
- Worker orchestration and fatal mapping:
  - `packages/worker/src/worker.ts`
  - `packages/worker/src/errorTaxonomy.ts`
  - `packages/worker/src/flow.ts`
- CSV and XLSX pipelines:
  - `packages/worker/src/pipeline/csvPipeline.ts`
  - `packages/worker/src/pipeline/estimateCsv.ts`
  - `packages/worker/src/pipeline/xlsxPipeline.ts`
- Core WASM bridge:
  - `packages/core/src/engine.ts`
  - `packages/core/src/wasm/index.ts`
  - `crates/validator/src/lib.rs`
