# Changelog

## 0.2.0 — 2026-07-07

The performance/product overhaul. One engine, six first-class languages,
Excel everywhere.

### Highlights

- **CSV throughput ~1.9× at scale**: 1M rows went from ~600k to ~1.14M rows/s
  (zero-allocation field path, single-pass xxh3-128 uniqueness fingerprints
  in identity-hash sets, canonical fast paths for decimal/date). Details and
  methodology: PERFORMANCE.md.
- **Excel moved into the Rust core**: streaming worksheet scanner replaces
  the TypeScript regex pipeline — 2.2× faster on identical workbooks with
  exact error parity, sheet XML never held in memory, and the estimate
  preflight no longer inflates the sheet twice.
- **Excel on every surface**: Node (`validateXlsxFile/Buffer/Stream`),
  Python/C#/Go (`validate_xlsx_bytes`/`ValidateXlsxBytes` one-shot), Rust
  (`Validator::validate_xlsx_bytes`), browser (as before, now faster).
- **Estimate pass ~10× faster**: exact quote-aware row counting in WASM
  (~4.4M rows/s) instead of a JS byte loop; XLSX `<dimension>` estimates stop
  inflating after the first kilobytes.
- **Rust crate is now a real dependency**: `import_validator::Validator`
  public API (no wasm types), crate metadata, rustdoc, runnable examples.
- **Native bindings parity**: decoded errors with column names + human
  messages in Python/C#/Go (matching Node), packaging manifests
  (pyproject.toml / .csproj / go.mod), version constants, license headers.
  The C# binding's compile-blocking dead code is fixed.

### Breaking / behavioral changes

- **Native library renamed**: `libimport_validator_wasm.*` →
  `libimport_validator.*` / `import_validator.dll`. Update load paths and
  link flags (`-limport_validator`). The Rust crate is now named
  `import-validator` (lib `import_validator`), version 0.2.0.
- **Worker⇄SDK protocol v2**: error batches transfer as packed u32 buffers
  and decode in the SDK; new `cancel` message; `CANCELLED` fatal code.
  Compatibility: a v1 SDK against a v2 worker keeps working (the worker
  falls back to decoded `errors` messages when `init` carries no
  `protocolVersion`); upgrade both together anyway — they ship together in
  the kit.
- **CRLF estimate fix**: row estimates for CRLF-terminated files previously
  counted one phantom trailing row; they no longer do. Exact-count consumers
  may see counts drop by 1.
- **XLSX**: cell references beyond Excel's 16,384-column limit now fail fast
  with a clear error (previously could exhaust memory); phonetic `<rPh>`
  runs are excluded from shared strings; scanning stops at `</sheetData>`.
  When a workbook contains `xl/sharedStrings.xml` it is always loaded
  (the old pipeline skipped it for sheets that never referenced it).
- **Engine API**: one engine instance validates exactly one stream (CSV xor
  XLSX); mixing input modes on one engine errors.

### New APIs

- SDK: `ValidatorClient.cancel()`, `concatChunks` export, queued (not
  dropped) validates issued before `ready`.
- Core (TS): `pushSharedStringsChunk`, `pushSheetChunk`, `takeErrorsPacked`,
  `dropErrors`, `rowsProcessed`, `decodePackedErrors`, `CsvRowCounter`,
  `XlsxSheetRowCounter`, ZIP reader (`parseZipEntries`, `entryByteStream`,
  `XLSX_LIMITS`), `isWasmReady`.
- C ABI: `iv_version`, `iv_engine_rows_processed`,
  `iv_engine_validate_xlsx_bytes`, `iv_engine_push_shared_strings_chunk`,
  `iv_engine_push_sheet_chunk`.
- WASM: `RowCounter`, `XlsxRowCounter`, `engine_version`, `drop_errors`,
  `rows_processed`, sheet/shared-strings pushes.

### Tooling

- CI: rustfmt + clippy (-D warnings, both tiers), tests on both tiers,
  pattern-tier WASM build, Rust examples compile, bindings job (native
  build, dotnet build, go vet/build, Python smoke test). Native release
  workflow gained a test gate.
- Benchmarks: XLSX + estimate + normalized scenarios, `--quick` mode.
- Docs: ARCHITECTURE, CODE_MAP (+ interactive 3D map), PERFORMANCE, INDEX,
  TROUBLESHOOTING, per-language guides, this changelog.

## 0.1.0 — 2026-06

Initial product: Rust/WASM CSV engine, browser worker + SDK, Node wrapper,
TS-based XLSX path, native C ABI with Python/C#/Go wrappers, customer kit.
