# Contributing

## Prerequisites
- Node.js 20+
- pnpm 10+
- Rust toolchain + wasm target (`wasm32-unknown-unknown`)
- `wasm-pack`

## Setup
```bash
pnpm install
```

## Development Commands
```bash
pnpm run typecheck
pnpm run build
pnpm run build:trace
pnpm run dev:ex
```

## Build Outputs
- Core WASM package: `packages/core/src/wasm/pkg`
- Dist artifacts: `packages/*/dist`
- Build traces: `artifacts/build-traces/*`

## Expectations
- Keep changes scoped and testable.
- Update docs when changing API/config behavior.
- Do not merge changes that fail `pnpm run verify`.
