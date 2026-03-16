import type { Engine } from "@import-validator/core";
import type { WorkerResponse } from "../protocol";

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
};

export async function runCsv(
    file: File,
    engine: Engine,
    post: (msg: WorkerResponse) => void,
    opts: CsvRunOptions = {}
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    const chunkSize = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : undefined;
    const source = streamFile(file, chunkSize, opts.signal);
    return await runCsvChunks(source, engine, post, opts);
}

export async function runCsvChunks(
    source: AsyncIterable<Uint8Array>,
    engine: Engine,
    post: (msg: WorkerResponse) => void,
    opts: CsvRunOptions = {}
): Promise<{ rowsProcessed: number; errorsPosted: number }> {
    const emitNormalized = opts.emitNormalized ?? false;
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

    let totalPostedErrors = 0;
    let totalRowsProcessed = 0;
    const shownRows = new Set<number>();
    let rowLimitReached = false;
    let pendingProgress = { rowsProcessed: 0, errorsAdded: 0, done: false };
    let lastProgressPostAt = Date.now();

    const flushErrorsDecoded = () => {
        if (rowLimitReached) {
            drainErrorsPacked(engine);
            return;
        }
        while (true) {
            if (totalPostedErrors >= maxPostErrorsTotal) return;

            const remaining = maxPostErrorsTotal - totalPostedErrors;
            const requestSize = Math.min(postErrorBatch, remaining);
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

            if (visibleBatch.length) {
                totalPostedErrors += visibleBatch.length;
                post({ type: "errors", errors: visibleBatch });
            }

            if (rowLimitReached) {
                drainErrorsPacked(engine);
                return;
            }
        }
    };

    for await (const value of source) {
        throwIfAborted(signal);
        const progress = pushChunkSafe(engine, value, false, totalRowsProcessed);
        totalRowsProcessed += progress.rowsProcessed;
        pendingProgress.rowsProcessed += progress.rowsProcessed;
        pendingProgress.errorsAdded += progress.errorsAdded;
        pendingProgress.done = pendingProgress.done || progress.done;
        flushProgress(false);

        flushErrorsDecoded();

        if (emitNormalized) {
            const normalized = engine.takeNormalized();
            if (normalized.length) post({ type: "normalized", chunk: normalized });
        }

        if (dryRunRows && totalRowsProcessed >= dryRunRows) break;
    }

    throwIfAborted(signal);

    const finalProgress = pushChunkSafe(engine, new Uint8Array(), true, totalRowsProcessed);
    totalRowsProcessed += finalProgress.rowsProcessed;
    pendingProgress.rowsProcessed += finalProgress.rowsProcessed;
    pendingProgress.errorsAdded += finalProgress.errorsAdded;
    pendingProgress.done = pendingProgress.done || finalProgress.done;
    flushProgress(true);

    flushErrorsDecoded();

    if (emitNormalized) {
        const normalized = engine.takeNormalized();
        if (normalized.length) post({ type: "normalized", chunk: normalized });
    }

    post({ type: "done" });
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

function drainErrorsPacked(engine: Engine) {
    while (true) {
        const batch = engine.takeErrors(10_000);
        if (!batch.length) return;
    }
}

function pushChunkSafe(
    engine: Engine,
    chunk: Uint8Array,
    finalChunk: boolean,
    rowsProcessedSoFar: number
) {
    try {
        return engine.pushChunk(chunk, finalChunk);
    } catch (err: any) {
        const base = err?.message || String(err);
        const at = rowsProcessedSoFar > 0 ? ` around row ${rowsProcessedSoFar}` : "";
        throw new Error(`Validator engine crashed${at}: ${base}`);
    }
}

async function* streamFile(file: File, chunkSize?: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (chunkSize) {
        for (let offset = 0; offset < file.size; offset += chunkSize) {
            throwIfAborted(signal);
            const part = file.slice(offset, offset + chunkSize);
            const buf = await part.arrayBuffer();
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
