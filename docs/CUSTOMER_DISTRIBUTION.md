# Customer Distribution And Integration Guide

This is the exact handoff package and integration flow for customers.

## Generating The Kit

```bash
pnpm run verify          # build + typecheck gate
pnpm run dist:customer   # assemble + zip
```

Output:

- `artifacts/customer-kit/` — kit folder (inspectable)
- `artifacts/import-validator-kit-v<version>.zip` — the file you hand to the customer

## What The Customer Receives

```
packages/
  import-validator-core-<version>.tgz     ← installable npm tarball
  import-validator-worker-<version>.tgz   ← installable npm tarball
  import-validator-sdk-<version>.tgz      ← installable npm tarball
  import-validator-node-<version>.tgz     ← optional Node.js server wrapper
static/
  worker.js                               ← self-contained module worker (no bundler needed)
  import_validator_wasm_bg.wasm           ← WASM engine binary
docs/                                     ← quickstart, schema reference, SDK API, this guide
LICENSE
manifest.json                             ← product version, git SHA, contents
```

The worker bundle is fully self-contained (all `@import-validator/*` code inlined).
It is verified at kit-build time: the kit script fails if `worker.js` still
contains bare module specifiers.

## Customer Install

All tarballs in **one command** so they satisfy each other's dependencies:

```bash
npm install ./packages/import-validator-core-<version>.tgz \
            ./packages/import-validator-worker-<version>.tgz \
            ./packages/import-validator-sdk-<version>.tgz
```

## What Customer Must Know

1. Supported file formats:
- CSV (`.csv`)
- Excel OpenXML (`.xlsx`)
- Legacy `.xls` is rejected by design.

2. Validation flow options:
- `estimate=true`: estimate pass first, then full validate.
- `estimateOnly=true`: estimate pass only (no validate pass).

3. Structured fatal errors are returned:
- Callback signature: `onFatal(message, fatal)`
- `fatal.code` values include:
  - `FILE_TOO_LARGE`
  - `ROWS_LIMIT_EXCEEDED`
  - `COLUMNS_LIMIT_EXCEEDED`
  - `TIMEOUT`
  - `WASM_RUNTIME`
  - `EXCEL_ROUTE_DISABLED`
  - `VALIDATION_FAILED`

4. Runtime config contract is defined in:
- `validation-config.schema.json`

## Customer Integration (Browser App)

Minimal integration:

```ts
import { createValidator } from "@import-validator/sdk";

const validator = createValidator(
  {
    schema: customerSchema,
    wasmUrl: "/assets/import_validator_wasm_bg.wasm",
    workerUrl: "/assets/worker.js",
    maxErrors: 10000
  },
  {
    onEstimate: (rows, avgBytesPerRow, columns) => {
      console.log("estimate", { rows, avgBytesPerRow, columns });
    },
    onProgress: (p) => {
      console.log("progress", p.rowsProcessed, p.errorsAdded);
    },
    onErrors: (errs) => {
      // Example display: Row 98125, column "id": invalid type
      console.log(errs.map((e) => e.message));
    },
    onFatal: (_message, fatal) => {
      console.error("fatal", fatal?.code, fatal?.message, fatal?.details);
    },
    onDone: () => {
      console.log("done");
    }
  }
);

validator.validate(file, {
  format: "auto",
  estimate: true,
  estimateOnly: false,
  maxFileBytes: 200 * 1024 * 1024,
  maxRowsEstimate: 2_000_000,
  maxColumns: 500,
  timeoutMs: 120_000,
  maxErrorRowsToShow: 200
});
```

## Assets Customer Must Host

At minimum, from the kit's `static/` folder:

- `worker.js`
- `import_validator_wasm_bg.wasm`

And set URLs in SDK:

- `workerUrl`: hosted worker JS path
- `wasmUrl`: hosted WASM path

Both must be same-origin with the app (or served with correct CORS headers).
Bundler users (Vite) can skip static hosting and use the URL helpers instead —
see `CLIENT_QUICKSTART.md` §10.

## Recommended Customer Defaults

- `profile: "balanced"`
- `estimate: true` for large files
- `estimateOnly: true` for preflight checks in upload UI
- `maxErrorRowsToShow: 200` for clean UX
- `timeoutMs`: 60_000 to 180_000 depending on SLA

## Support Checklist (Before Go-Live)

1. Validate one small file (`100` rows), one medium (`10,000`), one large (`1,000,000+`).
2. Confirm fatal codes are mapped in customer UI/API logs.
3. Confirm `.xlsx` works and `.xls` gives clear rejection message.
4. Confirm limits (`maxFileBytes`, `maxRowsEstimate`) match customer plan.
5. Record the kit `manifest.json` version + git SHA in your support tracker.
