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
- Workflow: `.github/workflows/ci.yml`
- CI gates:
  - typecheck
  - traced build
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
- Keep Excel route isolated from CSV fast path.
- Excel parser dependencies must not impact default CSV runtime bundle.
