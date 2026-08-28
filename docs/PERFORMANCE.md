# Performance

How the engine achieves its throughput, what the numbers are, how to tune a
deployment, and the memory model. Machine-generated benchmark tables live in
[BENCHMARKS.md](./BENCHMARKS.md) (regenerate with `pnpm run bench`).

## 1. Current numbers (2026-07-07, Apple M3 Pro, Node 24, fast tier)

Validation-heavy 10-column schema (2 unique columns, composite unique group,
modifiers, decimal/date/email/allow-lists) — not a parse-only best case:

| Path | Scenario | Throughput |
|---|---|---:|
| CSV validate | 100k rows | ~1.28M rows/s · 127 MB/s |
| CSV validate | 1M rows | ~1.14M rows/s · 117 MB/s |
| CSV validate | 1M rows, 5% dirty | ~1.09M rows/s |
| Excel validate | 100k rows | ~360k rows/s |
| Excel validate | 250k rows | ~365k rows/s (flat scaling) |
| CSV estimate pass | 1M rows | ~4.4M rows/s · 449 MB/s |
| CSV validate + normalized output | 1M rows | ~910k rows/s |

Excel MB/s is measured against the compressed .xlsx (≈6–10× smaller than its
XML), so rows/s is the comparable metric between CSV and Excel.

## 2. Before / after: the 2026-07 engine overhaul

Same machine, same schema, same fixtures.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| CSV 100k rows | 751k rows/s | 1.28M rows/s | **+70%** |
| CSV 1M rows | 600k rows/s | 1.14M rows/s | **+90%** |
| CSV 1M rows, 5% dirty | 670k rows/s | 1.09M rows/s | +63% |
| Excel 100k rows (same workbook, same errors found) | 163k rows/s | 362k rows/s | **2.2×** |
| CSV estimate 1M rows | whole-file JS byte scan | 4.4M rows/s in WASM | ~10× |
| Excel estimate (sheet with `<dimension>`) | inflated + decoded the whole sheet | stops after the first KBs | size-proportional → constant |
| Excel validate with estimate on | sheet inflated+decoded **twice** | ZIP opened once, streamed once | 2× I/O removed |
| 1M-row scaling penalty | −20% vs 100k | −7% vs 100k | uniqueness sets fixed |
| WASM binary | 256.7 KB | 296.5 KB (now contains the whole Excel engine) | +15% |

What produced the CSV gains (measured, in descending impact):

1. **Zero-allocation field path.** Field preparation returns `Cow<str>`:
   columns without active modifiers borrow straight from the record buffer;
   canonical values are moved (never cloned) and only materialized when
   something consumes them (normalized output / uniqueGroups). Previously
   every field paid two `String` allocations.
2. **Uniqueness hashing.** One xxh3-128 pass per value (was two SipHash
   passes) into identity-hash sets (was SipHash-of-a-hash). This is also what
   flattened the 1M-row curve — inserts got cheap enough that set growth
   stopped dominating.
3. **Canonical fast paths.** A decimal like `12.34` at precision 2 or a date
   already in `YYYY-MM-DD` validates without re-serialization (borrow, not
   rewrite).
4. FxHash header/allow-list maps, memchr-segmented CSV quoting.

What produced the Excel gains: XML row extraction moved from a JS
regex-over-one-giant-string pipeline (XML string → JS row arrays → CSV text →
re-encoded bytes → CSV parser) into a streaming Rust scanner that feeds the
validator directly. The 2.2× number is single-pass engine work; real
browser flows gain more because the estimate preflight no longer inflates
and decodes the sheet a second time.

**A finding worth keeping: WASM SIMD was measured ≈ neutral** on the CSV
validate path (the engine is compute-bound in per-field logic, not byte
scanning), so the default build keeps the widest browser compatibility.
`IV_WASM_SIMD=1` produces a SIMD128+bulk-memory build (floor: Chrome 91+,
Firefox 89+, Safari 16.4+) if you want to squeeze scanning-heavy workloads.

## 3. Where time goes (mental model)

```
CSV:   [file read] → [csv-core record split] → [per-field: modifiers →
       gates → type check → uniqueness] → [error packing] → [drain to host]
Excel: [ZIP dir] → [inflate (native zlib / miniz)] → [XML scan] → same per-field path
```

- Clean data is the worst case for throughput measured in rows/s? No —
  *dirty* data is slightly cheaper per row (failed fields short-circuit the
  rest of their pipeline) but pays error-drain costs. The two roughly cancel;
  see the dirty rows in BENCHMARKS.md.
- Unique columns are the main per-row cost that grows with file size (set
  inserts). Fingerprints keep it ~24 bytes and O(1) per distinct value.
- `emitNormalized` costs ~20% (row re-serialization + host drain); it is
  size-gated by default in the SDK (`chooseEmitNormalizedSmart`, ≤20 MB).
- The browser adds chunked `File` reads and `postMessage`. The worker
  overlaps reads with compute (one-chunk read-ahead) and transfers big
  buffers (packed errors, normalized chunks) instead of structured-cloning.
- **Push size is decoupled from inflate size** (2026-08), because the two costs
  pull opposite ways. Inflater output size matters on the Node side: zlib's
  default 16 KB units send a large worksheet through stream plumbing thousands
  of times, so asking for 1 MB units is worth ~10% end to end and costs nothing
  (zlib just writes into a bigger buffer). Engine push size, by contrast, is
  throughput-*flat* from ~16 KB to 1 MB, so a big push buys nothing while
  delaying everything that happens between pushes — draining errors, emitting
  progress, noticing a cancel. Hence `rechunk`: inflate in 1 MB units, push
  in 64 KB ones, splitting as zero-copy views. Worker macrotask yields are
  paced by the clock (~16 ms via monotonic `performance.now()`) rather than by
  chunk count, which is what the tick savings actually came from.

## 4. Tuning guide

| Knob | Default | Effect |
|---|---|---|
| `chunkSize` | 128 KB – 4 MB by file size, capped by `navigator.deviceMemory` | Sizes **CSV file reads only**. Bigger chunks = fewer boundary crossings, more memory. The default curve is right for almost everyone; override only for unusual environments. It does **not** affect the XLSX path, where inflate and push sizes are fixed and chosen independently (see §3) — a knob there would only let callers re-open the error-queue starvation the fixed sizes avoid. |
| `estimate` | profile-dependent (`strict` on) | Adds a fast pre-pass (~4M rows/s) for row/col guardrails + progress denominators. Cost is now small; leave on if you use guardrails. |
| `maxErrors` | size-based (2k–20k) | Caps errors *queued in the engine at once*. It bounds memory only — **every row is read, counted and validated regardless**, so `rowsProcessed` is always the true row count and never varies with chunk size. Errors found while the queue is full are counted, not discarded silently: read the total via `onDone(errorsSuppressed)` / `result.errorsSuppressed` / `iv_engine_errors_suppressed`. Because hosts drain per chunk, the queue refills and a file can still *return* well past `maxErrors`; `maxPostErrorsTotal` bounds the browser per-file total, and the Node package has no equivalent cap. **The same number means different things by host:** the browser worker and Node drain every chunk, so it is a queue depth and the returned count varies with `chunkSize`; Python/Go/C# drain only at the end, so it is an effective per-file total there. `rowsProcessed`, and returned + suppressed, are identical either way. |
| `maxPostErrorsTotal` / `postErrorBatch` | profile | UI back-pressure; packed transfer makes batches cheap, so prefer larger batches over more messages. |
| `emitNormalized` | off (size-gated) | ~20% throughput cost + output memory at the host. |
| `profile` | `balanced` | `fast` = no estimate, 10k errors; `strict` = estimate + 100k errors. |
| `timeoutMs` / `cancel()` | off / manual | Both abort cooperatively between pushes. The pipeline yields a macrotask about every 16 ms (clock-paced, not per chunk), so a `cancel()` — which arrives as a message — is seen within roughly that plus one push. `timeoutMs` is a `setTimeout` in the worker, and a MessageChannel yield does not drain the timer phase under Node, so every 4th yield goes through `setTimeout` instead: expect timeout latency up to ~64 ms plus one push. Measured: cancel ~50 ms, a 100 ms timeout firing at ~167 ms on a 190 MB file. |
| Schema shape | — | `unique`/`uniqueGroups` are the expensive features (hashing + set memory). `pattern` requires the full tier and regex cost per field. Plain typed columns are nearly free. |
| `IV_WASM_SIMD=1` build | off | See §2. |
| Native `IV_NATIVE_CPU=native` | off | Host-tuned codegen for servers you control (don't distribute such binaries). |

## 5. Memory model

| Component | Cost |
|---|---|
| Engine buffers | ~64 KB record buffer + chunk copy (host-side chunk is transferred into WASM per push) |
| `unique` column | ~24 bytes × distinct values (fingerprints, value length irrelevant) |
| `uniqueGroups` | same, plus canonical values of member columns for the current row only |
| Error queue | 8 bytes × queued errors, bounded by `maxErrors`; drained per chunk |
| Normalized buffer | one chunk's normalized output in-engine for hosts that drain per chunk (browser worker, `@import-validator/node`, the language bindings); retained capacity is capped at 2 MB between drains. Rows are never dropped or truncated to fit, so a host that drains only at the end holds the whole normalized output in the engine — as the one-shot XLSX entry points (`iv_engine_validate_xlsx_bytes`, `Validator::validate_xlsx_bytes`) necessarily do, bounded there by the XLSX size guardrails. Host accumulates what it keeps |
| XLSX shared strings | total text bytes + 4 bytes/string (streamed once, held for the file's lifetime) |
| XLSX sheet XML | **never held** — streamed in ~64 KB chunks (the old pipeline held the whole decoded string) |

Guardrails (enforced identically in browser/Node/native): ≤20,000 ZIP
entries, sheet XML ≤192 MB, shared strings ≤128 MB, total decompressed
≤768 MB, compression ratio ≤1000×, no ZIP64. CSV files have no engine size
limit — memory stays flat with streaming; use `maxFileBytes` for policy.

## 6. Reproducing and extending

```bash
pnpm run build          # WASM + packages
pnpm run bench          # full suite → rewrites docs/BENCHMARKS.md
node scripts/bench.mjs --quick   # 100k CSV smoke (CI-friendly)
cd crates/validator && cargo test   # correctness incl. chunk-boundary fuzz
```

Methodology: median of 3 runs after a warmup run; deterministic mulberry32
fixtures (seed 42); errors counted to verify the run did real work. When
comparing engine changes, run the suite twice and keep the machine idle —
laptop thermal state moves results by ~10–15%.

Deliberately not implemented (evaluated, rejected — revisit only with data):
hand-written SIMD CSV parser (csv-core is not the bottleneck), WASM
threads/SharedArrayBuffer (COOP/COEP burden on every customer for unclear
gain), wasm64, multi-worker sharding (uniqueness state would need merging).
