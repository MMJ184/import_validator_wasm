import type { Progress, PackedError, DecodedError } from "../types.js";
import { Engine } from "../engine.js";
import { toAsyncIterable, type ChunkSource } from "./sources.js";
import { chooseChunkSizeSmart } from "./chooseChunkSize.js";

export type ValidateCsvOptions = {
    chunkSize?: number;              // optional override
    drainErrorsEvery?: number;
    drainNormalized?: boolean;
    decodeErrors?: boolean;
    onProgress?: (p: Progress) => void;
    signal?: AbortSignal;
};

export async function validateCsv(
    engine: Engine,
    input: ChunkSource,
    opts: ValidateCsvOptions = {}
) {
    // 🔥 AUTO chunk-size selection
    const inferredSize =
        typeof (input as any)?.size === "number"
            ? (input as any).size
            : undefined;

    const chunkSize =
        opts.chunkSize ??
        (inferredSize ? chooseChunkSizeSmart(inferredSize) : 1024 * 1024);

    const drainErrorsEvery = opts.drainErrorsEvery ?? 5000;
    const drainNormalized = opts.drainNormalized ?? true;
    const decodeErrors = opts.decodeErrors ?? false;

    const iterable = await toAsyncIterable(input, chunkSize);

    const allPacked: PackedError[] = [];
    const allDecoded: DecodedError[] = [];
    const normalizedParts: Uint8Array[] = [];

    // push_chunk returns per-call deltas; accumulate running totals here so
    // onProgress and the returned summary report totals (per the docs).
    const totals: Progress = {
        rowsProcessed: 0,
        errorsAdded: 0,
        done: false,
    };

    const accumulate = (delta: Progress) => {
        totals.rowsProcessed += delta.rowsProcessed;
        totals.errorsAdded += delta.errorsAdded;
        totals.done = delta.done;
    };

    const drain = () => {
        // Drain until the engine queue is empty: one call takes at most
        // `drainErrorsEvery`, and a single chunk can queue far more than that.
        while (engine.errorsLen() > 0) {
            if (decodeErrors) {
                const batch = engine.takeErrorsDecoded(drainErrorsEvery);
                if (!batch.length) break;
                for (const e of batch) allDecoded.push(e);
            } else {
                const batch = engine.takeErrors(drainErrorsEvery);
                if (!batch.length) break;
                for (const e of batch) allPacked.push(e);
            }
        }

        if (drainNormalized) {
            const norm = engine.takeNormalized();
            if (norm?.length) normalizedParts.push(norm);
        }
    };

    for await (const chunk of iterable) {
        if (opts.signal?.aborted) throw new Error("Validation aborted");

        accumulate(engine.pushChunk(chunk, false));
        opts.onProgress?.({ ...totals });

        // ✅ critical for large files
        drain();
    }

    if (opts.signal?.aborted) throw new Error("Validation aborted");

    // flush
    accumulate(engine.pushChunk(new Uint8Array(), true));
    opts.onProgress?.({ ...totals });

    drain();

    return {
        progress: totals,
        errorsPacked: allPacked,
        errorsDecoded: decodeErrors ? allDecoded : undefined,
        normalized:
            normalizedParts.length
                ? concatU8(normalizedParts)
                : undefined,
        chunkSizeUsed: chunkSize, // 🔍 useful for debugging
    };
}

function concatU8(parts: Uint8Array[]) {
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
