# import-validator-wasm

High-performance CSV validation engine with WASM core, worker runtime, and SDK.

## Workspace Structure
- `crates/validator`: Rust WASM validator engine.
- `packages/core`: WASM loader + engine API + shared core helpers.
- `packages/worker`: Worker pipeline (CSV fast path + separated `.xlsx` Excel route).
- `packages/sdk`: Public client SDK for browser integrations.
- `examples/vite-ts-demo`: Demo app.
- `examples/csv-generator`: Sample CSV generation utility.
- `docs`: Product/readiness/contract documentation.

## Build Modes
- Fast WASM build (default): minimal binary, maximum throughput.
- Full WASM build (pattern validation enabled): larger binary.

Core scripts:
- `pnpm --filter @import-validator/core run build:wasm:fast`
- `pnpm --filter @import-validator/core run build:wasm:full`

## Common Commands
- `pnpm run typecheck`: workspace type checks.
- `pnpm run test`: worker + sdk automated tests.
- `pnpm run build`: production build for core, worker, sdk, and demo.
- `pnpm run dist:customer`: build and assemble customer distribution kit.
- `pnpm run dist:customer:full`: rebuild + assemble customer distribution kit.
- `pnpm run verify`: typecheck + build.
- `pnpm run build:trace`: full build with detailed per-step logs and timing.
- `pnpm run dev:ex`: run Vite demo.

## Runtime Notes
- Two-pass flow: `estimate=true` performs estimate first, then validate.
- Preflight-only flow: `estimateOnly=true` runs estimate and skips full validation.
- Structured fatal payloads include code/message/details/file context via SDK `onFatal`.
- Excel path supports `.xlsx` in a separate worker pipeline; `.xls` is rejected.

## Build Trace Output
`pnpm run build:trace` writes artifacts to:
- `artifacts/build-traces/<timestamp>/summary.json`
- `artifacts/build-traces/<timestamp>/summary.md`
- `artifacts/build-traces/<timestamp>/<step>.log`

This is used for enterprise debugging and build regression tracking.

## Enterprise Docs
- Current implementation flow: `docs/CURRENT_FLOW.md`
- Product readiness: `docs/PRODUCT_READINESS.md`
- Customer distribution guide: `docs/CUSTOMER_DISTRIBUTION.md`
- Validation config schema: `docs/validation-config.schema.json`
- Tenant profile examples: `docs/customer-profiles.json`
- Engineering standards: `docs/ENGINEERING_STANDARDS.md`

## CI
GitHub Actions workflow:
- `.github/workflows/ci.yml`
- Runs typecheck + build trace and uploads trace artifacts.
