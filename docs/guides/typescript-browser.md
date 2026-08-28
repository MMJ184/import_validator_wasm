# Browser (TypeScript / JavaScript) Integration Guide

**import-validator-wasm** — high-performance CSV and Excel validation in the browser, powered by a Rust/WebAssembly core running inside a Web Worker.

---

## What You Receive

The customer kit (`import-validator-kit-v<version>.zip`) contains:

```
packages/
  import-validator-core-<version>.tgz     ← WASM loader + Engine API
  import-validator-worker-<version>.tgz   ← Worker package (types + bundled worker)
  import-validator-sdk-<version>.tgz      ← Browser SDK (createValidator)
  import-validator-node-<version>.tgz     ← Optional: Node.js server-side wrapper
static/
  worker.js                               ← Self-contained Web Worker (no bundler needed)
  import_validator_wasm_bg.wasm           ← WASM engine binary
docs/
  INDEX.md                                ← Documentation map (start here)
  guides/                                 ← Per-language guides (TS, Node, Python, C#, Go, Rust)
  SCHEMA_REFERENCE.md                     ← Full schema field reference
  SDK_API.md                              ← SDK API, events, fatal-code reference
  PERFORMANCE.md + BENCHMARKS.md          ← Numbers and tuning
  TROUBLESHOOTING.md · CHANGELOG.md       ← Failure playbook, release notes
  CUSTOMER_DISTRIBUTION.md                ← Asset hosting and deployment guide
  NATIVE_CLIENTS.md                       ← Native-library hub (prebuilt binaries)
  validation-config.schema.json           ← Machine-readable schema contract
  customer-profiles.json                  ← Example tenant configurations
LICENSE
manifest.json                             ← Version, git SHA, contents
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Modern browser | Chrome 90+, Edge 90+, Safari 15+, Firefox 114+ |
| Module Worker support | Required — validation runs off the main thread |
| HTTPS or localhost | Required for WebAssembly |
| Bundler | Optional — static hosting works without one |

---

## 1. Install the SDK

Install all package tarballs **in a single command** so they resolve each other:

```bash
npm install ./packages/import-validator-core-0.2.0.tgz \
            ./packages/import-validator-worker-0.2.0.tgz \
            ./packages/import-validator-sdk-0.2.0.tgz
# or with pnpm: pnpm add ./packages/...(same three files)
```

> Server-side validation in Node.js? Also install `import-validator-node-<version>.tgz`
> and see `docs/NATIVE_CLIENTS.md`.

---

## 2. Host the Static Assets

Copy these two files from `static/` to a path your app serves (e.g. `/assets/`):

| File | Purpose |
|---|---|
| `worker.js` | Self-contained Web Worker — no bundling required |
| `import_validator_wasm_bg.wasm` | WASM engine binary |

They **must** be served from the same origin as your app (or with correct CORS headers).

---

## 3. Minimal Integration

```ts
import { createValidator } from "@import-validator/sdk";

let shownErrors = 0;

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
      shownErrors += errors.length;
      for (const e of errors) {
        // e.row, e.columnName, e.codeString, e.message
        console.warn(e.message);
      }
    },
    onDone: (errorsSuppressed = 0) => {
      // Every row is always validated; maxErrors only caps how many errors are
      // delivered, so add the suppressed count back for the true total.
      console.log(
        `Validation complete — showing ${shownErrors} of ${shownErrors + errorsSuppressed}`
      );
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
  // concatChunks is exported by @import-validator/sdk
  const csv = new TextDecoder().decode(concatChunks(parts));
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

## 11. Cancel and Fatal Errors

Cancel an in-flight validation without killing the worker:

```ts
validator.cancel();   // → onFatal with fatal.code === "CANCELLED" (retryable)
```

All unrecoverable errors arrive via `onFatal(message, fatal)`. Always branch
on `fatal.code` — the canonical table of all 11 codes (meaning, phase,
retryability) lives in [SDK_API.md](../SDK_API.md). The ones every UI should
handle explicitly: `FILE_TOO_LARGE`, `ROWS_LIMIT_EXCEEDED`, `TIMEOUT`,
`CANCELLED`.

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
