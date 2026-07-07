# Import Validator Product Readiness

This document defines multi-customer production guidance for CSV and Excel ingestion.

## 1) Schema Versioning
- Contract field: `schemaVersion` (currently supports `1`).
- Worker rejects unsupported versions early with explicit error.

## 2) Tiered Product Profiles
- Runtime profiles: `fast`, `balanced`, `strict`.
- Profiles tune batching, estimate behavior, and normalized output defaults.
- Build tiers:
  - Fast build (default): no regex engine in WASM for smallest binary.
  - Full build: enable pattern feature (`pnpm --filter @import-validator/core run build:wasm:full`).

## 3) Contract + Stable Errors
- JSON config contract: `docs/validation-config.schema.json`.
- Stable machine-readable error fields are emitted for each row/column.
- Fatal events now include stable codes:
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

## 4) Guardrails
- Supported runtime guards:
  - `maxFileBytes`
  - `maxRowsEstimate`
  - `maxColumns`
  - `timeoutMs`
  - `dryRunRows`

## 5) Observability
- Worker emits `metrics` with:
  - elapsed time
  - rows processed
  - rows/sec
  - file size
  - format and dry-run flag

## 6) Test Packs
- Keep customer fixture packs by domain (finance, ops, healthcare).
- Include edge cases (delimiter, BOM, malformed, large files, unicode).

## 7) Security Hardening
- Regex length capped in config schema.
- Hard row/file/column limits available per request.
- Keep CSV parser streaming to reduce memory spikes.

## 8) Multi-Tenant Policy
- Tenant defaults should be mapped to runtime profile + limits.
- Per-request overrides are supported for controlled flexibility.

## 9) Customer UX
- Estimate pass is optional (`estimate=true`).
- Estimate-only preflight mode is available (`estimateOnly=true`).
- `estimateChunkSize` can be tuned separately from validate chunk size.
- Dry-run supported via `dryRunRows`.
- Error CSV export helper available from SDK.

## 10) Commercial Readiness
- Publish support matrix and SLA in customer docs:
  - max tested file size
  - browser support
  - expected throughput range
  - timeout/limit behavior

## Excel Strategy
- Excel routing is explicit (`format=excel`, auto-detected by extension) and
  runs in the Rust core: the worksheet streams through the SAME validation
  path as CSV — identical error codes, modifiers, and normalized output.
- Available on every surface: browser worker, Node
  (`validateXlsxFile/Buffer/Stream`), Python/C#/Go/Rust (one-shot
  `validate_xlsx_bytes`).
- Container guardrails are enforced identically everywhere: ≤20,000 ZIP
  entries, sheet XML ≤192 MB, shared strings ≤128 MB, total decompressed
  ≤768 MB, compression ratio ≤1000×, no ZIP64; `.xls` is rejected.
- Number formats are not applied (cells validate their raw stored values);
  dates must be stored as ISO text to satisfy `date` columns.
