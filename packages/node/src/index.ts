/**
 * @import-validator/node
 *
 * Server-side CSV + Excel (XLSX) validation for Node.js 20+.
 * Runs the WASM engine directly on the main thread — no Web Worker needed.
 *
 * Quick start:
 *   import { validateFile, validateBuffer, validateXlsxFile, init } from "@import-validator/node";
 *
 *   const schema = { hasHeaders: true, columns: [...] };
 *   const result = await validateFile("data.csv", schema);       // CSV
 *   const excel  = await validateXlsxFile("data.xlsx", schema);  // Excel
 *   if (!result.valid) console.log(result.errors);
 */

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import {
    bytesSource,
    chooseChunkSizeSmart,
    Engine,
    entryByteStream,
    initWasm,
    parseZipEntries,
    pickFirstWorksheet,
    validateCsv,
    XLSX_LIMITS,
    type InflateRaw,
    type Progress,
    type RandomAccessSource,
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
    /** Input header names (empty when hasHeaders: false). */
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

// ── Core CSV validation runner ────────────────────────────────────────────────

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

// ── Public API: CSV ───────────────────────────────────────────────────────────

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

// ── Public API: Excel (XLSX) ──────────────────────────────────────────────────

/**
 * Validate an .xlsx file on disk. The first worksheet is validated against
 * the same schema contract as CSV — identical error codes, normalized
 * output, and modifiers.
 *
 * The ZIP directory is read with random access and the worksheet streams
 * through zlib inflate into the engine — the decompressed sheet XML is never
 * held in memory.
 *
 * @example
 * const result = await validateXlsxFile("uploads/data.xlsx", schema);
 */
export async function validateXlsxFile(
    filePath: string,
    schema: object,
    opts: NodeValidateOptions = {}
): Promise<ValidationResult> {
    const fh = await open(filePath, "r");
    try {
        const size = (await fh.stat()).size;
        const source: RandomAccessSource = {
            size,
            readRange: async (start, end) => {
                const len = Math.max(0, end - start);
                if (len === 0) return new Uint8Array();
                const buf = Buffer.alloc(len);
                const { bytesRead } = await fh.read(buf, 0, len, start);
                return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
            },
            streamRange: (start, end) => {
                if (end <= start) return emptyIterable();
                return fh.createReadStream({
                    start,
                    end: end - 1, // inclusive
                    autoClose: false,
                }) as AsyncIterable<Uint8Array>;
            },
        };
        return await runXlsx(source, schema, opts);
    } finally {
        await fh.close();
    }
}

/**
 * Validate an .xlsx workbook already loaded into a Buffer or Uint8Array.
 *
 * @example
 * const buf = await fs.promises.readFile("data.xlsx");
 * const result = await validateXlsxBuffer(buf, schema);
 */
export async function validateXlsxBuffer(
    data: Buffer | Uint8Array,
    schema: object,
    opts: NodeValidateOptions = {}
): Promise<ValidationResult> {
    const bytes =
        Buffer.isBuffer(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data;
    return runXlsx(bytesSource(bytes), schema, opts);
}

/**
 * Validate an .xlsx workbook arriving as a byte stream. ZIP containers need
 * random access (the directory lives at the END of the file), so the stream
 * is buffered fully first — prefer validateXlsxFile for large uploads.
 */
export async function validateXlsxStream(
    stream: AsyncIterable<Uint8Array>,
    schema: object,
    opts: NodeValidateOptions = {}
): Promise<ValidationResult> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
        parts.push(chunk);
        total += chunk.length;
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        bytes.set(p, off);
        off += p.length;
    }
    return validateXlsxBuffer(bytes, schema, opts);
}

async function runXlsx(
    source: RandomAccessSource,
    schema: object,
    opts: NodeValidateOptions
): Promise<ValidationResult> {
    const { maxErrors = 10_000, emitNormalized = false, wasmUrl, signal, onProgress } = opts;
    await ensureInit(wasmUrl);

    const entries = await parseZipEntries(source);
    const sheetName = pickFirstWorksheet(entries);
    if (!sheetName) {
        throw new Error("Invalid XLSX: no worksheet XML found in xl/worksheets/");
    }
    const sheetEntry = entries.get(sheetName)!;
    if (sheetEntry.uncompressedSize > XLSX_LIMITS.maxSheetXmlUncompressedBytes) {
        throw new Error(
            `XLSX worksheet XML is too large (${sheetEntry.uncompressedSize} bytes). Limit is ${XLSX_LIMITS.maxSheetXmlUncompressedBytes} bytes.`
        );
    }
    const sharedEntry = entries.get("xl/sharedStrings.xml");
    if (sharedEntry && sharedEntry.uncompressedSize > XLSX_LIMITS.maxSharedStringsUncompressedBytes) {
        throw new Error(
            `XLSX shared strings XML is too large (${sharedEntry.uncompressedSize} bytes). Limit is ${XLSX_LIMITS.maxSharedStringsUncompressedBytes} bytes.`
        );
    }

    const engine = await Engine.create(schema, maxErrors, emitNormalized);

    if (sharedEntry) {
        for await (const chunk of entryByteStream(source, sharedEntry, inflateRawNode)) {
            throwIfAborted(signal);
            engine.pushSharedStringsChunk(chunk, false);
        }
        engine.pushSharedStringsChunk(new Uint8Array(0), true);
    }

    const errors: import("@import-validator/core").DecodedError[] = [];
    const normalizedParts: Uint8Array[] = [];
    const totals: Progress = { rowsProcessed: 0, errorsAdded: 0, done: false };

    const drain = () => {
        errors.push(...engine.takeErrorsDecoded(5_000));
        if (emitNormalized) {
            const chunk = engine.takeNormalized();
            if (chunk.length) normalizedParts.push(chunk);
        }
    };

    for await (const chunk of entryByteStream(source, sheetEntry, inflateRawNode)) {
        throwIfAborted(signal);
        const progress = engine.pushSheetChunk(chunk, false);
        totals.rowsProcessed += progress.rowsProcessed;
        totals.errorsAdded += progress.errorsAdded;
        onProgress?.({ rowsProcessed: totals.rowsProcessed, errorsAdded: totals.errorsAdded });
        drain();
    }
    throwIfAborted(signal);
    const final = engine.pushSheetChunk(new Uint8Array(0), true);
    totals.rowsProcessed += final.rowsProcessed;
    totals.errorsAdded += final.errorsAdded;
    drain();
    // drain any errors beyond the per-pass batch size
    while (engine.errorsLen() > 0) drain();

    return {
        errors,
        schemaColumns: engine.schemaColumns(),
        inputColumns: engine.inputColumns(),
        normalized: normalizedParts.length ? concat(normalizedParts) : undefined,
        rowsProcessed: totals.rowsProcessed,
        valid: errors.length === 0,
    };
}

/** Node inflate adapter for the shared ZIP reader (raw DEFLATE via zlib). */
const inflateRawNode: InflateRaw = (compressed) => {
    const inflate = createInflateRaw();
    return Readable.from(compressed).pipe(inflate) as AsyncIterable<Uint8Array>;
};

async function* emptyIterable(): AsyncIterable<Uint8Array> {}

function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Validation aborted");
}
