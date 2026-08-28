# Benchmarks

Measured with `pnpm run bench` (median of 3 runs after warmup), schema with
10 columns: int + email (both `unique`), two modifier-heavy strings
(trim/collapse/titleCase), decimal with scale, number, date, two allow-lists,
and a composite `uniqueGroups` key — a deliberately validation-heavy setup,
not a parse-only best case.

- Date: 2026-08-28
- Machine: Apple M3 Pro (arm64), Node v24.11.1
- Engine: fast WASM tier (no regex), `opt-level=3`, LTO, `wasm-opt -O4`
- Runtime: @import-validator/node (same engine the browser worker runs)

## CSV validation

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 100k rows, clean | 10.0 MB | 77 ms | 1,292,940 rows/s · 128.9 MB/s | 0 |
| 100k rows, 5% dirty | 9.9 MB | 79 ms | 1,272,313 rows/s · 126.6 MB/s | 5,493 |
| 1M rows, clean | 102.7 MB | 847 ms | 1,180,920 rows/s · 121.3 MB/s | 0 |
| 1M rows, 5% dirty | 102.5 MB | 841 ms | 1,188,789 rows/s · 121.8 MB/s | 55,116 |

## Excel (XLSX) validation

The workbook streams through ZIP + DEFLATE into the Rust worksheet scanner;
rows validate through the same engine as CSV. File size below is the
COMPRESSED .xlsx size (XML expands ~6-10x when decompressed), so rows/s is
the comparable number, not MB/s.

| Scenario | File size (compressed) | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 100k rows, clean (xlsx) | 6.5 MB | 238 ms | 420,513 rows/s · 27.3 MB/s | 0 |
| 100k rows, 5% dirty (xlsx) | 6.5 MB | 240 ms | 416,734 rows/s · 27.2 MB/s | 5,493 |
| 250k rows, clean (xlsx) | 16.3 MB | 621 ms | 402,396 rows/s · 26.3 MB/s | 0 |

## Auxiliary passes

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 1M rows, estimate pass (csv) | 102.7 MB | 241 ms | 4,154,835 rows/s · 426.7 MB/s | 0 |
| 1M rows, clean + normalized | 102.7 MB | 1,091 ms | 916,702 rows/s · 94.1 MB/s | 0 |

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
