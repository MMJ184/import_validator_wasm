# Node.js Integration Guide

Server-side CSV + Excel validation with `@import-validator/node` (Node 20+).
Runs the WASM engine in-process — no worker, no native library needed.

## Install

From the customer kit:

```bash
npm i ./packages/import-validator-core-<version>.tgz \
      ./packages/import-validator-node-<version>.tgz
```

## Quick start — CSV

```js
import { init, validateFile } from "@import-validator/node";

const schema = {
    hasHeaders: true,
    columns: [
        { name: "id", type: "int", required: true, unique: true },
        { name: "email", type: "email", required: true,
          modifiers: { trim: true, lowercase: true } },
    ],
};

await init();                      // optional warmup (auto-runs on first use)
const result = await validateFile("uploads/data.csv", schema);

console.log(result.valid, result.rowsProcessed);
for (const e of result.errors) {
    // e.row, e.colIndex, e.columnName, e.code, e.codeString, e.message
    console.log(e.message);       // Row 7, column "email": invalid email format
}
```

Also available: `validateBuffer(bufferOrUint8Array, schema, opts)` and
`validateStream(asyncIterable, schema, opts)` (multipart uploads, sockets).

## Excel (.xlsx)

```js
import { validateXlsxFile, validateXlsxBuffer } from "@import-validator/node";

const result = await validateXlsxFile("uploads/data.xlsx", schema);
```

Same schema, same error codes, same normalized output as CSV. The first
worksheet is validated; the sheet streams through zlib into the engine, so
memory stays flat regardless of sheet size. `validateXlsxStream` exists but
buffers the whole stream (ZIP directories live at the end of the file) —
prefer `validateXlsxFile` for large uploads you have persisted to disk.

## Options (`NodeValidateOptions`)

| Option | Default | Meaning |
|---|---|---|
| `maxErrors` | 10 000 | Stop accumulating errors after this many |
| `emitNormalized` | false | Collect normalized CSV bytes (`result.normalized`) |
| `chunkSize` | auto | Byte chunk size for streaming reads |
| `onProgress` | — | `({rowsProcessed, errorsAdded})` per chunk |
| `signal` | — | `AbortSignal` to cancel mid-stream |
| `wasmUrl` | bundled | Path override for the `.wasm` binary |

## Result shape

`{ errors: DecodedError[], schemaColumns, inputColumns, normalized?,
rowsProcessed, valid }` — `DecodedError` carries `row` (1-based, 0 = header),
`colIndex`, `colKind` (`schema|input`), `columnName`, `code`, `codeString`,
`message`.

## Full server example

`examples/node_server/` — Express + busboy with streaming CSV validation and
an XLSX endpoint, runnable with its own README.

More: schema contract → [../SCHEMA_REFERENCE.md](../SCHEMA_REFERENCE.md) ·
tuning → [../PERFORMANCE.md](../PERFORMANCE.md) ·
failures → [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
