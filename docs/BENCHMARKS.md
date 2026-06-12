# Benchmarks

Measured with `pnpm run bench` (median of 3 runs after warmup), schema with
10 columns: int + email (both `unique`), two modifier-heavy strings
(trim/collapse/titleCase), decimal with scale, number, date, two allow-lists,
and a composite `uniqueGroups` key — a deliberately validation-heavy setup,
not a parse-only best case.

- Date: 2026-06-12
- Machine: Apple M3 Pro (arm64), Node v24.11.1
- Engine: fast WASM tier (no regex), `opt-level=3`, LTO, `wasm-opt -O4`
- Runtime: @import-validator/node (same engine the browser worker runs)

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
| 100k rows, clean | 10.0 MB | 175 ms | 571,849 rows/s · 57.0 MB/s | 0 |
| 100k rows, 5% dirty | 9.9 MB | 177 ms | 565,534 rows/s · 56.3 MB/s | 5,493 |
| 1M rows, clean | 102.7 MB | 2,199 ms | 454,664 rows/s · 46.7 MB/s | 0 |
| 1M rows, 5% dirty | 102.5 MB | 1,875 ms | 533,395 rows/s · 54.7 MB/s | 55,116 |

Browser numbers track these closely: the Web Worker runs the identical WASM
binary; expect a few percent overhead from chunked File reads and message
passing. The demo's metrics panel reports live rows/s for any file you drop in.

Reproduce:

```bash
pnpm run build   # build WASM + packages
pnpm run bench   # rewrites this file with your machine's numbers
```
