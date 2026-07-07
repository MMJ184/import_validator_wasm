# Product Overhaul Design — Performance, Excel Everywhere, Bindings Parity, Documentation

Date: 2026-07-07
Status: Approved for implementation (single-pass delivery per standing instruction)
Scope owner: full repo

## 1. Goals (from product owner)

1. Top-notch end-to-end performance for **both CSV and Excel** paths.
2. First-class, compatible integrations in **TypeScript (browser), Node.js, Python, C#, Go, and Rust** — each with a runnable example.
3. Deep documentation: any developer (and any AI agent) can find what lives where; performance documented with numbers.
4. Folder/file restructuring allowed wherever it makes the product "proper".
5. An interactive Obsidian-style 3D graph map of the codebase.

Baseline (2026-07-07, Apple Silicon, Node 24, fast tier):
100k clean 751k rows/s · 74.9 MB/s; 1M clean 600k rows/s · 61.6 MB/s; WASM 256.7 KB (113.3 KB gzip). Excel path: unbenchmarked (known-slow TS regex pipeline).

## 2. Findings driving the design (condensed)

**Rust CSV hot path** (`crates/validator/src/lib.rs`, 1,683-line monolith):
- Two heap allocations per field: `prepare_field_value` builds a `String` even for identity modifiers, then `validate_field` `clone()`s it into `canonical`.
- Canonical values are stored per row even when nothing consumes them (no normalization, no uniqueness).
- Uniqueness: `fingerprint128` hashes every value **twice** with SipHash; `HashSet<u128>` then SipHashes the already-random fingerprint on every insert. 1M-row runs degrade ~20% vs 100k — hash overhead + rehash growth.
- Decimal/date validators re-serialize values that are already canonical ("12.34" → parse → round → rescale → `to_string`).
- No WASM SIMD: no `target-feature=+simd128`, so csv-core/memchr run scalar code.

**XLSX path** (`packages/worker/src/pipeline/xlsxPipeline.ts`):
- Materializes the whole worksheet XML as one JS string (up to 192 MB), regex-iterates rows/cells, then re-encodes rows as CSV text for the WASM engine to re-parse. Sheet XML is inflated + decoded **twice** per validate (estimate preflight, then run).
- Excel exists **only** in the browser worker. Node, Python, C#, Go, Rust have no Excel support.
- Timeout bug: row iteration yields only microtasks, so the `timeoutMs` abort timer can never fire mid-sheet.

**CSV estimate** (`estimateCsv.ts`): full-file byte-by-byte scan in JavaScript — can cost as much as validation itself on large files.

**Bindings**: C# binding does not compile (undefined `NativeLibraryThunk`); no packaging manifests (pyproject/csproj/go.mod); native bindings return only column indexes (no names/messages) while Node returns rich errors; Rust crate unusable as a dependency (`pub(crate)` constructor, `JsValue` in public API, no metadata, no example).

**Docs**: two customer docs ship snippets calling unexported helpers (`concatU8`/`concatChunks`); fatal-code lists disagree across 6 files; no ARCHITECTURE/CODE_MAP/PERFORMANCE/troubleshooting docs; NATIVE_CLIENTS.md orphaned from README; `customer-profiles.json` doesn't conform to its own schema; no Rust guide; BENCHMARKS covers CSV only.

**Tests/CI**: no clippy/fmt gate; bindings never compiled in CI; full/pattern tier never built; core/node packages untested; no XLSX or perf regression coverage.

## 3. Key architectural decision — Excel in the Rust core

### Options considered

**A. Optimize the TS pipeline in place** (index-based scanning, single read, streaming decode).
+ Least new surface. − Still string-materializes XML per chunk boundary handling in JS, still CSV round-trips into WASM, and Excel stays browser-only. Estimated ceiling ~2–4×.

**B. Move XLSX row extraction into the Rust core; hosts do inflate.** *(chosen)*
Browser/Node feed decompressed sheet-XML bytes into a streaming Rust scanner that feeds fields **directly** into the existing validation core — no giant string, no JS regex, no CSV re-encode/re-parse. Native FFI additionally gets a one-shot `validate_xlsx_bytes` where Rust itself parses the ZIP (miniz_oxide, target-gated so the WASM binary is unaffected).
+ Biggest speed/memory win; Excel becomes available to **all six languages**; single implementation to maintain.
− New parser surface (mitigated: parity semantics locked to the current TS pipeline, chunk-boundary fuzz tests, existing worker xlsx tests must pass unchanged).

**C. Full Rust including inflate in WASM** (miniz in the browser too).
− Bigger WASM, slower than the browser's native `DecompressionStream` (zlib), no benefit. Rejected.

### Chosen data flow

```
Browser:  File → TS ZIP reader → DecompressionStream (native inflate)
              → engine.push_shared_strings_chunk(bytes)*   [xl/sharedStrings.xml, if used]
              → engine.push_sheet_chunk(bytes, final)      [xl/worksheets/sheetN.xml]
              → same error/normalized/progress drain as CSV
Node:     fs ranges → zlib.inflateRaw → same two push APIs (shared TS ZIP reader moves to core)
Native:   iv_engine_validate_xlsx_bytes(whole .xlsx buffer) → Rust ZIP + miniz_oxide → same scanner
Rust lib: public XlsxSource helpers → same scanner
```

Scanner semantics = parity with today's TS pipeline: first worksheet by sheet number; cells keyed by `r` attribute (sparse cells fill empty); omitted rows skipped (documented); `t="s"` shared strings, `t="b"` → TRUE/FALSE, `t="inlineStr"` → `<is><t>` runs, everything else → `<v>` text with XML entities decoded; same ZIP guardrails (entry count, sizes, compression ratio, no ZIP64). Shared strings stored as one concatenated buffer + offsets (compact under the 128 MB cap).

## 4. CSV hot-path optimizations (semantics-preserving)

1. `prepare_field_value` returns `Cow<str>`; identity-modifier columns borrow from the record buffer (zero alloc). Type validators take `&str`.
2. `canonical` takes ownership by **move**, never clone; it is materialized **only** when a per-column precomputed `needs_value` flag says something consumes it (emit_normalized ∨ unique ∨ member of a uniqueGroup).
3. Uniqueness fingerprint: single-pass 128-bit hash (xxh3_128 via `xxhash-rust`) replacing double SipHash; `HashSet<u128>` gets an identity/fold hasher (the fingerprint is already uniform). Collisions remain vanishingly rare and non-adversarial (worst case: spurious duplicate error).
4. Decimal fast path: when the input is already canonical for the target precision (optional `-`, digits, single `.`, exact scale, no leading-zero anomalies) skip re-serialization and borrow. Same for `date` when input is already `YYYY-MM-DD`; date validate+normalize collapse into one parse.
5. Header maps and allowed-value sets move to a faster hasher (FxHash); allowed sets are cold to build, hot to probe.
6. Normalized CSV writer: quote-scan via memchr, segmented copies instead of per-byte pushes.
7. `lib.rs` splits into focused modules (`engine`, `record` (row handling), `typecheck`, `modifiers`, `fingerprint`, `xlsx/*`, `counter`, `wasm_api`, `ffi`, `schema`, `errors`) — no behavior change, all existing tests keep passing.

Explicitly out (YAGNI, documented in PERFORMANCE.md): hand-written SIMD CSV parser, WASM threads/SharedArrayBuffer, wasm64, .xls, ZIP64, multi-worker sharded validation.

## 5. Estimate redesign

- **CSV**: new Rust `RowCounter` (quote-aware, memchr-driven, streaming) replaces the JS byte loop — exact counts at near-parse speed. Same worker protocol.
- **XLSX**: `<dimension>` fast path now stream-inflates only until the dimension tag is found (few KB) instead of inflating the entire sheet; full fallback uses a Rust count-only scanner. Estimate and validate share one parsed ZIP directory + shared-strings load per request (no double inflate).

## 6. Worker / SDK / protocol changes

- New XLSX pipeline as per §3; CSV pipeline gains one-chunk read-ahead prefetch (overlap I/O with WASM compute).
- Timeout fix: pipelines yield a macrotask periodically so the abort timer can fire; abort checks remain cooperative.
- postMessage cost: normalized chunks and packed error batches transfer their `ArrayBuffer`s; the worker posts packed `Uint32Array` errors + column tables once, and the **SDK** decodes to the existing public `DecodedError[]` shape (public API unchanged). Worker and SDK version together (kit); breaking skew documented in CHANGELOG.
- New `cancel` protocol message + `ValidatorClient.cancel()`; fix the pending-validate overwrite bug (queue, not single slot).
- `EXCEL_ROUTE_DISABLED` remains for builds that disable Excel.

## 7. Node package

`validateXlsxFile` / `validateXlsxBuffer` / `validateXlsxStream`-equivalent using the shared core ZIP reader + `node:zlib` inflateRaw + the same push APIs. CSV API unchanged. Tests with real .xlsx fixtures (generated in-repo).

## 8. FFI + bindings (parity contract)

- C ABI adds: `iv_engine_push_shared_strings_chunk`, `iv_engine_push_sheet_chunk`, `iv_engine_validate_xlsx_bytes` (native ZIP one-shot, with err_buf), `iv_version()`. Header updated with thread-safety notes (engine = single-threaded object; one engine per concurrent validation).
- **C# fix**: remove `NativeLibraryThunk` dead path so the file compiles; keep the working `Lazy<NativeLib>` loader.
- Parity: every binding gains decoded errors with **column names + human messages** (join packed col index against schema/input columns — same strings as Node) and an XLSX validate call.
- Packaging: `pyproject.toml`, `ImportValidator.csproj` (netstandard2.1 class lib), `go.mod` (+ example `go.mod` with `replace`), `package.json` for the node example. License header + version constant in every binding.
- Crate/lib rename: package `import-validator`, `[lib] name = "import_validator"` → native artifacts become `libimport_validator.{dylib,so}` / `import_validator.dll`. wasm-pack keeps `--out-name import_validator_wasm`, so the TS/WASM layer is untouched. build-native.sh, release workflow, all four bindings and docs updated together.

## 9. Rust-as-a-dependency

Public, wasm-free API: `Validator::new(schema_json, options) -> Result<Validator, SchemaError>`, `push_chunk`, `finish`, `take_errors` (typed `ValidationError` with code enum + column names), `take_normalized`, XLSX entry points. `#[wasm_bindgen]` surface becomes a thin adapter module. Full crate metadata (description/license/repository/keywords), rustdoc on public items, `examples/validate_csv.rs` + `examples/validate_xlsx.rs`, plus `examples/rust_server/` in the repo examples tree.

## 10. Build & binaries

- WASM: `RUSTFLAGS=-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint` in build-wasm.mjs (both tiers); `wasm-opt -O4 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int`; `strip = "symbols"`. Browser support floor documented (SIMD128: Chrome 91+/Firefox 89+/Safari 16.4+ — acceptable for this product; documented in PERFORMANCE.md).
- `rust_decimal` trimmed to needed features. Size budget check in kit build (warn > 400 KB fast tier).
- Native: `cargo build --release` unchanged plus optional `IV_NATIVE_CPU=native` passthrough in build-native.sh.

## 11. Tests & CI

- Rust: existing 11 tests + new suites for xlsx scanner (incl. every-chunk-split fuzz over a reference workbook), shared strings, row counter, decimal/date fast-path equivalence (old vs new on generated corpora), ffi smoke (xlsx one-shot), counter parity with csv-core.
- Worker: xlsx pipeline tests must pass against the new pipeline unchanged (parity gate) + new streaming/limit tests. Node package gets its first tests. SDK: packed-error decode tests.
- CI: add `cargo clippy -D warnings` + `cargo fmt --check`, build the **pattern** tier, native `cargo test`, `dotnet build` the C# binding, `go vet` the Go binding, `python -m compileall` the Python binding. Bench stays out of CI (hardware variance) but `bench.mjs --quick` smoke-runs.

## 12. Benchmarks & performance doc

- `scripts/bench.mjs` gains: XLSX scenarios (fixture generator writes real .xlsx), estimate-pass timing, emitNormalized timing, and a `--quick` mode. BENCHMARKS.md regenerated (still auto-generated).
- New `docs/PERFORMANCE.md` (hand-written): hot-path architecture, before/after table from this overhaul, tuning guide (chunkSize, profiles, maxErrors, estimate, deviceMemory), memory model (fingerprints, error queue, normalized buffer), limits table (XLSX caps etc.), reproduction instructions.

## 13. Documentation restructure

```
README.md                 landing + quick links (adds NATIVE_CLIENTS, CONTRIBUTING, CLAUDE.md, INDEX)
docs/INDEX.md             complete docs map (humans + AI)
docs/ARCHITECTURE.md      deep architecture; absorbs CURRENT_FLOW.md (deleted, refs updated)
docs/CODE_MAP.md          file-by-file map incl. Rust modules, scripts, bindings, examples
docs/PERFORMANCE.md       see §12
docs/BENCHMARKS.md        auto-generated (extended)
docs/guides/typescript-browser.md  (from CLIENT_QUICKSTART.md, snippets fixed)
docs/guides/node.md · python.md · csharp.md · go.md · rust.md   (split from NATIVE_CLIENTS.md; NATIVE_CLIENTS.md becomes a short hub)
docs/SCHEMA_REFERENCE.md  stays; sole owner of the 14 validation codes (duplicates become links)
docs/SDK_API.md           stays; sole owner of the 10 fatal codes; concatChunks snippet fixed via new SDK export
docs/TROUBLESHOOTING.md   new (build order, wasm cache retry, .js-extension ESM rule, lib loading)
docs/CHANGELOG.md         new; documents this overhaul including rename + protocol notes
docs/code-map-3d.html     committed copy of the 3D interactive graph (also published as an Artifact)
CONTRIBUTING.md           expanded (tests incl. single-test recipes, native builds, conventions)
CLAUDE.md                 updated to the new structure
```

Small fixes: SDK exports `concatChunks(parts: Uint8Array[])`; `customer-profiles.json` entries become schema-conformant configs; MODIFIER_TASKS.md clarifies Phase 4 status; ENGINEERING_STANDARDS CI section corrected; stale self-dates refreshed.

## 14. 3D codebase map

Self-contained HTML (no CDNs): custom 3D force-directed layout + canvas renderer, Obsidian-style — drag-rotate, wheel-zoom, hover labels, click-to-focus with neighbor dimming, color by area (rust/core/worker/sdk/node/bindings/examples/docs/scripts), search box, area filter toggles, light/dark aware. Node/edge data generated from the real import/reference graph at build time of the page (checked in as data inside the HTML). Published via Artifact and committed to `docs/code-map-3d.html`.

## 15. Delivery order

1. Rust module split (pure refactor, tests green) → 2. CSV hot-path opts + counter → 3. XLSX scanner + WASM API + native one-shot → 4. build flags/rename → 5. worker/core/node pipelines → 6. FFI/bindings/examples → 7. tests/CI → 8. benchmarks → 9. docs + 3D map → 10. full verify + commit(s).

Each stage keeps `cargo test` + `pnpm run verify` + `pnpm run test` green; performance claims come from re-running `pnpm run bench` against the recorded baseline.

## 16. Risks & mitigations

- **XLSX parser correctness**: parity-locked tests + fuzz over chunk splits + keep worker tests unchanged. Namespaced tags (`<x:row>`) handled by the scanner (prefix-agnostic matching) — an improvement over the regex.
- **SIMD browser floor**: documented; fast/full tiers unchanged in shape. If a customer needs pre-2021 browsers, they rebuild without the flag (documented).
- **Rename fallout**: single coordinated change across build script, workflow, bindings, docs; CHANGELOG entry; kit manifest carries the new names.
- **Protocol skew (worker↔SDK)**: shipped together in the kit; CHANGELOG calls out that both must upgrade together.
