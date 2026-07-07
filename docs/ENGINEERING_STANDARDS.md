# Engineering Standards

This document defines project-level standards for enterprise maintenance and release quality.

## 1) Repository Governance
- Keep `main`/`master` protected.
- Require CI pass before merge.
- Prefer small scoped pull requests with clear titles.
- Do not bypass failing typecheck/build gates.

## 2) Workspace Standards
- Package manager: `pnpm`.
- Workspace roots:
  - `packages/*`
  - `examples/*`
- Shared lockfile and strict peer dependency policy in `.npmrc`.

## 3) Build Standards
- Fast default build path:
  - `pnpm run build`
- Full verification:
  - `pnpm run verify`
- Traced build (required for release investigations):
  - `pnpm run build:trace`

## 4) WASM Build Policy
- Fast build is default and optimized for throughput.
- Full build enables heavy regex/pattern logic.
- Avoid enabling full build for tenants that do not require pattern validation.

## 5) Logging and Traceability
- Build traces stored under `artifacts/build-traces/<timestamp>/`.
- Keep trace logs for incident or regression analysis.
- Use `summary.json` for machine processing and `summary.md` for human review.

## 6) CI Standards
- Workflows: `.github/workflows/ci.yml` (every push/PR) and
  `.github/workflows/release-native.yml` (tags, with a test gate).
- CI gates (build-and-test job):
  - `cargo fmt --check` and `cargo clippy -D warnings` (fast + pattern tiers)
  - Rust tests (fast + pattern tiers)
  - traced build, pattern-tier WASM build, typecheck
  - JS tests (worker, node, sdk)
  - Rust crate examples compile
  - customer kit assembly (worker self-containment + WASM size budget)
- CI gates (bindings job): native library build, C# `dotnet build`,
  Go `go vet` + `go build`, Python binding smoke test.
- Build trace artifacts must be uploaded on each CI run.

## 7) Runtime Safety Defaults
- Always set tenant guardrails:
  - `maxFileBytes`
  - `maxRowsEstimate`
  - `maxColumns`
  - `timeoutMs`
- Prefer profile-based runtime controls (`fast`/`balanced`/`strict`).

## 8) Backward Compatibility
- Maintain `schemaVersion` and reject unsupported versions clearly.
- Any breaking config change must increment schema contract version.

## 9) Release Checklist
- `pnpm install --frozen-lockfile`
- `pnpm run verify`
- `pnpm run build:trace`
- Confirm docs/schema updates for any config behavior changes.

## 10) Excel Strategy
- Excel parsing lives in the Rust core (streaming worksheet scanner); rows
  validate through the exact same path as CSV.
- The WASM binary never carries a DEFLATE implementation — browsers inflate
  with `DecompressionStream`, Node with `node:zlib`, native callers with the
  built-in one-shot (`miniz_oxide`).
- XLSX guardrail constants must stay identical in
  `packages/core/src/xlsx/zip.ts` and `crates/validator/src/xlsx/zip.rs`.
