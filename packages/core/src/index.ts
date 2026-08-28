import type { Progress, PackedError, DecodedError } from "./types.js";
export { defaultWasmUrl } from "./wasmUrl.js";
export * from "./engine.js";
export * from "./validate/validateCsv.js";
export * from "./validate/chooseChunkSize.js";
export * from "./validate/rechunk.js";
export * from "./xlsx/zip.js";
export type { Progress, PackedError, DecodedError };

/** Concatenate Uint8Array chunks (e.g. normalized-output chunks) into one buffer. */
export function concatChunks(parts: Uint8Array[]): Uint8Array {
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
