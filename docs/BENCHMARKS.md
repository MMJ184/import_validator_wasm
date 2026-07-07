# Benchmarks

Measured with `pnpm run bench` (median of 3 runs after warmup), schema with
10 columns: int + email (both `unique`), two modifier-heavy strings
(trim/collapse/titleCase), decimal with scale, number, date, two allow-lists,
and a composite `uniqueGroups` key — a deliberately validation-heavy setup,
not a parse-only best case.

- Date: 2026-07-07
- Machine: Apple M3 Pro (arm64), Node v24.11.1
- Engine: fast WASM tier (no regex), `opt-level=3`, LTO, `wasm-opt -O4`
- Runtime: @import-validator/node (same engine the browser worker runs)

## CSV validation

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 100k rows, clean | 10.0 MB | 78 ms | 1,276,057 rows/s · 127.2 MB/s | 0 |
| 100k rows, 5% dirty | 9.9 MB | 80 ms | 1,254,861 rows/s · 124.9 MB/s | 5,493 |
| 1M rows, clean | 102.7 MB | 862 ms | 1,160,661 rows/s · 119.2 MB/s | 0 |
| 1M rows, 5% dirty | 102.5 MB | 838 ms | 1,192,774 rows/s · 122.2 MB/s | 55,116 |

## Excel (XLSX) validation

The workbook streams through ZIP + DEFLATE into the Rust worksheet scanner;
rows validate through the same engine as CSV. File size below is the
COMPRESSED .xlsx size (XML expands ~6-10x when decompressed), so rows/s is
the comparable number, not MB/s.

| Scenario | File size (compressed) | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 100k rows, clean (xlsx) | 6.5 MB | 290 ms | 345,087 rows/s · 22.4 MB/s | 0 |
| 100k rows, 5% dirty (xlsx) | 6.5 MB | 278 ms | 360,244 rows/s · 23.5 MB/s | 5,493 |
| 250k rows, clean (xlsx) | 16.3 MB | 696 ms | 359,107 rows/s · 23.4 MB/s | 0 |

## Auxiliary passes

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 1M rows, estimate pass (csv) | 102.7 MB | 244 ms | 4,102,101 rows/s · 421.3 MB/s | 0 |
| 1M rows, clean + normalized | 102.7 MB | 1,078 ms | 927,906 rows/s · 95.3 MB/s | 0 |

Browser numbers track these closely: the Web Worker runs the identical WASM
binary; expect a few percent overhead from chunked File reads and message
passing. The demo's metrics panel reports live rows/s for any file you drop in.

See docs/PERFORMANCE.md for the tuning guide, memory model, and the
before/after history of engine optimizations.

Reproduce:

```bash
pnpm run build   # build WASM + packages
pnpm run bench   # rewrites this file with your machine's numbers
```
