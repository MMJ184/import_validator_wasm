# Client Quick Start Guide

**import-validator-wasm** — high-performance CSV and Excel validation in the browser, powered by a Rust/WebAssembly core running inside a Web Worker.

---

## What You Receive

After running `pnpm run dist:customer`, the `artifacts/customer-kit/` folder contains:

```
packages/
  core-dist/          ← WASM loader + Engine API
  worker-dist/        ← Web Worker bundle (worker.js + .wasm file)
  sdk-dist/           ← Browser SDK (createValidator)
docs/
  validation-config.schema.json   ← Full schema contract reference
  customer-profiles.json          ← Example tenant schemas
  CUSTOMER_DISTRIBUTION.md        ← This integration guide (short form)
manifest.json
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Modern browser | Chrome 90+, Firefox 90+, Safari 15+, Edge 90+ |
| Web Worker support | Required — validation runs off the main thread |
| HTTPS or localhost | Required for WebAssembly |
| Bundler | Vite (recommended), Webpack 5, Rollup, or static hosting |

---

## 1. Host the Assets

Copy these two files to a path your app can reach (e.g. `/assets/`):

| File | Source path in kit |
|---|---|
| `worker.js` | `worker-dist/worker.js` |
| `import_validator_wasm_bg.wasm` | `core-dist/wasm/pkg/import_validator_wasm_bg.wasm` |

They **must** be served from the same origin as your app (or with correct CORS headers).

---

## 2. Install the SDK

If installing from the kit as local packages:

```bash
npm install ./sdk-dist ./core-dist ./worker-dist
# or with pnpm
pnpm add ./sdk-dist ./core-dist ./worker-dist
```

---

## 3. Minimal Integration

```ts
import { createValidator } from "@import-validator/sdk";

const validator = createValidator(
  {
    schema: mySchema,                                        // your validation schema
    wasmUrl: "/assets/import_validator_wasm_bg.wasm",       // hosted WASM path
    workerUrl: "/assets/worker.js",                         // hosted worker path
    maxErrors: 10_000,
  },
  {
    onReady: (columns) => {
      console.log("Schema columns:", columns);
      // safe to call validate() now (or call it before ready — it will queue)
    },
    onProgress: (p) => {
      console.log(`Rows processed: ${p.rowsProcessed}, errors: ${p.errorsAdded}`);
    },
    onErrors: (errors) => {
      for (const e of errors) {
        // e.row, e.columnName, e.codeString, e.message
        console.warn(e.message);
      }
    },
    onDone: () => {
      console.log("Validation complete");
      validator.terminate(); // release the worker
    },
    onFatal: (message, fatal) => {
      console.error(`[${fatal?.code}] ${message}`);
    },
  }
);

// Call after user picks a file
validator.validate(file);
```

---

## 4. Validate Options

```ts
validator.validate(file, {
  format: "auto",               // "auto" | "csv" | "excel" — auto detects by extension
  profile: "balanced",          // "fast" | "balanced" | "strict"
  estimate: true,               // run row/column estimate pass first (triggers onEstimate)
  estimateOnly: false,          // run estimate only, skip full validate (preflight check)

  // Safety guardrails (all optional but recommended for production)
  maxFileBytes: 200 * 1024 * 1024,   // reject files over 200 MB
  maxRowsEstimate: 2_000_000,         // reject if estimated rows exceed this
  maxColumns: 500,                    // reject if column count exceeds this
  timeoutMs: 120_000,                 // abort after 2 minutes

  // Error display limits
  maxPostErrorsTotal: 20_000,         // cap total errors sent to UI
  maxErrorRowsToShow: 200,            // cap unique error rows shown in UI
});
```

---

## 5. Estimate Pass (Optional but Recommended)

Pass `estimate: true` to get a row/column count before validation starts. Useful for showing a progress bar or warning the user about large files.

```ts
// In ValidatorEvents:
onEstimate: (rows, avgBytesPerRow, columns) => {
  console.log(`~${rows.toLocaleString()} data rows, ${columns} columns`);
  // avgBytesPerRow lets you estimate rows from file.size if needed:
  // estimatedRows = file.size / avgBytesPerRow
},
```

For a "can this file be handled?" preflight without full validation, use `estimateOnly: true`.

---

## 6. Metrics

After validation completes, `onMetrics` fires with timing and throughput data:

```ts
onMetrics: (m) => {
  console.log(`${m.rowsPerSec.toLocaleString()} rows/sec over ${m.elapsedMs} ms`);
  console.log(`Format: ${m.format}, Dry run: ${m.dryRun}`);
},
```

---

## 7. Normalized Output

The validator can emit a cleaned, normalized version of the CSV (with modifiers applied). Enable with `emitNormalized: true` and collect chunks:

```ts
const parts: Uint8Array[] = [];

// In ValidatorEvents:
onNormalized: (chunk) => {
  parts.push(chunk);
},
onDone: () => {
  const csv = new TextDecoder().decode(concatU8(parts));
  // offer csv as a download
},

// In ValidatorOptions:
// emitNormalized: true  (set at construction)
```

> Normalized output is automatically disabled for files over 20 MB to avoid memory pressure.

---

## 8. Error Report CSV

```ts
import { buildErrorReportCsv } from "@import-validator/sdk";

const allErrors: DecodedError[] = [];

// Collect in onErrors:
onErrors: (batch) => allErrors.push(...batch),

// After onDone:
const csv = buildErrorReportCsv(allErrors);
// Columns: row, colKind, colIndex, columnName, code, codeString, message
```

---

## 9. Terminate / Reuse

Each `createValidator()` call spawns one Worker. Terminate it when done to free memory:

```ts
validator.terminate();
```

To validate multiple files, create a new `ValidatorClient` for each file (or reuse by calling `validate()` again — the worker queues requests).

---

## 10. Vite Integration

For Vite projects, use the bundler-native URL helpers (resolves worker and WASM URLs at build time):

```ts
import { createValidator } from "@import-validator/sdk";
import { defaultWorkerUrl } from "@import-validator/sdk/vite";
import { defaultWasmUrl } from "@import-validator/core";

const validator = createValidator({
  schema: mySchema,
  wasmUrl: defaultWasmUrl,
  workerUrl: defaultWorkerUrl,
});
```

---

## 11. Fatal Error Codes

All unrecoverable errors arrive via `onFatal(message, fatal)`. Always check `fatal.code`:

| Code | Meaning | Retryable |
|---|---|---|
| `FILE_TOO_LARGE` | File exceeds `maxFileBytes` | No |
| `ROWS_LIMIT_EXCEEDED` | Estimated rows exceed `maxRowsEstimate` | No |
| `COLUMNS_LIMIT_EXCEEDED` | Column count exceeds `maxColumns` | No |
| `TIMEOUT` | `timeoutMs` expired | Yes |
| `WASM_RUNTIME` | Internal WASM crash | Yes |
| `SCHEMA_VERSION_UNSUPPORTED` | Schema contract version mismatch | No |
| `WASM_URL_REQUIRED` | `wasmUrl` not provided | No |
| `ENGINE_NOT_INITIALIZED` | `init` not sent before `validate` | No |
| `EXCEL_ROUTE_DISABLED` | `.xlsx` not supported in this build | No |
| `VALIDATION_FAILED` | Unclassified error | No |

---

## 12. Supported File Formats

| Format | Extension | Notes |
|---|---|---|
| CSV | `.csv` | Any delimiter (default `,`), UTF-8 + BOM |
| Excel OpenXML | `.xlsx` | Full support |
| Legacy Excel | `.xls` | **Rejected** — convert to `.xlsx` or `.csv` |

---

## Recommended Production Defaults

```ts
// ValidatorOptions
{
  maxErrors: 10_000,
  profile: "balanced",
}

// ValidateFileOptions
{
  estimate: true,
  maxFileBytes: 200 * 1024 * 1024,   // 200 MB
  maxRowsEstimate: 2_000_000,
  maxColumns: 500,
  timeoutMs: 120_000,
  maxPostErrorsTotal: 20_000,
  maxErrorRowsToShow: 200,
}
```
