/**
 * Node.js Express server — CSV validation via @import-validator/node.
 *
 * Prerequisites:
 *   pnpm --filter @import-validator/core run build:wasm
 *   pnpm --filter @import-validator/core run build:pkg
 *   pnpm --filter @import-validator/node run build
 *   npm install express busboy   (in this directory)
 *
 * Run:
 *   node server.mjs
 *
 * Endpoints:
 *   POST /validate          multipart form-data: field 'file' (CSV) + 'schema' (JSON string)
 *   POST /validate/buffer   JSON body: { "csv": "<base64>", "schema": {...} }
 */

import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import express from "express";
import busboy from "busboy";

// Resolve the workspace packages from the monorepo root.
// In a standalone project, replace with the published package names.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Point to the workspace-local built packages.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { validateBuffer, validateStream, init } = await import(
    path.join(REPO_ROOT, "packages/node/dist/index.js")
);

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Warm up the WASM engine at startup ───────────────────────────────────────
await init();
console.log("WASM engine initialised.");

// ── POST /validate  (multipart) ───────────────────────────────────────────────
app.post("/validate", (req, res) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });

    let schemaStr = "";
    let csvStream = null;
    let schemaReady = false;

    bb.on("field", (name, value) => {
        if (name === "schema") schemaStr = value;
    });

    bb.on("file", (name, stream) => {
        if (name === "file") csvStream = stream;
        else stream.resume();
    });

    bb.on("finish", async () => {
        if (!schemaStr) {
            return res.status(400).json({ error: "Missing 'schema' field" });
        }
        if (!csvStream) {
            return res.status(400).json({ error: "Missing 'file' field" });
        }

        let schema;
        try {
            schema = JSON.parse(schemaStr);
        } catch (e) {
            return res.status(400).json({ error: `Invalid schema JSON: ${e.message}` });
        }

        try {
            // csvStream is a Node.js Readable — validateStream accepts AsyncIterable<Uint8Array>
            async function* toUint8Chunks(readable) {
                for await (const chunk of readable) {
                    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                }
            }

            const result = await validateStream(toUint8Chunks(csvStream), schema, {
                maxErrors: 10_000,
            });

            res.json(formatResult(result));
        } catch (err) {
            res.status(422).json({ error: err.message });
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
