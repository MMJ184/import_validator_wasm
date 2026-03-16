// packages/core/src/validate/sources.ts
export async function* fromUint8Array(data, chunkSize = 1024 * 1024) {
    for (let i = 0; i < data.length; i += chunkSize) {
        yield data.subarray(i, i + chunkSize);
    }
}
export async function* fromArrayBuffer(buf, chunkSize = 1024 * 1024) {
    yield* fromUint8Array(new Uint8Array(buf), chunkSize);
}
// Browser-safe: Blob/File via slice (works everywhere)
export async function* fromBlob(blob, chunkSize = 1024 * 1024) {
    let offset = 0;
    while (offset < blob.size) {
        const part = blob.slice(offset, offset + chunkSize);
        const ab = await part.arrayBuffer();
        offset += chunkSize;
        yield new Uint8Array(ab);
    }
}
// Best browser path: ReadableStream (fast & memory-friendly)
export async function* fromReadableStream(stream) {
    const reader = stream.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            if (value && value.length)
                yield value;
        }
    }
    finally {
        reader.releaseLock();
    }
}
export async function toAsyncIterable(input, chunkSize = 1024 * 1024) {
    if (input instanceof Uint8Array)
        return fromUint8Array(input, chunkSize);
    if (input instanceof ArrayBuffer)
        return fromArrayBuffer(input, chunkSize);
    // ReadableStream
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof input?.getReader === "function") {
        return fromReadableStream(input);
    }
    // Blob/File
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof input?.arrayBuffer === "function" && typeof input?.slice === "function") {
        return fromBlob(input, chunkSize);
    }
    // AsyncIterable
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof input?.[Symbol.asyncIterator] === "function") {
        return input;
    }
    throw new Error("Unsupported input type for validateCsv()");
}
