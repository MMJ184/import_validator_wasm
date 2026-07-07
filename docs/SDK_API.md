# SDK API Reference

Package: `@import-validator/sdk`

---

## `createValidator(options, events?)`

Creates a `ValidatorClient` and immediately spawns the background Web Worker.

```ts
import { createValidator } from "@import-validator/sdk";

const validator = createValidator(options, events);
```

Returns a `ValidatorClient` instance. The worker starts initializing immediately.

---

## `ValidatorOptions`

Passed as the first argument to `createValidator()`. Set once per validator instance.

| Field | Type | Required | Description |
|---|---|---|---|
| `schema` | `object` | ✅ | Validation schema (see Schema Reference) |
| `wasmUrl` | `string \| URL` | ✅ | URL to the hosted `.wasm` file |
| `workerUrl` | `string \| URL` | ✅* | URL to the hosted worker JS file |
| `workerFactory` | `() => Worker` | ✅* | Alternative: provide a Worker constructor |
| `maxErrors` | `number` | — | Max errors the engine stores (default: auto by file size) |
| `emitNormalized` | `boolean` | — | Emit normalized CSV output (default: auto by file size) |
| `profile` | `"fast" \| "balanced" \| "strict"` | — | Default runtime profile (default: `"balanced"`) |
| `schemaVersion` | `number` | — | Schema contract version (default: `1`) |

*Either `workerUrl` or `workerFactory` is required.

### Profiles

| Profile | `estimate` default | `maxPostErrorsTotal` | `postErrorBatch` |
|---|---|---|---|
| `fast` | `false` | 10,000 | 2,000 |
| `balanced` | `false` | 50,000 | 2,000 |
| `strict` | `true` | 100,000 | 1,000 |

---

## `ValidatorEvents`

Passed as the second argument to `createValidator()`. All callbacks are optional.

### `onReady(columns: string[])`

Fired once when the worker has initialized the engine and parsed the schema. `columns` is the ordered list of schema column names.

You can call `validate()` before `onReady` — it will queue and fire automatically.

### `onEstimate(rows: number, avgBytesPerRow: number, columns?: number)`

Fired after the estimate pass (requires `estimate: true` in `ValidateFileOptions`).

- `rows` — estimated data row count (excludes header)
- `avgBytesPerRow` — file size / rows (use to estimate from file.size)
- `columns` — detected column count

### `onProgress(p: Progress)`

Fired periodically during validation.

```ts
type Progress = {
  rowsProcessed: number;  // rows processed in this batch
  errorsAdded: number;    // errors added in this batch
  done: boolean;          // true only on final flush
};
```

Progress is coalesced: fires when `progressFlushRows` rows have accumulated **or** `progressFlushIntervalMs` ms have elapsed. Defaults: 5,000 rows / 120 ms.

### `onErrors(errors: DecodedError[])`

Fired with batches of decoded validation errors.

```ts
type DecodedError = {
  row: number;           // 1-based data row; 0 = header row
  code: number;          // numeric error code
  codeString: string;    // e.g. "InvalidType", "MissingRequired"
  colIndex: number;      // column index
  colKind: "schema" | "input";
  columnName?: string;   // column name from schema or input header
  message: string;       // human-readable message
};
```

Errors are batched (controlled by `postErrorBatch`) and capped by `maxPostErrorsTotal`.

### `onMetrics(m: ValidationMetrics)`

Fired once after `onDone`, with full timing and throughput data.

```ts
type ValidationMetrics = {
  format: "csv" | "excel";
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  rowsProcessed: number;
  errorsPosted: number;
  fileSizeBytes: number;
  rowsPerSec: number;
  dryRun: boolean;
};
```

### `onNormalized(chunk: Uint8Array)`

Fired with chunks of normalized CSV bytes. Only fires if `emitNormalized: true` was set. Reassemble with `concatChunks` (exported from `@import-validator/sdk`):
`new TextDecoder().decode(concatChunks(parts))`.

### `onDone()`

Fired when validation is complete (or when `estimateOnly: true` completes the estimate pass).

### `onFatal(message: string, fatal?: ValidationFatal)`

Fired on any unrecoverable error. Always handle this callback in production.

```ts
type ValidationFatal = {
  code: ValidationFatalCode;   // stable machine-readable code
  message: string;
  details?: string;
  retryable: boolean;
  phase: "init" | "estimate" | "validate";
  format?: "csv" | "excel";
  fileName?: string;
  fileSizeBytes?: number;
};
```

---

## `validator.validate(file, options?)`

Start validation of a `File` object. Can be called before `onReady` fires (queued automatically).

```ts
validator.validate(file, options?: ValidateFileOptions);
```

### `ValidateFileOptions`

Per-file overrides. All fields optional.

| Field | Type | Description |
|---|---|---|
| `format` | `"auto" \| "csv" \| "excel"` | Force format (default: `"auto"` = detect by extension) |
| `profile` | `"fast" \| "balanced" \| "strict"` | Override profile for this file |
| `estimate` | `boolean` | Run estimate pass before validate |
| `estimateOnly` | `boolean` | Run estimate only, skip validate |
| `maxErrors` | `number` | Override max errors for this file |
| `emitNormalized` | `boolean` | Override normalized output for this file |
| `maxPostErrorsTotal` | `number` | Cap total errors sent to `onErrors` |
| `postErrorBatch` | `number` | Errors per `onErrors` call |
| `maxErrorRowsToShow` | `number` | Limit `onErrors` to at most N distinct rows |
| `progressFlushRows` | `number` | Min rows between `onProgress` calls |
| `progressFlushIntervalMs` | `number` | Min ms between `onProgress` calls |
| `chunkSize` | `number` | Override chunk size in bytes (advanced) |
| `estimateChunkSize` | `number` | Override chunk size for estimate pass only |
| `dryRunRows` | `number` | Stop after N rows (dry run preview) |
| `maxFileBytes` | `number` | Reject file if larger than this (bytes) |
| `maxRowsEstimate` | `number` | Reject if estimated rows exceed this |
| `maxColumns` | `number` | Reject if column count exceeds this |
| `timeoutMs` | `number` | Abort worker after this many milliseconds |

---

## `validator.terminate()`

Terminates the Web Worker immediately. Call when the validator is no longer needed.

---

## `buildErrorReportCsv(errors)`

Utility to convert collected `DecodedError[]` to a downloadable CSV string.

```ts
import { buildErrorReportCsv } from "@import-validator/sdk";

const csv = buildErrorReportCsv(allErrors);
// Columns: row, colKind, colIndex, columnName, code, codeString, message
```

---

## Vite URL Helpers

```ts
import { defaultWorkerUrl } from "@import-validator/sdk/vite";
import { defaultWasmUrl } from "@import-validator/core";

// These resolve at Vite build time — no manual asset copying needed.
createValidator({ workerUrl: defaultWorkerUrl, wasmUrl: defaultWasmUrl, ... });
```

---

## Event Order

For a successful validation with estimate:

```
onReady → onEstimate → onProgress (×N) → onErrors (×N) → onMetrics → onDone
```

For a fatal error:

```
onReady → onFatal
```

For `estimateOnly: true`:

```
onReady → onEstimate → onDone
```
