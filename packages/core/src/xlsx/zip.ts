/**
 * Environment-agnostic ZIP (XLSX container) reader.
 *
 * Parses the central directory from any random-access source and streams
 * entry payloads through a caller-supplied `inflateRaw` adapter — the
 * browser worker passes a DecompressionStream adapter, the Node package
 * passes node:zlib. Guardrails (entry count, sizes, compression ratio,
 * no ZIP64) match the Rust native path byte-for-byte.
 */

export const XLSX_LIMITS = {
    maxZipEntries: 20_000,
    maxEntryUncompressedBytes: 256 * 1024 * 1024,
    maxTotalUncompressedBytes: 768 * 1024 * 1024,
    maxCompressionRatio: 1_000,
    maxSheetXmlUncompressedBytes: 192 * 1024 * 1024,
    maxSharedStringsUncompressedBytes: 128 * 1024 * 1024,
} as const;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_RECORD_MIN_BYTES = 46;
const ZIP_LOCAL_RECORD_MIN_BYTES = 30;
const ZIP_EOCD_MIN_BYTES = 22;

export type ZipEntryMeta = {
    name: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
};

/**
 * Random-access byte source. `readRange` returns exact small ranges
 * (directory records); `streamRange` yields a byte range incrementally
 * (entry payloads).
 */
export type RandomAccessSource = {
    size: number;
    readRange: (start: number, end: number) => Promise<Uint8Array>;
    streamRange: (start: number, end: number) => AsyncIterable<Uint8Array>;
};

/** Inflate adapter for raw DEFLATE streams. */
export type InflateRaw = (
    compressed: AsyncIterable<Uint8Array>
) => AsyncIterable<Uint8Array>;

/**
 * Browser File/Blob adapter. Tolerates minimal file-like objects (name +
 * size + arrayBuffer) by falling back to a cached whole-file read, so tests
 * and adapter layers can pass lightweight fakes.
 */
export function blobSource(file: Blob): RandomAccessSource {
    let wholeFileCache: Uint8Array | null = null;
    const readWholeFile = async () => {
        if (!wholeFileCache) {
            wholeFileCache = new Uint8Array(await file.arrayBuffer());
        }
        return wholeFileCache;
    };
    const sliceFn =
        typeof (file as any).slice === "function"
            ? ((file as any).slice as (start?: number, end?: number) => Blob)
            : null;

    const readRange = async (start: number, end: number): Promise<Uint8Array> => {
        const s = clamp(start, 0, file.size);
        const e = clamp(end, s, file.size);
        if (e <= s) return new Uint8Array();
        if (sliceFn) {
            return new Uint8Array(await sliceFn.call(file, s, e).arrayBuffer());
        }
        return (await readWholeFile()).subarray(s, e);
    };

    return {
        size: file.size,
        readRange,
        streamRange: async function* (start: number, end: number) {
            const s = clamp(start, 0, file.size);
            const e = clamp(end, s, file.size);
            if (e <= s) return;
            if (sliceFn) {
                const part = sliceFn.call(file, s, e);
                if (typeof (part as any).stream === "function") {
                    yield* iterateStream(part.stream());
                    return;
                }
            }
            // Fallback for file-likes without Blob streaming
            const bytes = await readRange(s, e);
            const CHUNK = 256 * 1024;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                yield bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            }
        },
    };
}

/** In-memory buffer adapter (Node validateXlsxBuffer, tests). */
export function bytesSource(bytes: Uint8Array): RandomAccessSource {
    return {
        size: bytes.length,
        readRange: async (start, end) =>
            bytes.subarray(clamp(start, 0, bytes.length), clamp(end, 0, bytes.length)),
        streamRange: async function* (start, end) {
            const s = clamp(start, 0, bytes.length);
            const e = clamp(end, s, bytes.length);
            const CHUNK = 256 * 1024;
            for (let i = s; i < e; i += CHUNK) {
                yield bytes.subarray(i, Math.min(i + CHUNK, e));
            }
        },
    };
}

export async function* iterateStream(
    stream: ReadableStream<Uint8Array>
): AsyncIterable<Uint8Array> {
    const reader = stream.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value?.length) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

export async function parseZipEntries(
    source: RandomAccessSource
): Promise<Map<string, ZipEntryMeta>> {
    const eocd = await readEocd(source);
    const totalEntries = readU16(eocd.buffer, eocd.localOffset + 10);
    const centralDirSize = readU32(eocd.buffer, eocd.localOffset + 12);
    const centralDirOffset = readU32(eocd.buffer, eocd.localOffset + 16);

    if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
        throw new Error("ZIP64 XLSX is not supported in this build.");
    }
    if (totalEntries > XLSX_LIMITS.maxZipEntries) {
        throw new Error(
            `XLSX ZIP has too many entries (${totalEntries}); limit is ${XLSX_LIMITS.maxZipEntries}.`
        );
    }
    if (centralDirOffset + centralDirSize > source.size) {
        throw new Error("Invalid XLSX ZIP: central directory exceeds file bounds.");
    }

    const centralBytes = await source.readRange(centralDirOffset, centralDirOffset + centralDirSize);
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
        if (totalUncompressedSize > XLSX_LIMITS.maxTotalUncompressedBytes) {
            throw new Error(
                `XLSX ZIP decompressed size exceeds safe limit (${XLSX_LIMITS.maxTotalUncompressedBytes} bytes).`
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
            localHeaderOffset,
        });

        cursor = nextCursor;
    }

    return entries;
}

export function pickFirstWorksheet(entries: Map<string, ZipEntryMeta>): string | undefined {
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

/**
 * Stream one entry's decompressed bytes. Enforces the declared uncompressed
 * size while streaming (zip-bomb honesty) and errors on a final mismatch.
 * Consumers may stop early (e.g. estimate fast path) — partial consumption
 * skips the final size check.
 */
export async function* entryByteStream(
    source: RandomAccessSource,
    entry: ZipEntryMeta,
    inflateRaw: InflateRaw
): AsyncIterable<Uint8Array> {
    const localHeader = await source.readRange(
        entry.localHeaderOffset,
        entry.localHeaderOffset + ZIP_LOCAL_RECORD_MIN_BYTES
    );
    ensureReadBounds(localHeader, 0, ZIP_LOCAL_RECORD_MIN_BYTES, "local file header");
    if (readU32(localHeader, 0) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error(`Invalid XLSX ZIP: local header signature mismatch for "${entry.name}"`);
    }

    const fileNameLength = readU16(localHeader, 26);
    const extraLength = readU16(localHeader, 28);
    const dataStart = entry.localHeaderOffset + ZIP_LOCAL_RECORD_MIN_BYTES + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > source.size) {
        throw new Error(`Invalid XLSX ZIP: compressed payload out of bounds for "${entry.name}"`);
    }

    const compressed = source.streamRange(dataStart, dataEnd);
    const decompressed =
        entry.compressionMethod === 0
            ? compressed
            : entry.compressionMethod === 8
                ? inflateRaw(compressed)
                : null;
    if (!decompressed) {
        throw new Error(
            `Unsupported ZIP compression method ${entry.compressionMethod} for entry "${entry.name}"`
        );
    }

    let emitted = 0;
    let completed = false;
    try {
        for await (const chunk of decompressed) {
            emitted += chunk.length;
            if (emitted > entry.uncompressedSize) {
                throw new Error(
                    `Invalid XLSX ZIP: uncompressed size mismatch for "${entry.name}" (expected ${entry.uncompressedSize}, got more).`
                );
            }
            yield chunk;
        }
        completed = true;
    } finally {
        if (completed && emitted !== entry.uncompressedSize) {
            throw new Error(
                `Invalid XLSX ZIP: uncompressed size mismatch for "${entry.name}" (expected ${entry.uncompressedSize}, got ${emitted}).`
            );
        }
    }
}

function validateZipEntrySizes(name: string, compressedSize: number, uncompressedSize: number) {
    if (uncompressedSize > XLSX_LIMITS.maxEntryUncompressedBytes) {
        throw new Error(
            `XLSX ZIP entry "${name}" exceeds safe size limit (${XLSX_LIMITS.maxEntryUncompressedBytes} bytes).`
        );
    }
    if (compressedSize > 0) {
        const ratio = uncompressedSize / compressedSize;
        if (ratio > XLSX_LIMITS.maxCompressionRatio) {
            throw new Error(
                `XLSX ZIP entry "${name}" exceeds max compression ratio (${XLSX_LIMITS.maxCompressionRatio}x).`
            );
        }
    } else if (uncompressedSize > 0) {
        throw new Error(`Invalid XLSX ZIP entry "${name}": zero compressed size with non-zero payload.`);
    }
}

async function readEocd(
    source: RandomAccessSource
): Promise<{ buffer: Uint8Array; localOffset: number }> {
    const maxCommentSize = 0xffff;
    const searchStart = Math.max(0, source.size - (ZIP_EOCD_MIN_BYTES + maxCommentSize));
    const tail = await source.readRange(searchStart, source.size);
    for (let i = tail.length - ZIP_EOCD_MIN_BYTES; i >= 0; i -= 1) {
        if (readU32(tail, i) === ZIP_EOCD_SIGNATURE) {
            return { buffer: tail, localOffset: i };
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
        (data[offset] |
            (data[offset + 1] << 8) |
            (data[offset + 2] << 16) |
            (data[offset + 3] << 24)) >>>
        0
    );
}

function ensureReadBounds(data: Uint8Array, offset: number, length: number, context: string) {
    if (
        !Number.isFinite(offset) ||
        !Number.isFinite(length) ||
        offset < 0 ||
        length < 0 ||
        offset + length > data.length
    ) {
        throw new Error(`Invalid XLSX ZIP: out-of-bounds read while parsing ${context}.`);
    }
}

function decodeUtf8(data: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
        throw new Error("Invalid UTF-8 data in XLSX ZIP entry name.");
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
