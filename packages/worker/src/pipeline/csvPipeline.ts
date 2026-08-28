import type { Engine, Progress } from "@import-validator/core";
import type { PostFn } from "../protocol";

const DEFAULT_POST_ERROR_BATCH = 2_000;
const DEFAULT_MAX_POST_ERRORS_TOTAL = 50_000;
const DEFAULT_PROGRESS_FLUSH_ROWS = 5_000;
const DEFAULT_PROGRESS_FLUSH_INTERVAL_MS = 120;

export type CsvRunOptions = {
    emitNormalized?: boolean;
    maxPostErrorsTotal?: number;
    postErrorBatch?: number;
    maxErrorRowsToShow?: number;
    progressFlushRows?: number;
    progressFlushIntervalMs?: number;
    chunkSize?: number;
    dryRunRows?: number;
    signal?: AbortSignal;
    /**
     * v2 protocol: post packed error batches (transferable) instead of
     * decoded objects. The SDK decodes them back to DecodedError[].
     */
    postPackedErrors?: boolean;
};

export async function runCsv(
    file: File,
    engine: Engine,
    post: PostFn,
    opts: CsvRunOptions = {}
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    const chunkSize = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : undefined;
    const source = streamFile(file, chunkSize, opts.signal);
    return await runCsvChunks(source, engine, post, opts);
}

export async function runCsvChunks(
    source: AsyncIterable<Uint8Array>,
    engine: Engine,
    post: PostFn,
    opts: CsvRunOptions = {}
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    return await runEngineStream(
        source,
        engine,
        post,
        opts,
        (eng, chunk, final) => eng.pushChunk(chunk, final)
    );
}

/**
 * Shared engine-stream runner: drives any byte source into the engine via
 * `push` (CSV chunks or decompressed worksheet XML), draining errors,
 * normalized output, and progress along the way.
 *
 * Every iteration yields one macrotask so worker timers (timeoutMs) and
 * cancel messages stay live even when all reads resolve from cache.
 */
export async function runEngineStream(
    source: AsyncIterable<Uint8Array>,
    engine: Engine,
    post: PostFn,
    opts: CsvRunOptions,
    push: (engine: Engine, chunk: Uint8Array, final: boolean) => Progress
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    // The engine is the authority: if it accumulates normalized output we must
    // drain it even when the caller says otherwise, or the buffer grows for the
    // whole file. An explicit `false` must not win over the engine's own state.
    const emitNormalized = opts.emitNormalized === true || engine.emitNormalized === true;
    const postErrorBatch = opts.postErrorBatch ?? DEFAULT_POST_ERROR_BATCH;
    const maxPostErrorsTotal = opts.maxPostErrorsTotal ?? DEFAULT_MAX_POST_ERRORS_TOTAL;
    const maxErrorRowsToShow =
        opts.maxErrorRowsToShow && opts.maxErrorRowsToShow > 0
            ? opts.maxErrorRowsToShow
            : undefined;
    const dryRunRows = opts.dryRunRows && opts.dryRunRows > 0 ? opts.dryRunRows : undefined;
    const progressFlushRows = positiveIntOrDefault(opts.progressFlushRows, DEFAULT_PROGRESS_FLUSH_ROWS);
    const progressFlushIntervalMs = positiveIntOrDefault(
        opts.progressFlushIntervalMs,
        DEFAULT_PROGRESS_FLUSH_INTERVAL_MS
    );
    const signal = opts.signal;
    const postPacked = opts.postPackedErrors === true;
    const maybeTick = createTickPacer();

    let totalPostedErrors = 0;
    // Errors the *worker* found but never delivered: filtered out by
    // maxErrorRowsToShow, or discarded once that row limit was reached. The
    // engine's own suppressed count knows nothing about these, and the host is
    // told that delivered + suppressed is the file's exact total.
    let undelivered = 0;
    let totalRowsProcessed = 0;
    const shownRows = new Set<number>();
    let rowLimitReached = false;
    let pendingProgress = { rowsProcessed: 0, errorsAdded: 0, done: false };
    let lastProgressPostAt = Date.now();

    const filterPackedByRows = (packed: Uint32Array): Uint32Array => {
        if (maxErrorRowsToShow === undefined) return packed;
        const filtered: number[] = [];
        for (let i = 0; i + 1 < packed.length; i += 2) {
            const row = packed[i];
            if (shownRows.has(row)) {
                filtered.push(packed[i], packed[i + 1]);
                continue;
            }
            if (shownRows.size >= maxErrorRowsToShow) {
                rowLimitReached = true;
                continue;
            }
            shownRows.add(row);
            filtered.push(packed[i], packed[i + 1]);
        }
        return filtered.length === packed.length ? packed : Uint32Array.from(filtered);
    };

    const flushErrors = () => {
        if (rowLimitReached) {
            undelivered += drainErrorsDiscarding(engine);
            return;
        }
        if (engine.errorsLen() === 0) return;
        while (true) {
            if (totalPostedErrors >= maxPostErrorsTotal) return;

            const remaining = maxPostErrorsTotal - totalPostedErrors;
            const requestSize = Math.min(postErrorBatch, remaining);

            if (postPacked) {
                const packed = engine.takeErrorsPacked(requestSize);
                if (!packed.length) return;
                const visible = filterPackedByRows(packed);
                undelivered += (packed.length - visible.length) / 2;
                if (visible.length) {
                    totalPostedErrors += visible.length / 2;
                    post(
                        {
                            type: "errorsPacked",
                            packed: visible,
                            schemaColumns: engine.schemaColumns(),
                            inputColumns: engine.inputColumns(),
                        },
                        [visible.buffer]
                    );
                }
            } else {
                const batch = engine.takeErrorsDecoded(requestSize);
                if (!batch.length) return;

                const visibleBatch =
                    maxErrorRowsToShow === undefined
                        ? batch
                        : batch.filter((e: { row: number }) => {
                            if (shownRows.has(e.row)) return true;
                            if (shownRows.size >= maxErrorRowsToShow) {
                                rowLimitReached = true;
                                return false;
                            }
                            shownRows.add(e.row);
                            return true;
                        });
                undelivered += batch.length - visibleBatch.length;

                if (visibleBatch.length) {
                    totalPostedErrors += visibleBatch.length;
                    post({ type: "errors", errors: visibleBatch });
                }
            }

            if (rowLimitReached) {
                undelivered += drainErrorsDiscarding(engine);
                return;
            }
        }
    };

    const flushNormalized = () => {
        if (!emitNormalized) return;
        const normalized = engine.takeNormalized();
        if (normalized.length) {
            post({ type: "normalized", chunk: normalized }, [normalized.buffer]);
        }
    };

    for await (const value of source) {
        throwIfAborted(signal);
        const progress = pushChunkSafe(engine, value, false, totalRowsProcessed, push);
        totalRowsProcessed += progress.rowsProcessed;
        pendingProgress.rowsProcessed += progress.rowsProcessed;
        pendingProgress.errorsAdded += progress.errorsAdded;
        pendingProgress.done = pendingProgress.done || progress.done;
        flushProgress(false);

        flushErrors();
        flushNormalized();

        if (dryRunRows && totalRowsProcessed >= dryRunRows) break;

        // Keep timers (timeoutMs) and cancel messages live: with read-ahead,
        // every await may resolve from cache (microtasks only), which starves
        // the worker's macrotask queue. Paced by the clock, not by chunk count.
        await maybeTick();
    }

    throwIfAborted(signal);

    const finalProgress = pushChunkSafe(engine, new Uint8Array(), true, totalRowsProcessed, push);
    totalRowsProcessed += finalProgress.rowsProcessed;
    pendingProgress.rowsProcessed += finalProgress.rowsProcessed;
    pendingProgress.errorsAdded += finalProgress.errorsAdded;
    pendingProgress.done = pendingProgress.done || finalProgress.done;
    flushProgress(true);

    flushErrors();
    flushNormalized();

    // Everything found but not delivered: capped by the engine queue, dropped
    // by this worker, or still queued because maxPostErrorsTotal was reached.
    // Tolerate an older core — worker and core ship as separate packages.
    const engineSuppressed =
        typeof engine.errorsSuppressed === "function" ? engine.errorsSuppressed() : undefined;
    post({
        type: "done",
        errorsSuppressed:
            engineSuppressed === undefined
                ? undefined
                : engineSuppressed + undelivered + engine.errorsLen(),
    });
    return {
        rowsProcessed: totalRowsProcessed,
        errorsPosted: totalPostedErrors,
    };

    function flushProgress(force: boolean) {
        const hasPending =
            pendingProgress.rowsProcessed > 0 ||
            pendingProgress.errorsAdded > 0 ||
            pendingProgress.done;
        if (!hasPending) return;

        const now = Date.now();
        const timeReady = now - lastProgressPostAt >= progressFlushIntervalMs;
        const rowReady = pendingProgress.rowsProcessed >= progressFlushRows;
        if (!force && !timeReady && !rowReady) return;

        post({ type: "progress", progress: pendingProgress });
        pendingProgress = { rowsProcessed: 0, errorsAdded: 0, done: false };
        lastProgressPostAt = now;
    }
}

/** Discard the queue without materializing it. Returns how many were dropped. */
function drainErrorsDiscarding(engine: Engine): number {
    const count = engine.errorsLen();
    if (count > 0) engine.dropErrors(count);
    return count;
}

function pushChunkSafe(
    engine: Engine,
    chunk: Uint8Array,
    finalChunk: boolean,
    rowsProcessedSoFar: number,
    push: (engine: Engine, chunk: Uint8Array, final: boolean) => Progress
) {
    try {
        return push(engine, chunk, finalChunk);
    } catch (err: any) {
        const base = err?.message || String(err);
        const at = rowsProcessedSoFar > 0 ? ` around row ${rowsProcessedSoFar}` : "";
        throw new Error(`Validator engine crashed${at}: ${base}`);
    }
}

/**
 * Stream a file in fixed-size chunks with one-chunk read-ahead: the next
 * slice read is in flight while the engine crunches the current chunk,
 * overlapping I/O with WASM compute.
 */
export async function* streamFile(
    file: File,
    chunkSize?: number,
    signal?: AbortSignal
): AsyncIterable<Uint8Array> {
    if (chunkSize) {
        const read = (offset: number) => file.slice(offset, offset + chunkSize).arrayBuffer();
        let inFlight: Promise<ArrayBuffer> | null = file.size > 0 ? read(0) : null;
        for (let offset = 0; offset < file.size; offset += chunkSize) {
            const buf = await inFlight!;
            const nextOffset = offset + chunkSize;
            inFlight = nextOffset < file.size ? read(nextOffset) : null;
            throwIfAborted(signal);
            if (buf.byteLength) yield new Uint8Array(buf);
        }
        return;
    }

    const reader = file.stream().getReader();
    try {
        while (true) {
            if (signal?.aborted) {
                try {
                    await reader.cancel();
                } catch {}
                throw abortedError();
            }
            const { value, done } = await reader.read();
            if (done) break;
            if (value?.length) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

// Reusable macrotask tick (MessageChannel — faster than setTimeout(0), still
// drains the macrotask queue). One tick outstanding at a time.
let tickResolve: (() => void) | null = null;
let tickChannel: MessageChannel | null = null;

export function macrotaskTick(): Promise<void> {
    if (!tickChannel) {
        tickChannel = new MessageChannel();
        tickChannel.port1.onmessage = () => {
            // Idle again: stop holding the loop open (no-op in browsers).
            (tickChannel!.port1 as any).unref?.();
            const r = tickResolve;
            tickResolve = null;
            r?.();
        };
        // Node: open ports keep the event loop alive, which would stop test
        // runners and CLIs exiting. No-op in browsers/workers.
        (tickChannel.port1 as any).unref?.();
        (tickChannel.port2 as any).unref?.();
    }
    return new Promise((resolve) => {
        tickResolve = resolve;
        // Hold the loop open only while this tick is in flight. Unref'd
        // throughout, a Node host with no other pending handle treats the loop
        // as drained and the awaited tick never settles.
        (tickChannel!.port1 as any).ref?.();
        tickChannel!.port2.postMessage(0);
    });
}

/** Max time between macrotask yields — one frame, so cancel stays responsive. */
const TICK_INTERVAL_MS = 16;
/**
 * Every Nth yield goes through `setTimeout` instead of the MessageChannel.
 *
 * A port message is cheaper, but under Node it is delivered without draining
 * the timer phase — so `timeoutMs`, which is a `setTimeout` in the worker,
 * never fires while a validation loop is spinning on port yields. (`cancel()`
 * is unaffected: it arrives as a port message like the tick itself.) One timer
 * yield per ~64 ms restores that without paying setTimeout's clamp each frame.
 */
const TIMER_YIELD_EVERY = 4;

/** Yield in a way that lets due timers run. */
function timerTick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Yield a macrotask at most every `TICK_INTERVAL_MS`, instead of once per chunk.
 *
 * Responsiveness only requires yielding often enough for a human, but chunk
 * count is set by the reader/inflater: a low-memory device (256 KB CSV chunks)
 * or a worksheet inflated in ~16 KB units produces thousands of chunks, so
 * ticking per chunk spends real time in the scheduler for no benefit. Pacing by
 * the clock keeps the 16 ms guarantee whatever the chunk size.
 *
 * Uses `performance.now()`: it is monotonic, so a backward system-clock step
 * cannot stall yielding the way `Date.now()` would.
 */
export function createTickPacer(intervalMs = TICK_INTERVAL_MS) {
    let lastTickAt = performance.now();
    let sinceTimerYield = 0;
    return async function maybeTick(): Promise<void> {
        const now = performance.now();
        if (now - lastTickAt < intervalMs) return;
        lastTickAt = now;
        if (++sinceTimerYield >= TIMER_YIELD_EVERY) {
            sinceTimerYield = 0;
            await timerTick();
            return;
        }
        await macrotaskTick();
    };
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortedError();
    }
}

function abortedError() {
    return new Error("Operation aborted");
}

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
    if (!value || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.trunc(value);
}
