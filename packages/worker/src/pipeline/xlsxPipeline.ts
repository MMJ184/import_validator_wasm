import type { Engine } from "@import-validator/core";
import type { WorkerResponse } from "../protocol";
import { runCsvChunks, type CsvRunOptions } from "./csvPipeline.js";

export type XlsxEstimate = {
    rows: number;
    avgBytesPerRow: number;
    columns?: number;
};

type ZipEntryMeta = {
    name: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
};

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_RECORD_MIN_BYTES = 46;
const ZIP_LOCAL_RECORD_MIN_BYTES = 30;
const ZIP_EOCD_MIN_BYTES = 22;

const MAX_ZIP_ENTRIES = 20_000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 768 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 1_000;
const MAX_SHEET_XML_UNCOMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

const ROW_RE = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
const CELL_RE = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
const SHARED_STRING_RE = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
const TEXT_NODE_RE = /<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g;
const VALUE_NODE_RE = /<v(?:\s+[^>]*)?>([\s\S]*?)<\/v>/i;
const INLINE_STR_RE = /<is\b[^>]*>([\s\S]*?)<\/is>/i;
const DIMENSION_REF_RE = /<dimension\b[^>]*\bref="([^"]+)"/i;
const REF_ATTR_RE = /\br="([^"]*)"/i;
const TYPE_ATTR_RE = /\bt="([^"]*)"/i;

export async function estimateXlsx(
    file: File,
    options?: { signal?: AbortSignal; preferDimension?: boolean }
): Promise<XlsxEstimate> {
    assertSupportedExcelFile(file);

    const useDimension = options?.preferDimension !== false;
    if (useDimension) {
        const source = await readXlsxSource(file, {
            signal: options?.signal,
            includeSharedStrings: false,
        });
        const dimension = parseWorksheetDimension(source.sheetXml);
        if (dimension) {
            const rows = Math.max(0, dimension.rows - 1);
            const avgBytesPerRow = rows > 0 ? file.size / rows : file.size;
            return {
                rows,
                avgBytesPerRow,
                columns: dimension.columns,
            };
        }
    }

    const source = await readXlsxSource(file, {
        signal: options?.signal,
        includeSharedStrings: true,
        skipSharedStringsWhenUnused: true,
    });
    let totalRows = 0;
    let columns: number | undefined;
    for await (const row of iterateSheetRows(source.sheetXml, source.sharedStrings, options?.signal)) {
        totalRows += 1;
        if (columns === undefined) {
            columns = row.length;
        }
    }

    const dataRows = Math.max(0, totalRows - 1);
    const avgBytesPerRow = dataRows > 0 ? file.size / dataRows : file.size;

    return {
        rows: dataRows,
        avgBytesPerRow,
        columns,
    };
}

export async function runXlsx(
    file: File,
    engine: Engine,
    post: (msg: WorkerResponse) => void,
    opts: CsvRunOptions = {}
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    assertSupportedExcelFile(file);

    const source = await readXlsxSource(file, {
        signal: opts.signal,
        includeSharedStrings: true,
        skipSharedStringsWhenUnused: true,
    });
    const chunkTarget = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : 512 * 1024;
    const csvChunks = rowsToCsvChunkStream(
        iterateSheetRows(source.sheetXml, source.sharedStrings, opts.signal),
        chunkTarget,
        opts.signal
    );

    return await runCsvChunks(csvChunks, engine, post, opts);
}

function assertSupportedExcelFile(file: File) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xlsx")) return;
    if (lower.endsWith(".xls")) {
        throw new Error("Only .xlsx files are supported in this build; legacy .xls format is not supported.");
    }
    throw new Error(`Unsupported Excel file extension for "${file.name}". Expected .xlsx`);
}

async function readXlsxSource(
    file: File,
    options?: {
        signal?: AbortSignal;
        includeSharedStrings?: boolean;
        skipSharedStringsWhenUnused?: boolean;
    }
): Promise<{ sheetXml: string; sharedStrings: string[] }> {
    const signal = options?.signal;
    throwIfAborted(signal);
    const source = createZipSource(file);
    const entries = await parseZipEntries(source, signal);

    const sheetEntryName = pickFirstWorksheet(entries);
    if (!sheetEntryName) {
        throw new Error("Invalid XLSX: no worksheet XML found in xl/worksheets/");
    }

    const sheetEntry = entries.get(sheetEntryName);
    if (!sheetEntry) {
        throw new Error(`Invalid XLSX: missing ZIP entry "${sheetEntryName}"`);
    }
    enforceXmlEntryLimit(
        sheetEntry,
        MAX_SHEET_XML_UNCOMPRESSED_BYTES,
        "worksheet XML",
        'Split the workbook or convert to CSV for high-volume validation.'
    );
    const sheetXml = await readEntryText(source, entries, sheetEntryName, signal);
    const includeSharedStrings = options?.includeSharedStrings ?? true;
    if (!includeSharedStrings) {
        return { sheetXml, sharedStrings: [] };
    }

    if (options?.skipSharedStringsWhenUnused && !sheetUsesSharedStrings(sheetXml)) {
        return { sheetXml, sharedStrings: [] };
    }

    const sharedEntry = entries.get("xl/sharedStrings.xml");
    if (!sharedEntry) {
        return { sheetXml, sharedStrings: [] };
    }
    enforceXmlEntryLimit(
        sharedEntry,
        MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES,
        "shared strings XML",
        "Use fewer unique string values per workbook or split the Excel file."
    );
    const sharedXml = await readEntryText(source, entries, "xl/sharedStrings.xml", signal);

    const sharedStrings = parseSharedStrings(sharedXml);
    return { sheetXml, sharedStrings };
}

async function* rowsToCsvChunkStream(
    rows: AsyncIterable<string[]>,
    targetChunkBytes: number,
    signal?: AbortSignal
): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    let chunk = "";

    for await (const row of rows) {
        throwIfAborted(signal);
        const line = `${row.map(escapeCsvValue).join(",")}\n`;
        if (chunk.length > 0 && chunk.length + line.length > targetChunkBytes) {
            yield encoder.encode(chunk);
            chunk = "";
        }
        chunk += line;
    }

    if (chunk.length) {
        yield encoder.encode(chunk);
    }
}

function escapeCsvValue(value: string): string {
    if (!/[,"\n\r]/.test(value)) return value;
    return `"${value.replace(/"/g, "\"\"")}"`;
}

type ZipSource = {
    size: number;
    readRange: (start: number, end: number, signal?: AbortSignal) => Promise<Uint8Array>;
};

function createZipSource(file: File): ZipSource {
    let wholeFileCache: Uint8Array | null = null;

    const readWholeFile = async () => {
        if (!wholeFileCache) {
            wholeFileCache = new Uint8Array(await file.arrayBuffer());
        }
        return wholeFileCache;
    };

    return {
        size: file.size,
        readRange: async (start: number, end: number, signal?: AbortSignal) => {
            throwIfAborted(signal);
            const safeStart = clamp(start, 0, file.size);
            const safeEnd = clamp(end, safeStart, file.size);
            if (safeEnd <= safeStart) return new Uint8Array();

            const blobSlice = (file as any).slice as ((start?: number, end?: number) => Blob) | undefined;
            if (typeof blobSlice === "function") {
                const part = blobSlice.call(file, safeStart, safeEnd);
                const buffer = await part.arrayBuffer();
                throwIfAborted(signal);
                return new Uint8Array(buffer);
            }

            const allBytes = await readWholeFile();
            throwIfAborted(signal);
            return allBytes.subarray(safeStart, safeEnd);
        }
    };
}

async function parseZipEntries(source: ZipSource, signal?: AbortSignal): Promise<Map<string, ZipEntryMeta>> {
    const eocd = await readEocd(source, signal);
    const totalEntries = readU16(eocd.buffer, eocd.localOffset + 10);
    const centralDirSize = readU32(eocd.buffer, eocd.localOffset + 12);
    const centralDirOffset = readU32(eocd.buffer, eocd.localOffset + 16);

    if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
        throw new Error("ZIP64 XLSX is not supported in this build.");
    }
    if (totalEntries > MAX_ZIP_ENTRIES) {
        throw new Error(`XLSX ZIP has too many entries (${totalEntries}); limit is ${MAX_ZIP_ENTRIES}.`);
    }
    if (centralDirOffset + centralDirSize > source.size) {
        throw new Error("Invalid XLSX ZIP: central directory exceeds file bounds.");
    }

    const centralBytes = await source.readRange(
        centralDirOffset,
        centralDirOffset + centralDirSize,
        signal
    );
    throwIfAborted(signal);
    const entries = new Map<string, ZipEntryMeta>();
    let cursor = 0;
    let totalUncompressedSize = 0;

    for (let i = 0; i < totalEntries; i += 1) {
        ensureReadBounds(centralBytes, cursor, ZIP_CENTRAL_RECORD_MIN_BYTES, "central directory record");
        if (readU32(centralBytes, cursor) !== ZIP_CENTRAL_SIGNATURE) {
            throw new Error("Invalid XLSX ZIP: central directory signature mismatch.");
        }

        const compressionMethod = readU16(centralBytes, cursor + 10);
        const compressedSize = readU32(centralBytes, cursor + 20);
        const uncompressedSize = readU32(centralBytes, cursor + 24);
        const fileNameLength = readU16(centralBytes, cursor + 28);
        const extraLength = readU16(centralBytes, cursor + 30);
        const commentLength = readU16(centralBytes, cursor + 32);
        const localHeaderOffset = readU32(centralBytes, cursor + 42);

        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new Error("ZIP64 XLSX is not supported in this build.");
        }

        const nameStart = cursor + 46;
        const nameEnd = nameStart + fileNameLength;
        const nextCursor = nameEnd + extraLength + commentLength;
        ensureReadBounds(centralBytes, cursor, nextCursor - cursor, "central directory record");
        const name = decodeUtf8(centralBytes.subarray(nameStart, nameEnd));

        validateZipEntrySizes(name, compressedSize, uncompressedSize);
        totalUncompressedSize += uncompressedSize;
        if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
            throw new Error(
                `XLSX ZIP decompressed size exceeds safe limit (${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes).`
            );
        }
        if (localHeaderOffset >= source.size) {
            throw new Error(`Invalid XLSX ZIP: local header offset out of bounds for "${name}".`);
        }

        entries.set(name, {
            name,
            compressionMethod,
            compressedSize,
            uncompressedSize,
            localHeaderOffset
        });

        cursor = nextCursor;
    }

    return entries;
}

function pickFirstWorksheet(entries: Map<string, ZipEntryMeta>): string | undefined {
    const sheetNames = Array.from(entries.keys())
        .filter((name) => name.startsWith("xl/worksheets/") && name.endsWith(".xml"))
        .sort((a, b) => extractSheetOrder(a) - extractSheetOrder(b));
    return sheetNames[0];
}

function extractSheetOrder(name: string): number {
    const match = name.match(/sheet(\d+)\.xml$/);
    if (!match) return Number.MAX_SAFE_INTEGER;
    return Number.parseInt(match[1], 10);
}

async function readEntryText(
    source: ZipSource,
    entries: Map<string, ZipEntryMeta>,
    entryName: string,
    signal?: AbortSignal
): Promise<string> {
    const entry = entries.get(entryName);
    if (!entry) {
        throw new Error(`Invalid XLSX: missing ZIP entry "${entryName}"`);
    }
    const bytes = await readEntryBytes(source, entry, signal);
    return decodeUtf8(bytes);
}

async function readEntryBytes(
    source: ZipSource,
    entry: ZipEntryMeta,
    signal?: AbortSignal
): Promise<Uint8Array> {
    throwIfAborted(signal);
    const localHeaderOffset = entry.localHeaderOffset;
    const localHeader = await source.readRange(
        localHeaderOffset,
        localHeaderOffset + ZIP_LOCAL_RECORD_MIN_BYTES,
        signal
    );
    ensureReadBounds(localHeader, 0, ZIP_LOCAL_RECORD_MIN_BYTES, "local file header");
    if (readU32(localHeader, 0) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error(`Invalid XLSX ZIP: local header signature mismatch for "${entry.name}"`);
    }

    const fileNameLength = readU16(localHeader, 26);
    const extraLength = readU16(localHeader, 28);
    const dataStart = localHeaderOffset + ZIP_LOCAL_RECORD_MIN_BYTES + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > source.size) {
        throw new Error(`Invalid XLSX ZIP: compressed payload out of bounds for "${entry.name}"`);
    }
    const compressed = await source.readRange(dataStart, dataEnd, signal);

    let out: Uint8Array;
    if (entry.compressionMethod === 0) {
        out = compressed;
    } else if (entry.compressionMethod === 8) {
        out = await inflateDeflateRaw(compressed, signal);
    } else {
        throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for entry "${entry.name}"`);
    }

    if (out.length !== entry.uncompressedSize) {
        throw new Error(
            `Invalid XLSX ZIP: uncompressed size mismatch for "${entry.name}" (expected ${entry.uncompressedSize}, got ${out.length}).`
        );
    }
    if (out.length > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw new Error(
            `XLSX ZIP entry "${entry.name}" exceeds safe size limit (${MAX_ENTRY_UNCOMPRESSED_BYTES} bytes).`
        );
    }
    return out;
}

async function readEocd(
    source: ZipSource,
    signal?: AbortSignal
): Promise<{ buffer: Uint8Array; localOffset: number }> {
    const minEocdSize = ZIP_EOCD_MIN_BYTES;
    const maxCommentSize = 0xffff;
    const searchStart = Math.max(0, source.size - (minEocdSize + maxCommentSize));
    const tail = await source.readRange(searchStart, source.size, signal);
    for (let i = tail.length - minEocdSize; i >= 0; i -= 1) {
        if (readU32(tail, i) === ZIP_EOCD_SIGNATURE) {
            return {
                buffer: tail,
                localOffset: i,
            };
        }
    }
    throw new Error("Invalid XLSX ZIP: end of central directory not found.");
}

function readU16(data: Uint8Array, offset: number): number {
    ensureReadBounds(data, offset, 2, "U16 read");
    return data[offset] | (data[offset + 1] << 8);
}

function readU32(data: Uint8Array, offset: number): number {
    ensureReadBounds(data, offset, 4, "U32 read");
    return (
        data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)
    ) >>> 0;
}

async function inflateDeflateRaw(compressed: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);
    const DS = (self as any).DecompressionStream;
    if (!DS) {
        throw new Error("DecompressionStream API is not available; cannot inflate XLSX ZIP content.");
    }

    const raw = new Uint8Array(compressed).buffer;
    const stream = new Blob([raw]).stream().pipeThrough(new DS("deflate-raw"));
    const buffer = await new Response(stream).arrayBuffer();
    throwIfAborted(signal);
    return new Uint8Array(buffer);
}

function decodeUtf8(data: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
        throw new Error("Invalid UTF-8 data in XLSX XML content.");
    }
}

function parseSharedStrings(xml: string): string[] {
    if (!xml) return [];
    const out: string[] = [];
    SHARED_STRING_RE.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = SHARED_STRING_RE.exec(xml)) !== null) {
        out.push(readTextNodes(match[1]));
    }
    return out;
}

async function* iterateSheetRows(
    xml: string,
    sharedStrings: string[],
    signal?: AbortSignal
): AsyncIterable<string[]> {
    ROW_RE.lastIndex = 0;
    let rowIndex = 0;
    let rowMatch: RegExpExecArray | null = null;

    while ((rowMatch = ROW_RE.exec(xml)) !== null) {
        throwIfAborted(signal);
        if (rowIndex > 0 && rowIndex % 1000 === 0) {
            await Promise.resolve();
        }

        const rowBody = rowMatch[3] ?? "";
        CELL_RE.lastIndex = 0;
        let cellIndex = 0;
        let cellMatch: RegExpExecArray | null = null;
        const row: string[] = [];

        while ((cellMatch = CELL_RE.exec(rowBody)) !== null) {
            const attrs = cellMatch[1] ?? cellMatch[2] ?? "";
            const cellBody = cellMatch[3] ?? "";
            const ref = readRefAttribute(attrs) ?? "";
            const colIndex = ref ? columnIndexFromRef(ref) : cellIndex;
            if (colIndex < 0) continue;
            row[colIndex] = readCellText(attrs, cellBody, sharedStrings);
            cellIndex += 1;
        }

        for (let i = 0; i < row.length; i += 1) {
            if (row[i] === undefined) row[i] = "";
        }

        yield row;
        rowIndex += 1;
    }
}

function readCellText(attrs: string, body: string, sharedStrings: string[]): string {
    const type = (readTypeAttribute(attrs) ?? "").toLowerCase();

    if (type === "inlinestr") {
        const inlineMatch = INLINE_STR_RE.exec(body);
        return inlineMatch ? readTextNodes(inlineMatch[1]) : "";
    }

    const value = readValueNode(body);

    if (type === "s") {
        const index = Number.parseInt(value, 10);
        return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
    }
    if (type === "b") {
        return value === "1" ? "TRUE" : "FALSE";
    }

    return decodeXmlText(value);
}

function readValueNode(xml: string): string {
    const match = VALUE_NODE_RE.exec(xml);
    return match ? decodeXmlText(match[1]) : "";
}

function readTextNodes(xml: string): string {
    TEXT_NODE_RE.lastIndex = 0;
    let out = "";
    let seen = false;
    let match: RegExpExecArray | null = null;
    while ((match = TEXT_NODE_RE.exec(xml)) !== null) {
        out += decodeXmlText(match[1]);
        seen = true;
    }
    if (seen) return out;
    return decodeXmlText(stripXmlTags(xml));
}

function readRefAttribute(attrs: string): string | undefined {
    const match = REF_ATTR_RE.exec(attrs);
    return match ? match[1] : undefined;
}

function readTypeAttribute(attrs: string): string | undefined {
    const match = TYPE_ATTR_RE.exec(attrs);
    return match ? match[1] : undefined;
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

function ensureReadBounds(data: Uint8Array, offset: number, length: number, context: string) {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0 || offset + length > data.length) {
        throw new Error(`Invalid XLSX ZIP: out-of-bounds read while parsing ${context}.`);
    }
}

function validateZipEntrySizes(name: string, compressedSize: number, uncompressedSize: number) {
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw new Error(
            `XLSX ZIP entry "${name}" exceeds safe size limit (${MAX_ENTRY_UNCOMPRESSED_BYTES} bytes).`
        );
    }
    if (compressedSize > 0) {
        const ratio = uncompressedSize / compressedSize;
        if (ratio > MAX_COMPRESSION_RATIO) {
            throw new Error(
                `XLSX ZIP entry "${name}" exceeds max compression ratio (${MAX_COMPRESSION_RATIO}x).`
            );
        }
    } else if (uncompressedSize > 0) {
        throw new Error(`Invalid XLSX ZIP entry "${name}": zero compressed size with non-zero payload.`);
    }
}

function enforceXmlEntryLimit(
    entry: ZipEntryMeta,
    maxBytes: number,
    label: string,
    remediation: string
) {
    if (entry.uncompressedSize <= maxBytes) return;
    throw new Error(
        `XLSX ${label} is too large (${entry.uncompressedSize} bytes). Limit is ${maxBytes} bytes. ${remediation}`
    );
}

function sheetUsesSharedStrings(sheetXml: string): boolean {
    return /\bt=(["'])s\1/.test(sheetXml);
}

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

function decodeXmlText(input: string): string {
    const withoutCdata = input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    return decodeXmlEntities(withoutCdata);
}

function decodeXmlEntities(input: string): string {
    return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_all, token: string) => {
        if (token === "amp") return "&";
        if (token === "lt") return "<";
        if (token === "gt") return ">";
        if (token === "quot") return "\"";
        if (token === "apos") return "'";
        if (token.startsWith("#x")) {
            const code = Number.parseInt(token.slice(2), 16);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
            return String.fromCodePoint(code);
        }
        if (token.startsWith("#")) {
            const code = Number.parseInt(token.slice(1), 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
            return String.fromCodePoint(code);
        }
        return "";
    });
}

function stripXmlTags(input: string): string {
    return input.replace(/<[^>]*>/g, "");
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
