# ImportValidator

High-performance CSV **and Excel (.xlsx)** validation engine. One Rust core,
six first-class integration surfaces: TypeScript (browser), Node.js, Python,
C#, Go, and Rust — identical error codes, normalization, and schema contract
everywhere.

Measured on the reference schema (10 columns, unique keys, modifiers):
**~1.1–1.3M CSV rows/s**, **~360k Excel rows/s**, estimates at **~4.4M
rows/s**. Full numbers: [docs/BENCHMARKS.md](docs/BENCHMARKS.md); how they're
achieved and tuned: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Documentation

**Start at [docs/INDEX.md](docs/INDEX.md)** — the complete map. Shortcuts:

| I want to… | Read |
|---|---|
| Understand the architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Find which file does what | [docs/CODE_MAP.md](docs/CODE_MAP.md) · interactive: [docs/code-map-3d.html](docs/code-map-3d.html) |
| Integrate in the browser | [docs/guides/typescript-browser.md](docs/guides/typescript-browser.md) |
| Integrate on a server | [Node](docs/guides/node.md) · [Python](docs/guides/python.md) · [C#](docs/guides/csharp.md) · [Go](docs/guides/go.md) · [Rust](docs/guides/rust.md) |
| Write a validation schema | [docs/SCHEMA_REFERENCE.md](docs/SCHEMA_REFERENCE.md) |
| Tune performance | [docs/PERFORMANCE.md](docs/PERFORMANCE.md) |
| Fix a build/runtime problem | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| See what changed | [docs/CHANGELOG.md](docs/CHANGELOG.md) |

## Workspace structure

```
crates/validator      Rust engine (CSV + XLSX + counters) → WASM, C ABI, Rust API
packages/core         WASM loading, Engine wrapper, ZIP reader, heuristics
packages/worker       Browser Web Worker (protocol v2, pipelines, estimates)
packages/sdk          createValidator() browser API
packages/node         Node.js server package (CSV + XLSX)
bindings/             C header + Python (ctypes) + C# (P/Invoke) + Go (cgo)
examples/             vite-ts-demo · node_server · python_server · csharp_server · go_server · csv-generator
docs/                 All documentation (see docs/INDEX.md)
scripts/              bench · build-native · build-customer-kit · build-trace
```

## Build & test

```bash
pnpm install
pnpm run build            # WASM → core → worker → node → sdk → demo (order matters)
pnpm run verify           # build + workspace typecheck (merge gate)
pnpm run test             # worker + node + sdk test suites
cd crates/validator && cargo test        # Rust engine tests (both: --features pattern)

pnpm run dev:ex           # Vite demo (drag-drop CSV/XLSX validation)
pnpm run bench            # rewrites docs/BENCHMARKS.md
./scripts/build-native.sh # native library for Python/C#/Go
pnpm run dist:customer    # customer distribution kit
```

Build modes: the default **fast** WASM tier omits the regex engine;
`WASM_FEATURES=pattern` builds the **full** tier (enables `pattern` /
`regexReplacePattern`). Optional SIMD build: `IV_WASM_SIMD=1` (see
PERFORMANCE.md for the compatibility trade-off).

## CI

`.github/workflows/ci.yml`: rustfmt + clippy (−D warnings, both tiers),
Rust tests (both tiers), traced build, pattern-tier WASM, typecheck, JS
tests, Rust examples, customer kit — plus a bindings job that builds the
native library and compiles/smoke-tests the C#, Go, and Python bindings.
`.github/workflows/release-native.yml`: tagged native binaries
(Linux/macOS/Windows × fast/pattern) behind a test gate.

## License

Proprietary — see `LICENSE`. Customer use requires a commercial license
agreement.
