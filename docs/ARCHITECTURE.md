# Architecture

Authoritative description of how ImportValidator works: components, data
flow, design decisions, and the build pipeline. For a file-by-file index see
[CODE_MAP.md](./CODE_MAP.md); for performance internals see
[PERFORMANCE.md](./PERFORMANCE.md).

## 1. What this product is

A high-performance validation engine for CSV and Excel (.xlsx) imports. One
Rust core compiles to three delivery surfaces:

| Surface | Built as | Consumed by |
|---|---|---|
| WebAssembly | `wasm-pack` (wasm32) | Browser Web Worker (SDK), Node.js package |
| Native C ABI | `cargo build` cdylib | Python (ctypes), C# (P/Invoke), Go (cgo), any C-FFI language |
| Rust crate | rlib (`import_validator::Validator`) | Rust applications |

Every surface runs the **same validation core** — identical error codes,
normalization output, modifier pipeline, and XLSX semantics everywhere.

## 2. High-level data flow

```
Browser App
  └── @import-validator/sdk   ValidatorClient (events, profiles, cancel)
        └── Web Worker        @import-validator/worker  (protocol v2)
              ├── WASM init   @import-validator/core → crates/validator
              ├── CSV:   File → chunked reads (read-ahead) → engine.push_chunk
              ├── XLSX:  File → ZIP directory (TS) → DecompressionStream
              │          → engine.push_shared_strings_chunk / push_sheet_chunk
              └── drains: packed errors (transferable) · normalized chunks · progress

Node Server
  └── @import-validator/node  validateFile/Buffer/Stream (CSV)
                              validateXlsxFile/Buffer/Stream (Excel)
        └── same WASM engine, ZIP via shared core reader + node:zlib

Python / C# / Go
  └── bindings/* over the C ABI (ffi.rs)
        ├── CSV: iv_engine_push_chunk (streaming)
        └── XLSX: iv_engine_validate_xlsx_bytes (one-shot; ZIP+DEFLATE in Rust)

Rust App
  └── import_validator::Validator (push_chunk / validate_xlsx_bytes / …)
```

## 3. The Rust core (`crates/validator`)

One engine struct, `engine::ValidatorCore`, with three thin adapters that
contain **no validation logic**:

- `wasm_api.rs` (wasm32 only) — `#[wasm_bindgen]` classes `ValidatorEngine`,
  `RowCounter`, `XlsxRowCounter`. Method names are a compatibility contract
  with `packages/core/src/engine.ts`.
- `ffi.rs` (native only) — `iv_*` C ABI. Signatures are mirrored in
  `bindings/include/import_validator.h`.
- `api.rs` — public Rust API (`Validator`, typed `ValidationError` with
  resolved column names).

### 3.1 CSV path

`csv-core` (streaming, quote-aware) parses bytes into records. Parser state
survives chunk boundaries: a record that straddles two `push_chunk` calls
resumes mid-record via the `partial_out`/`partial_ends` offsets — this is
load-bearing (see the chunk-boundary fuzz test).

Per record, `handle_record`:
1. Header row (when `hasHeaders`) → header→schema column mapping (exact or
   case-insensitive), missing-required-column errors.
2. Data row → per-field `validate_field`:
   - modifiers (`prepare_field_value`, zero-alloc for identity columns),
   - length/allow-list/pattern gates,
   - type validation + canonicalization (borrow when already canonical),
   - uniqueness fingerprint insert.
3. Composite unique groups (row-level key across columns).
4. Normalized CSV emission (only when enabled).

Design decisions that matter:

- **Errors are packed, not objects**: each error is 2×u32
  `[row, (kind<<31)|(col<<8)|code]`, queued in a `VecDeque` bounded by
  `max_errors`. Hosts drain in batches; decoding to names/messages happens at
  the outermost layer (SDK / bindings / Rust API) from the packed words plus
  the column tables.
- **Uniqueness stores fingerprints, not values**: single-pass xxh3-128 per
  canonical value in an identity-hash set — ~24 bytes per distinct value
  regardless of value length. A collision could only cause a spurious
  duplicate error (never a missed validation) at ~1e-19 odds for 10M values.
- **Canonical values are kept only when consumed** (normalized output or
  uniqueGroups membership); a validate-only schema allocates nothing per
  field for plain columns.

### 3.2 XLSX path

Worksheet XML is scanned by a streaming state machine
(`xlsx/scanner.rs`) that is chunk-boundary safe at every byte position
(tags, entities, CDATA can split anywhere). Completed rows feed
`handle_record` directly — **no CSV round-trip**. Shared strings are parsed
first (`xlsx/shared.rs`) into one concatenated buffer + offsets.

Who inflates depends on the host (deliberate split):

| Host | ZIP directory | DEFLATE |
|---|---|---|
| Browser worker | TS reader (`core/src/xlsx/zip.ts`) | `DecompressionStream` (native) |
| Node | same TS reader | `node:zlib` |
| Native FFI / Rust | Rust reader (`xlsx/zip.rs`) | `miniz_oxide` |

The WASM binary never carries a DEFLATE implementation (browsers have a
faster native one); native callers get a self-contained one-shot.

Semantics (parity-locked to the retired TS pipeline, with two documented
improvements):
- rows emit per `<row>` element; omitted (sparse) rows are skipped — error
  row numbers count data rows, not Excel row numbers;
- cells keyed by their `r` ref (gaps → empty fields); positional fallback;
- cell types: `s` shared string, `b` → TRUE/FALSE, `inlineStr` → `<is><t>`
  runs, everything else → `<v>` text with entities decoded;
- a row with no cells becomes one empty field (what its CSV round-trip
  used to produce);
- *improvements*: refs beyond Excel's XFD/16384-column limit error instead
  of exhausting memory; phonetic `<rPh>` runs are excluded from shared
  strings.
- number formats are NOT applied: cells hold raw stored values (dates in
  Excel's serial format will not satisfy a `date` column unless stored as
  ISO text). This matches the previous behavior.

Guardrails (identical constants in TS and Rust): ≤20,000 ZIP entries, sheet
XML ≤192 MB, shared strings ≤128 MB, total decompressed ≤768 MB, compression
ratio ≤1000×, no ZIP64, `.xls` rejected.

### 3.3 Estimate engines

- `counter.rs` `RowCounterCore` — quote-aware CSV row counter (memchr
  scanning). Exact counts at ~4M rows/s; replaced a whole-file JS byte loop.
- `xlsx/scanner.rs` `SheetRowCounter` — `<row>` counter for sheets without a
  usable `<dimension>` element.

## 4. TypeScript packages

### `packages/core`
WASM loading (with cache-bust retry and monorepo-duplicate fallback),
`Engine` wrapper (JS-name contract with `wasm_api.rs`), packed-error decode
(`decodePackedErrors` — the ONE place error message wording lives on the JS
side), chunk-size heuristics, the environment-agnostic ZIP reader, and
`validateCsv` used by the Node package.

### `packages/worker`
The browser execution environment. Protocol (v2) in `protocol.ts`:
requests `init | validate | estimate | cancel`; responses
`ready | estimate | metrics | progress | errors | errorsPacked | normalized | done | fatal`.
All requests except `cancel` serialize through one promise queue; `cancel`
aborts the in-flight operation immediately.

Pipelines (`pipeline/`):
- `csvPipeline.ts` — the shared `runEngineStream` loop (drains, progress
  coalescing, packed-vs-decoded error posting, dry-run, abort) + chunked file
  streaming with one-chunk read-ahead + a per-chunk macrotask yield so
  `timeoutMs`/cancel stay live even when reads resolve from cache.
- `xlsxPipeline.ts` — opens the ZIP once per request (shared by estimate
  preflight + validation), dimension fast-path estimate that stops inflating
  once `<dimension>` is seen, streams entries into the engine.
- `estimateCsv.ts` — WASM RowCounter (JS fallback for pre-init estimates).

Protocol compatibility: the SDK sends `protocolVersion: 2` in `init`; a v1
client (no field) keeps receiving decoded `errors` messages, so an old SDK
works against a new worker. New SDK + old worker also works (it handles both
message kinds). Worker and SDK still ship together in the customer kit.

### `packages/sdk`
`createValidator()` → `ValidatorClient`: events, profile defaults
(fast/balanced/strict), option validation, format auto-detection by
extension, `cancel()`, and decoding of packed error batches into the public
`DecodedError[]` shape (unchanged public API).

### `packages/node`
Runs the WASM engine in-process. CSV: `validateFile/Buffer/Stream`. Excel:
`validateXlsxFile` (file-handle range streaming), `validateXlsxBuffer`,
`validateXlsxStream` (buffers — ZIP needs random access).

## 5. Fatal error taxonomy

Everything lethal funnels through `onFatal(message, fatal)` with
`fatal.code` ∈ `SCHEMA_VERSION_UNSUPPORTED · WASM_URL_REQUIRED ·
ENGINE_NOT_INITIALIZED · FILE_TOO_LARGE · ROWS_LIMIT_EXCEEDED ·
COLUMNS_LIMIT_EXCEEDED · TIMEOUT · CANCELLED · WASM_RUNTIME ·
EXCEL_ROUTE_DISABLED · VALIDATION_FAILED` plus phase/format/file context.
The canonical reference table lives in [SDK_API.md](./SDK_API.md);
per-row validation codes live in [SCHEMA_REFERENCE.md](./SCHEMA_REFERENCE.md).

## 6. Build pipeline

Order is load-bearing:

```
crates/validator ──wasm-pack──▶ packages/core/src/wasm/pkg   (build:wasm)
packages/core   ──tsc+copy───▶ packages/core/dist            (build:pkg)
packages/worker ──tsc+esbuild▶ dist/worker.js  (self-contained, no bare imports)
packages/node   ──tsc────────▶ dist
packages/sdk    ──tsc────────▶ dist
examples/vite-ts-demo ──vite─▶ dist
```

- Two WASM tiers: fast (default, no regex) and full
  (`WASM_FEATURES=pattern`). Schemas using `pattern`/`regexReplacePattern`
  fail engine init on the fast tier by design.
- Optional SIMD build: `IV_WASM_SIMD=1` (see PERFORMANCE.md for why the
  default stays baseline).
- Native: `./scripts/build-native.sh` → `libimport_validator.{dylib,so}` /
  `import_validator.dll`.
- Customer kit: `pnpm run dist:customer` → package tarballs + static
  `worker.js` + `.wasm` + docs, with a self-containment check on the worker
  bundle.

## 7. Invariants (do not break)

1. WASM builds before core; core before worker/node; worker before SDK.
2. `dist/worker.js` must contain no bare `@import-validator/*` specifiers.
3. Relative imports in `packages/*/src` carry `.js` extensions (Node ESM
   consumes the compiled dist directly).
4. `schemaVersion` 1 only; the worker rejects others.
5. The wasm-bindgen JS surface (`ValidatorEngine` method names) and the C ABI
   (`iv_*` signatures) are compatibility contracts — additive changes only.
6. Packed error layout `[row, (kind<<31)|(col<<8)|code]` is shared by Rust,
   TS, Python, C#, and Go decoders.
7. XLSX guardrail constants must stay identical in `core/src/xlsx/zip.ts`
   and `crates/validator/src/xlsx/zip.rs`.
8. An engine instance validates exactly one stream (CSV xor XLSX); hosts
   create one engine per file. Engines are not thread-safe; use one per
   concurrent job.
