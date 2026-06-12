/**
 * @import-validator/node
 *
 * Server-side CSV validation for Node.js 20+.
 * Runs the WASM engine directly on the main thread — no Web Worker needed.
 *
 * Quick start:
 *   import { validateFile, validateBuffer, init } from "@import-validator/node";
 *
 *   const schema = { hasHeaders: true, columns: [...] };
 *   const result = await validateFile("data.csv", schema);
 *   if (!result.valid) console.log(result.errors);
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
    initWasm,
    Engine,
    validateCsv,
    chooseChunkSizeSmart,
} from "@import-validator/core";

// Re-export useful types and the low-level Engine for advanced users.
export { Engine } from "@import-validator/core";
export type {
    DecodedError,
    Progress,
    PackedError,
    ValidateCsvOptions,
} from "@import-validator/core";

// ── Options & result types ────────────────────────────────────────────────────

export interface NodeValidateOptions {
    /** Maximum errors to accumulate before stopping (default: 10 000). */
    maxErrors?: number;
    /** Collect normalised CSV output (default: false). */
    emitNormalized?: boolean;
    /** Override chunk size in bytes. Auto-selected from file size when omitted. */
    chunkSize?: number;
    /** Called after every chunk with running totals. */
    onProgress?: (p: { rowsProcessed: number; errorsAdded: number }) => void;
    /** AbortSignal to cancel mid-stream. */
    signal?: AbortSignal;
    /**
     * Override the WASM URL / file path.
     * Leave unset to use the default URL resolved from @import-validator/core.
     */
    wasmUrl?: string | URL;
}

export interface ValidationResult {
    /** All decoded validation errors with row, column, and human message. */
    errors: import("@import-validator/core").DecodedError[];
    /** Schema column names in schema order. */
    schemaColumns: string[];
    /** Input CSV header names (empty when hasHeaders: false). */
    inputColumns: string[];
    /** Normalised CSV bytes (only when emitNormalized: true). */
    normalized?: Uint8Array;
    /** Total data rows processed. */
    rowsProcessed: number;
    /** True when there are zero validation errors. */
    valid: boolean;
}

// ── WASM initialization ───────────────────────────────────────────────────────

let _initPromise: Promise<void> | null = null;

/**
 * Initialise the WASM engine.
 *
 * Called automatically by validate* functions on first use.
 * Call it explicitly at server startup to avoid the init latency on the
 * first request.
 *
 * @param wasmUrl  Optional path/URL override for the .wasm binary.
 *                 Defaults to the binary bundled with @import-validator/core.
 */
export async function init(wasmUrl?: string | URL): Promise<void> {
    if (!_initPromise) {
        _initPromise = initWasm(wasmUrl).then(() => undefined);
    }
    await _initPromise;
}

async function ensureInit(wasmUrl?: string | URL) {
    if (!_initPromise) await init(wasmUrl);
    else await _initPromise;
}

// ── Core validation runner ────────────────────────────────────────────────────

async function run(
    source: AsyncIterable<Uint8Array>,
    schema: object,
    opts: NodeValidateOptions
): Promise<ValidationResult> {
    const { maxErrors = 10_000, emitNormalized = false, wasmUrl, signal, onProgress } = opts;

    await ensureInit(wasmUrl);

    const engine = await Engine.create(schema, maxErrors, emitNormalized);

    const result = await validateCsv(engine, source as AsyncIterable<Uint8Array>, {
        decodeErrors: true,
        drainNormalized: emitNormalized,
        signal,
        onProgress,
    });

    return {
        errors: result.errorsDecoded ?? [],
        schemaColumns: engine.schemaColumns(),
        inputColumns: engine.inputColumns(),
        normalized: result.normalized,
        rowsProcessed: result.progress.rowsProcessed,
        valid: (result.errorsDecoded?.length ?? 0) === 0,
    };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate a CSV file on disk.
 *
 * Reads the file in streaming chunks — memory stays flat regardless of
 * file size.
 *
 * @example
 * const result = await validateFile("uploads/data.csv", schema);
 * if (!result.valid) result.errors.forEach(e => console.log(e.message));
 */
export async function validateFile(
    filePath: string,
    schema: object,
    opts: NodeValidateOptions = {}
): Promise<ValidationResult> {
    let fileSize: number | undefined;
    try {
        fileSize = (await stat(filePath)).size;
    } catch { /* stream will still work without size hint */ }

    const chunkSize = opts.chunkSize ?? (fileSize ? chooseChunkSizeSmart(fileSize) : 256 * 1024);

    async function* fileChunks() {
        const stream = createReadStream(filePath, { highWaterMark: chunkSize });
        for await (const chunk of stream) {
            yield new Uint8Array(chunk as Buffer);
        }
    }

    return run(fileChunks(), schema, opts);
}

/**
 * Validate a CSV already loaded into a Buffer or Uint8Array.
 *
 * @example
 * const buf = await fs.promises.readFile("data.csv");
 * const result = await validateBuffer(buf, schema);
 */
export async function validateBuffer(
    data: Buffer | Uint8Array,
    schema: object,
    opts: NodeValidateOptions = {}
): Promise<ValidationResult> {
    const bytes =
        Buffer.isBuffer(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data;

    const chunkSize = opts.chunkSize ?? chooseChunkSizeSmart(bytes.length);

    async function* bufChunks() {
        for (let i = 0; i < bytes.length; i += chunkSize) {
            yield bytes.subarray(i, i + chunkSize);
        }
        if (bytes.length === 0) yield new Uint8Array(0);
    }

    return run(bufChunks(), schema, opts);
}

/**
 * Validate CSV from any async iterable of Uint8Array chunks.
 *
 * Useful when data arrives from a network socket, multipart upload stream,
 * or any other streaming source.
 *
 * @example
 * // Express multipart upload
 * const result = await validateStream(req, schema);
 */
export async function validateStream(
    stream: AsyncIterable<Uint8Array>,
    schema: object,
    opts: NodeValidateOptions = {}
): Promise<ValidationResult> {
    return run(stream, schema, opts);
}
