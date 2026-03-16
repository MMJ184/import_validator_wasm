export type ChunkSource = Uint8Array | ArrayBuffer | Blob | File | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
export declare function fromUint8Array(data: Uint8Array, chunkSize?: number): AsyncGenerator<Uint8Array<ArrayBufferLike>, void, unknown>;
export declare function fromArrayBuffer(buf: ArrayBuffer, chunkSize?: number): AsyncGenerator<Uint8Array<ArrayBufferLike>, void, unknown>;
export declare function fromBlob(blob: Blob, chunkSize?: number): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown>;
export declare function fromReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array<ArrayBufferLike>, void, unknown>;
export declare function toAsyncIterable(input: ChunkSource, chunkSize?: number): Promise<AsyncIterable<Uint8Array>>;
