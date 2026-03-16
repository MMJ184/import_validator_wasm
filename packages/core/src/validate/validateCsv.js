import { toAsyncIterable } from "./sources";
import { chooseChunkSizeSmart } from "./chooseChunkSize";
export async function validateCsv(engine, input, opts = {}) {
    // 🔥 AUTO chunk-size selection
    const inferredSize = typeof input?.size === "number"
        ? input.size
        : undefined;
    const chunkSize = opts.chunkSize ??
        (inferredSize ? chooseChunkSizeSmart(inferredSize) : 1024 * 1024);
    const drainErrorsEvery = opts.drainErrorsEvery ?? 5000;
    const drainNormalized = opts.drainNormalized ?? true;
    const decodeErrors = opts.decodeErrors ?? false;
    const iterable = await toAsyncIterable(input, chunkSize);
    const allPacked = [];
    const allDecoded = [];
    const normalizedParts = [];
    let lastProgress = {
        rowsProcessed: 0,
        errorsAdded: 0,
        done: false,
    };
    const drain = () => {
        if (decodeErrors) {
            allDecoded.push(...engine.takeErrorsDecoded(drainErrorsEvery));
        }
        else {
            allPacked.push(...engine.takeErrors(drainErrorsEvery));
        }
        if (drainNormalized) {
            const norm = engine.takeNormalized();
            if (norm?.length)
                normalizedParts.push(norm);
        }
    };
    for await (const chunk of iterable) {
        if (opts.signal?.aborted)
            throw new Error("Validation aborted");
        lastProgress = engine.pushChunk(chunk, false);
        opts.onProgress?.(lastProgress);
        // ✅ critical for large files
        drain();
    }
    if (opts.signal?.aborted)
        throw new Error("Validation aborted");
    // flush
    lastProgress = engine.pushChunk(new Uint8Array(), true);
    opts.onProgress?.(lastProgress);
    drain();
    return {
        progress: lastProgress,
        errorsPacked: allPacked,
        errorsDecoded: decodeErrors ? allDecoded : undefined,
        normalized: normalizedParts.length
            ? concatU8(normalizedParts)
            : undefined,
        chunkSizeUsed: chunkSize, // 🔍 useful for debugging
    };
}
function concatU8(parts) {
    let total = 0;
    for (const p of parts)
        total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
