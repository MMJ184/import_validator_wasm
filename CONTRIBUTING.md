# Contributing

## Prerequisites

- Node.js 20+ and pnpm 10+
- Rust stable + `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- `wasm-pack` (`curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`)
- Optional, for bindings/examples work: .NET 8 SDK, Go 1.21+, Python 3.9+

## Setup & build

```bash
pnpm install
pnpm run build     # full pipeline; ORDER MATTERS: wasm → core → worker/node → sdk → demo
```

After touching `crates/validator`, regenerate the WASM before TS work:

```bash
pnpm --filter @import-validator/core run build:wasm    # add WASM_FEATURES=pattern for the full tier
pnpm --filter @import-validator/core run build:pkg
```

## Tests

```bash
# Everything JS (builds first where needed)
pnpm run test

# One package
pnpm --filter @import-validator/worker run test
pnpm --filter @import-validator/node run test

# One file (after that package's build)
node --test packages/worker/test/xlsx-validate.test.mjs

# Rust: unit + integration, both feature tiers
cd crates/validator
cargo test
cargo test --features pattern

# One Rust test
cargo test records_spanning_chunk_boundaries

# Lints (CI enforces both)
cargo fmt --check && cargo clippy --all-targets -- -D warnings

# Native library + bindings smoke
./scripts/build-native.sh
dotnet build bindings/csharp/ImportValidator.csproj
```

## Merge gate

`pnpm run verify` (build + typecheck) and `pnpm run test` must pass; Rust
changes additionally need `cargo test` + fmt/clippy clean on both tiers. CI
runs all of it — see `.github/workflows/ci.yml`.

## Conventions

- Relative imports in `packages/*/src` carry `.js` extensions (compiled dist
  is consumed by Node ESM directly).
- `dist/worker.js` must stay self-contained (the kit build enforces it).
- Contract surfaces are additive-only: wasm-bindgen JS names
  (`crates/validator/src/wasm_api.rs`), the C ABI
  (`bindings/include/import_validator.h`), the packed error layout, and the
  worker protocol (bump `WORKER_PROTOCOL_VERSION` for new message kinds).
- Keep XLSX guardrail constants identical in `packages/core/src/xlsx/zip.ts`
  and `crates/validator/src/xlsx/zip.rs`.
- API/config changes update docs in the same PR — start from
  [docs/CODE_MAP.md](docs/CODE_MAP.md)'s cross-cutting recipes, and record
  user-visible changes in [docs/CHANGELOG.md](docs/CHANGELOG.md).
- Performance claims come from `pnpm run bench` on a quiet machine, compared
  against the tables in docs/BENCHMARKS.md.

## Where things live

[docs/CODE_MAP.md](docs/CODE_MAP.md) maps every file;
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how they interact;
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) unblocks common failures.
