/**
 * Chunk shaping between an inflater and the engine.
 *
 * These are two independent costs, and they pull in opposite directions:
 *
 * - **Inflater output size.** Small output units are expensive on the Node
 *   side, where every emitted chunk travels through stream plumbing
 *   (allocation, backpressure, event emitters). Asking zlib for 1 MB units is
 *   most of the XLSX throughput win, and costs nothing — zlib simply writes
 *   into a bigger buffer.
 *
 * - **Engine push size.** Measured throughput is flat from ~16 KB to 1 MB, so
 *   bigger pushes buy nothing, while a big one delays every between-push
 *   activity: draining errors, emitting progress, and noticing cancellation.
 *   Small pushes also keep the per-push staging buffer small.
 *
 * So: inflate in large units, push in small ones. `rechunk` does both halves —
 * it merges undersized chunks and splits oversized ones, and splitting is free
 * because the pieces are subarray views, not copies.
 */

/** Bytes to request from an inflater per output chunk. */
export const DEFAULT_INFLATE_CHUNK_BYTES = 1024 * 1024;

/**
 * Bytes per engine push. Deliberately small: throughput is flat across this
 * range, and a smaller unit means errors, progress and cancellation are
 * handled sooner.
 */
export const DEFAULT_PUSH_CHUNK_BYTES = 64 * 1024;

/**
 * Re-chunk a byte stream so each yielded buffer is `targetBytes`, except the
 * last. Byte order and total length are preserved exactly; empty chunks are
 * dropped.
 *
 * Oversized chunks are split into subarray views (no copy). Undersized chunks
 * are joined, which copies only the pieces being joined.
 */
export async function* rechunk(
    source: AsyncIterable<Uint8Array>,
    targetBytes = DEFAULT_PUSH_CHUNK_BYTES
): AsyncIterable<Uint8Array> {
    targetBytes = Math.trunc(targetBytes);
    if (!Number.isFinite(targetBytes) || targetBytes < 1) {
        for await (const chunk of source) {
            if (chunk.length > 0) yield chunk;
        }
        return;
    }

    let parts: Uint8Array[] = [];
    let buffered = 0;

    for await (const chunk of source) {
        let rest = chunk;

        // Top up a pending remainder first so output stays in order.
        if (buffered > 0 && buffered + rest.length >= targetBytes) {
            const need = targetBytes - buffered;
            parts.push(rest.subarray(0, need));
            yield joinParts(parts, targetBytes);
            parts = [];
            buffered = 0;
            rest = rest.subarray(need);
        }

        // Emit whole target-sized slices without copying.
        while (rest.length >= targetBytes) {
            yield rest.subarray(0, targetBytes);
            rest = rest.subarray(targetBytes);
        }

        if (rest.length > 0) {
            parts.push(rest);
            buffered += rest.length;
        }
    }

    if (buffered > 0) {
        yield joinParts(parts, buffered);
    }
}

function joinParts(parts: Uint8Array[], total: number): Uint8Array {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
