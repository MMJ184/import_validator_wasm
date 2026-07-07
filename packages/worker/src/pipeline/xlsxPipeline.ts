import {
    blobSource,
    entryByteStream,
    isWasmReady,
    iterateStream,
    parseZipEntries,
    pickFirstWorksheet,
    XLSX_LIMITS,
    XlsxSheetRowCounter,
    type Engine,
    type InflateRaw,
    type RandomAccessSource,
    type ZipEntryMeta,
} from "@import-validator/core";
import type { PostFn } from "../protocol";
import { macrotaskTick, runEngineStream, type CsvRunOptions } from "./csvPipeline.js";

export type XlsxEstimate = {
    rows: number;
    avgBytesPerRow: number;
    columns?: number;
};

/**
 * A parsed XLSX container, opened once per request and shared between the
 * estimate preflight and the validation run (the sheet used to be inflated
 * twice — once per phase).
 */
export type OpenedXlsx = {
    source: RandomAccessSource;
    entries: Map<string, ZipEntryMeta>;
    sheetEntry: ZipEntryMeta;
    sharedEntry?: ZipEntryMeta;
    fileSizeBytes: number;
};

export async function openXlsxSource(file: File): Promise<OpenedXlsx> {
    assertSupportedExcelFile(file);
    const source = blobSource(file);
    const entries = await parseZipEntries(source);

    const sheetName = pickFirstWorksheet(entries);
    if (!sheetName) {
        throw new Error("Invalid XLSX: no worksheet XML found in xl/worksheets/");
    }
    const sheetEntry = entries.get(sheetName)!;
    if (sheetEntry.uncompressedSize > XLSX_LIMITS.maxSheetXmlUncompressedBytes) {
        throw new Error(
            `XLSX worksheet XML is too large (${sheetEntry.uncompressedSize} bytes). ` +
            `Limit is ${XLSX_LIMITS.maxSheetXmlUncompressedBytes} bytes. ` +
            `Split the workbook or convert to CSV for high-volume validation.`
        );
    }

    const sharedEntry = entries.get("xl/sharedStrings.xml");
    if (sharedEntry && sharedEntry.uncompressedSize > XLSX_LIMITS.maxSharedStringsUncompressedBytes) {
        throw new Error(
            `XLSX shared strings XML is too large (${sharedEntry.uncompressedSize} bytes). ` +
            `Limit is ${XLSX_LIMITS.maxSharedStringsUncompressedBytes} bytes. ` +
            `Use fewer unique string values per workbook or split the Excel file.`
        );
    }

    return { source, entries, sheetEntry, sharedEntry, fileSizeBytes: file.size };
}

export async function estimateXlsx(
    file: File,
    options?: { signal?: AbortSignal; preferDimension?: boolean; opened?: OpenedXlsx }
): Promise<XlsxEstimate> {
    const opened = options?.opened ?? (await openXlsxSource(file));
    const signal = options?.signal;

    if (options?.preferDimension !== false) {
        const fromDimension = await tryDimensionEstimate(opened, signal);
        if (fromDimension) return fromDimension;
    }

    // Full fallback: count <row> elements with the WASM sheet counter.
    if (!isWasmReady()) {
        throw new Error(
            "Engine not initialized: XLSX row-count estimate requires init before estimate for sheets without a <dimension> element."
        );
    }
    const counter = await XlsxSheetRowCounter.create();
    for await (const chunk of entryByteStream(opened.source, opened.sheetEntry, inflateRawStream)) {
        throwIfAborted(signal);
        counter.push(chunk);
        await macrotaskTick();
    }
    const { rows, columns } = counter.finish();

    const dataRows = Math.max(0, rows - 1);
    const avgBytesPerRow = dataRows > 0 ? opened.fileSizeBytes / dataRows : opened.fileSizeBytes;
    return { rows: dataRows, avgBytesPerRow, columns };
}

export async function runXlsx(
    file: File,
    engine: Engine,
    post: PostFn,
    opts: CsvRunOptions = {},
    opened?: OpenedXlsx
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    const src = opened ?? (await openXlsxSource(file));
    const signal = opts.signal;

    // Shared strings must be fully loaded before sheet rows. When the entry
    // exists we always load it (cheap relative to the sheet; inline-only
    // sheets that still carry a sharedStrings part are rare).
    if (src.sharedEntry) {
        for await (const chunk of entryByteStream(src.source, src.sharedEntry, inflateRawStream)) {
            throwIfAborted(signal);
            engine.pushSharedStringsChunk(chunk, false);
            await macrotaskTick();
        }
        engine.pushSharedStringsChunk(EMPTY, true);
    }

    const sheetChunks = entryByteStream(src.source, src.sheetEntry, inflateRawStream);
    return await runEngineStream(sheetChunks, engine, post, opts, (eng, chunk, final) =>
        eng.pushSheetChunk(chunk, final)
    );
}

const EMPTY = new Uint8Array(0);

function assertSupportedExcelFile(file: File) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xlsx")) return;
    if (lower.endsWith(".xls")) {
        throw new Error("Only .xlsx files are supported in this build; legacy .xls format is not supported.");
    }
    throw new Error(`Unsupported Excel file extension for "${file.name}". Expected .xlsx`);
}

/**
 * Dimension fast path: stream-inflate only until the <dimension> element is
 * seen (typically within the first kilobyte), then cancel the stream. The
 * old pipeline inflated and decoded the whole sheet for this.
 */
async function tryDimensionEstimate(
    opened: OpenedXlsx,
    signal?: AbortSignal
): Promise<XlsxEstimate | null> {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let buffered = "";
    const LOOKAHEAD_LIMIT = 256 * 1024;

    for await (const chunk of entryByteStream(opened.source, opened.sheetEntry, inflateRawStream)) {
        throwIfAborted(signal);
        buffered += decoder.decode(chunk, { stream: true });

        const dimension = parseWorksheetDimension(buffered);
        if (dimension) {
            const rows = Math.max(0, dimension.rows - 1);
            const avgBytesPerRow = rows > 0 ? opened.fileSizeBytes / rows : opened.fileSizeBytes;
            return { rows, avgBytesPerRow, columns: dimension.columns };
            // early return cancels the underlying DecompressionStream
        }
        if (buffered.includes("<sheetData") || buffered.length > LOOKAHEAD_LIMIT) {
            return null; // no usable dimension before data — fall back
        }
    }
    return parseWorksheetDimensionToEstimate(buffered, opened.fileSizeBytes);
}

function parseWorksheetDimensionToEstimate(xml: string, fileSize: number): XlsxEstimate | null {
    const dimension = parseWorksheetDimension(xml);
    if (!dimension) return null;
    const rows = Math.max(0, dimension.rows - 1);
    return {
        rows,
        avgBytesPerRow: rows > 0 ? fileSize / rows : fileSize,
        columns: dimension.columns,
    };
}

/** Browser inflate adapter: native DecompressionStream("deflate-raw"). */
export function inflateRawStream(compressed: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const DS = (globalThis as any).DecompressionStream;
    if (!DS) {
        throw new Error("DecompressionStream API is not available; cannot inflate XLSX ZIP content.");
    }
    const stream = toReadableStream(compressed).pipeThrough(
        new DS("deflate-raw")
    ) as ReadableStream<Uint8Array>;
    return iterateStream(stream);
}

function toReadableStream(iter: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
    const it = iter[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { value, done } = await it.next();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
        async cancel() {
            await it.return?.(undefined);
        },
    });
}

const DIMENSION_REF_RE = /<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/i;

function parseWorksheetDimension(xml: string): { rows: number; columns: number } | null {
    const match = DIMENSION_REF_RE.exec(xml);
    if (!match?.[1]) return null;

    const ref = match[1];
    const endRef = ref.includes(":") ? ref.split(":")[1] : ref;
    const parsed = parseCellRef(endRef);
    if (!parsed) return null;

    return {
        rows: parsed.row,
        columns: parsed.column,
    };
}

function parseCellRef(ref: string): { row: number; column: number } | null {
    const normalized = ref.replace(/\$/g, "").trim();
    const match = /^([A-Za-z]+)(\d+)$/.exec(normalized);
    if (!match) return null;
    const column = columnIndexFromRef(match[1]) + 1;
    const row = Number.parseInt(match[2], 10);
    if (!Number.isFinite(row) || row < 0 || column <= 0) return null;
    return { row, column };
}

function columnIndexFromRef(ref: string): number {
    let out = 0;
    for (let i = 0; i < ref.length; i += 1) {
        const code = ref.charCodeAt(i);
        if (code >= 65 && code <= 90) {
            out = out * 26 + (code - 64);
            continue;
        }
        if (code >= 97 && code <= 122) {
            out = out * 26 + (code - 96);
            continue;
        }
        break;
    }
    return out > 0 ? out - 1 : -1;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error("Operation aborted");
    }
}
