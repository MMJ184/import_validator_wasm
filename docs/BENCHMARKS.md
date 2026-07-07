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
| 100k rows, clean | 10.0 MB | 78 ms | 1,276,171 rows/s · 127.2 MB/s | 0 |
| 100k rows, 5% dirty | 9.9 MB | 80 ms | 1,252,498 rows/s · 124.6 MB/s | 5,493 |
| 1M rows, clean | 102.7 MB | 877 ms | 1,140,484 rows/s · 117.1 MB/s | 0 |
| 1M rows, 5% dirty | 102.5 MB | 917 ms | 1,090,305 rows/s · 111.7 MB/s | 55,116 |

## Excel (XLSX) validation

The workbook streams through ZIP + DEFLATE into the Rust worksheet scanner;
rows validate through the same engine as CSV. File size below is the
COMPRESSED .xlsx size (XML expands ~6-10x when decompressed), so rows/s is
the comparable number, not MB/s.

| Scenario | File size (compressed) | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 100k rows, clean (xlsx) | 6.5 MB | 278 ms | 359,153 rows/s · 23.3 MB/s | 0 |
| 100k rows, 5% dirty (xlsx) | 6.5 MB | 273 ms | 366,821 rows/s · 23.9 MB/s | 5,493 |
| 250k rows, clean (xlsx) | 16.3 MB | 684 ms | 365,491 rows/s · 23.9 MB/s | 0 |

## Auxiliary passes

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 1M rows, estimate pass (csv) | 102.7 MB | 229 ms | 4,373,557 rows/s · 449.1 MB/s | 0 |
| 1M rows, clean + normalized | 102.7 MB | 1,098 ms | 910,690 rows/s · 93.5 MB/s | 0 |

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
