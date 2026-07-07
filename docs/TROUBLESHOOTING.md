# Troubleshooting

Failure playbook for building, integrating, and running ImportValidator.

## Build failures

**`Cannot find module '@import-validator/core'` / missing wasm pkg during typecheck**
Build order is load-bearing: WASM → core → worker/node → sdk. Run
`pnpm run build` once; then incremental builds work. `pnpm run verify` runs
build + typecheck in the right order.

**`wasm-pack: command not found`**
`curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`
(plus `rustup target add wasm32-unknown-unknown`).

**Rust edits don't show up in the browser/Node**
The wasm pkg is generated into `packages/core/src/wasm/pkg` and copied to
dist by `build:pkg`. After touching `crates/validator`, run
`pnpm --filter @import-validator/core run build:wasm && pnpm --filter @import-validator/core run build:pkg`,
then rebuild dependent packages.

**Kit build fails with "bare @import-validator imports"**
`dist/worker.js` must be self-contained. Rebuild the worker
(`pnpm --filter @import-validator/worker run build`) — the esbuild bundle
step rewrites the tsc output.

## Browser / SDK

**Fatal `WASM_URL_REQUIRED`**
Pass `wasmUrl` in `createValidator` options. With Vite:
`import wasmUrl from "@import-validator/core/wasm?url"` or use
`defaultWasmUrl`.

**`WebAssembly.instantiate(): function import requires a callable`**
Stale cached `.wasm` that doesn't match the JS glue. The loader retries once
with a cache-busting query automatically; if it persists, your static
hosting serves an old `import_validator_wasm_bg.wasm` next to a new
`worker.js` — deploy them together (they version as a pair).

**Fatal `EXCEL_ROUTE_DISABLED` / `.xls` rejected**
Only `.xlsx` is supported. Legacy `.xls` must be re-saved as `.xlsx`.

**Schema with `pattern` fails at init on the fast build**
Regex support lives in the full tier. Build with
`WASM_FEATURES=pattern pnpm --filter @import-validator/core run build:wasm`
and host that binary.

**Validation hangs / timeout never fires** — fixed in 0.2.0 (pipelines yield
a macrotask per chunk). If you see it on 0.1.x, upgrade.

**XLSX fails with a size/entries/ratio error**
You hit a container guardrail (sheet XML ≤192 MB, shared strings ≤128 MB,
total ≤768 MB, ≤20k entries, ratio ≤1000×, no ZIP64). These are zip-bomb
protections; split the workbook or export CSV for bigger data.

## Node

**`Engine not initialized`** — call `await init(wasmUrl?)` or any
`validate*` function first (they auto-init); when packaging with a bundler,
pass an explicit `wasmUrl` file path.

**`validateXlsxStream` memory** — it must buffer the whole stream (ZIP
directories live at the end of the file). Persist uploads to disk and use
`validateXlsxFile` for large workbooks.

## Native bindings (Python / C# / Go)

**Library not found**
Build it first: `./scripts/build-native.sh` →
`crates/validator/target/release/libimport_validator.{dylib,so}` /
`import_validator.dll`. Then either place it next to the binding file, set
`IMPORT_VALIDATOR_LIB=/abs/path` (Python), or configure the loader path
(`DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` / PATH). Note the 0.2.0 rename:
the `_wasm` suffix is gone.

**Go: cgo link errors**
`export CGO_CFLAGS="-I$REPO/bindings/include"` and
`export CGO_LDFLAGS="-L$REPO/crates/validator/target/release"` (plus the
runtime library path variable for your OS).

**`iv_engine_new` returns NULL**
The schema JSON was rejected — read the message in `err_buf` (all bindings
surface it as an exception/error). Common causes: unknown field
(`deny_unknown_fields` is on), `pattern` on a non-pattern build, colliding
case-insensitive headers.

**Crashes under concurrency**
Engines are not thread-safe. One engine per concurrent validation; engines
on different threads are fine.

## Estimates

**Estimated rows differ from validated rows**
Estimates count physical CSV rows (quote-aware) minus the header; files with
trailing garbage or embedded newlines in unquoted fields can differ. XLSX
`<dimension>`-based estimates trust the workbook's declared range — a stale
dimension (some generators) over/under-counts; guardrail checks
(`maxRowsEstimate`) force the exact fallback counter automatically.

**XLSX estimate throws `Engine not initialized`**
Row-count fallback (sheets without `<dimension>`) needs the WASM engine:
send `init` before `estimate` (the SDK always does; hand-rolled worker
clients may not).

Still stuck? Check [ARCHITECTURE.md](./ARCHITECTURE.md) §7 invariants and
[CODE_MAP.md](./CODE_MAP.md) to locate the responsible file.
