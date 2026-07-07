/**
 * Node.js Express server — CSV + Excel (XLSX) validation via @import-validator/node.
 *
 * Prerequisites (from the repo root):
 *   pnpm --filter @import-validator/core run build:wasm
 *   pnpm --filter @import-validator/core run build:pkg
 *   pnpm --filter @import-validator/node run build
 *   pnpm install --ignore-workspace   (in this directory; installs express + busboy)
 *
 * Run:
 *   node server.mjs
 *
 * Endpoints:
 *   POST /validate          multipart form-data: field 'file' (CSV) + 'schema' (JSON string)
 *   POST /validate/buffer   JSON body: { "csv": "<base64>", "schema": {...} }
 *   POST /validate-xlsx     multipart form-data: field 'file' (.xlsx) + 'schema' (JSON string)
 */

import { Buffer } from "node:buffer";
import express from "express";
import busboy from "busboy";

// Resolve the workspace packages from the monorepo root.
// In a standalone project, replace with the published package names.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point to the workspace-local built packages.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { validateBuffer, validateStream, validateXlsxBuffer, init } = await import(
    path.join(REPO_ROOT, "packages/node/dist/index.js")
);

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Warm up the WASM engine at startup ───────────────────────────────────────
await init();
console.log("WASM engine initialised.");

// ── POST /validate  (multipart, streaming CSV) ───────────────────────────────
//
// busboy v1 semantics: 'close' only fires after every file stream has been
// fully consumed, so validation must start the moment the file part appears —
// waiting for 'close' before reading the stream would deadlock. That in turn
// requires the 'schema' field to arrive BEFORE the file part (fields-before-
// files is the standard rule for streaming multipart; curl -F keeps the
// argument order).
app.post("/validate", (req, res) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });

    let schema = null;
    let schemaError = null;
    let validationPromise = null;
    let responded = false;

    const fail = (status, error) => {
        if (responded) return;
        responded = true;
        res.status(status).json({ error });
    };

    bb.on("field", (name, value) => {
        if (name !== "schema") return;
        try {
            schema = JSON.parse(value);
        } catch (e) {
            schemaError = `Invalid schema JSON: ${e.message}`;
        }
    });

    bb.on("file", (name, stream) => {
        if (name !== "file") return stream.resume();
        if (schemaError) {
            fail(400, schemaError);
            return stream.resume(); // drain so busboy can finish the request
        }
        if (!schema) {
            fail(400, "Send the 'schema' field before the 'file' part");
            return stream.resume();
        }

        // stream is a Node.js Readable — validateStream accepts AsyncIterable<Uint8Array>.
        async function* toUint8Chunks(readable) {
            for await (const chunk of readable) {
                yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            }
        }

        validationPromise = validateStream(toUint8Chunks(stream), schema, {
            maxErrors: 10_000,
        });
        // If validation aborts early, drain the rest of the upload so busboy
        // still reaches 'close' and the error response below can be sent.
        validationPromise.catch(() => stream.resume());
    });

    bb.on("close", async () => {
        if (responded) return;
        if (!validationPromise) {
            return fail(400, schemaError ?? (schema ? "Missing 'file' field" : "Missing 'schema' field"));
        }
        try {
            const result = await validationPromise;
            responded = true;
            res.json(formatResult(result));
        } catch (err) {
            fail(422, err.message);
        }
    });

    req.pipe(bb);
});

// ── POST /validate/buffer  (JSON + base64) ────────────────────────────────────
app.post("/validate/buffer", async (req, res) => {
    const { csv, schema } = req.body ?? {};
    if (!csv)    return res.status(400).json({ error: "Missing 'csv' field" });
    if (!schema) return res.status(400).json({ error: "Missing 'schema' field" });

    let csvBuf;
    try {
        csvBuf = Buffer.from(csv, "base64");
    } catch (e) {
        return res.status(400).json({ error: `Invalid base64: ${e.message}` });
    }

    try {
        const result = await validateBuffer(csvBuf, schema, { maxErrors: 10_000 });
        res.json(formatResult(result));
    } catch (err) {
        res.status(422).json({ error: err.message });
    }
});

// ── POST /validate-xlsx  (multipart, Excel .xlsx) ─────────────────────────────
//
// Unlike the CSV route, the upload is buffered fully in memory before
// validation starts. XLSX is a ZIP container and the ZIP central directory —
// the index needed to locate the worksheet and shared-strings entries — sits
// at the END of the file, so the validator needs random access over the whole
// container; a forward-only multipart stream cannot be fed to it chunk by
// chunk. For large workbooks, prefer saving the upload to disk and calling
// validateXlsxFile(path, schema): it random-accesses the file and inflates the
// worksheet in streaming chunks instead of holding the whole ZIP in memory.
app.post("/validate-xlsx", (req, res) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });

    let schemaStr = "";
    const fileChunks = [];
    let sawFile = false;

    bb.on("field", (name, value) => {
        if (name === "schema") schemaStr = value;
    });

    bb.on("file", (name, stream) => {
        if (name === "file") {
            sawFile = true;
            // Consuming via 'data' buffers the upload and lets busboy reach
            // 'close' (see the ZIP note above for why buffering is required).
            stream.on("data", (chunk) => fileChunks.push(chunk));
        } else {
            stream.resume();
        }
    });

    bb.on("close", async () => {
        if (!schemaStr) {
            return res.status(400).json({ error: "Missing 'schema' field" });
        }
        if (!sawFile) {
            return res.status(400).json({ error: "Missing 'file' field" });
        }

        let schema;
        try {
            schema = JSON.parse(schemaStr);
        } catch (e) {
            return res.status(400).json({ error: `Invalid schema JSON: ${e.message}` });
        }

        try {
            const xlsxBuf = Buffer.concat(fileChunks);
            const result = await validateXlsxBuffer(xlsxBuf, schema, { maxErrors: 10_000 });
            res.json(formatResult(result));
        } catch (err) {
            res.status(422).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

// ── Helper ───────────────────────────────────────────────────────────────────
function formatResult(result) {
    return {
        valid: result.valid,
        errorCount: result.errors.length,
        rowsProcessed: result.rowsProcessed,
        errors: result.errors.map((e) => ({
            row:      e.row,
            col:      e.colIndex,
            column:   e.columnName,
            kind:     e.colKind,
            code:     e.code,
            codeName: e.codeString,
            message:  e.message,
        })),
        schemaColumns: result.schemaColumns,
        inputColumns:  result.inputColumns,
    };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ImportValidator Node.js server listening on http://localhost:${PORT}`);
});
