import { chooseChunkSizeSmart } from "@import-validator/core";
import { createEngine, engineVersion } from "./loaders/wasmLoader";
import { formatFatalMessage, toFatalError, WorkerValidationError } from "./errorTaxonomy";
import { assertSupportedSchemaVersion, deriveValidatePassFlags } from "./flow";
import { estimateCsv, type CsvEstimate } from "./pipeline/estimateCsv";
import { runCsv } from "./pipeline/csvPipeline";
import {
    estimateXlsx,
    openXlsxSource,
    runXlsx,
    type OpenedXlsx,
    type XlsxEstimate,
} from "./pipeline/xlsxPipeline";
import {
    WORKER_PROTOCOL_VERSION,
    type PostFn,
    type WorkerRequest,
    type WorkerResponse,
    type WorkerValidate,
    type WorkerValidateOptions,
} from "./protocol";

type WorkerInitState = {
    wasmUrl: string;
    schema: object;
    defaultMaxErrors: number;
    defaultEmitNormalized: boolean;
    schemaDelimiter?: number | string;
    schemaHasHeaders: boolean;
    /** Protocol version negotiated with the client (1 = legacy decoded errors). */
    clientProtocolVersion: number;
};

type CachedEngine = {
    engine: import("@import-validator/core").Engine;
    maxErrors: number;
    emitNormalized: boolean;
};

let initState: WorkerInitState | null = null;
let cachedEngine: CachedEngine | null = null;
let operationQueue: Promise<void> = Promise.resolve();
/** Abort controller for the operation currently running (validate/estimate). */
let currentOperation: AbortController | null = null;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    const req = e.data;
    const post: PostFn = (m: WorkerResponse, transfer?: Transferable[]) =>
        (self as unknown as Worker).postMessage(m, transfer ?? []);

    // Cancel is handled immediately, NOT queued — it must reach a running
    // operation, not wait behind it.
    if (req.type === "cancel") {
        currentOperation?.abort("cancel");
        return;
    }

    enqueue(req, post, async () => {
        if (req.type === "init") {
            await handleInit(req, post);
            return;
        }
        if (req.type === "validate") {
            await handleValidate(req, post);
            return;
        }
        if (req.type === "estimate") {
            await handleEstimate(req, post);
            return;
        }
    });
};

function enqueue(
    req: WorkerRequest,
    post: PostFn,
    task: () => Promise<void>
) {
    operationQueue = operationQueue
        .then(task)
        .catch((err: unknown) => {
            const fatal = toFatalError(err, req);
            post({ type: "fatal", message: formatFatalMessage(fatal), error: fatal });
        });
}

async function handleInit(
    req: Extract<WorkerRequest, { type: "init" }>,
    post: PostFn
) {
    assertSupportedSchemaVersion(req.schemaVersion);
    if (!req.wasmUrl) {
        throw new WorkerValidationError(
            "WASM_URL_REQUIRED",
            "wasmUrl is required (pass it from SDK/client)."
        );
    }

    const warmupEngine = await createEngine(
        req.wasmUrl,
        req.schema,
        req.maxErrors,
        req.emitNormalized
    );

    initState = {
        wasmUrl: req.wasmUrl,
        schema: req.schema,
        defaultMaxErrors: req.maxErrors,
        defaultEmitNormalized: req.emitNormalized,
        schemaDelimiter: extractSchemaDelimiter(req.schema),
        schemaHasHeaders: extractSchemaHasHeaders(req.schema),
        clientProtocolVersion: Math.min(req.protocolVersion ?? 1, WORKER_PROTOCOL_VERSION),
    };

    // Cache the warmup engine so the first validate call reuses it instead of
    // allocating a second engine immediately after init.
    cachedEngine = { engine: warmupEngine, maxErrors: req.maxErrors, emitNormalized: req.emitNormalized };

    post({
        type: "ready",
        columns: warmupEngine.schemaColumns(),
        protocolVersion: initState.clientProtocolVersion,
        engineVersion: await engineVersion(),
    });
}

async function handleValidate(
    req: WorkerValidate,
    post: PostFn
) {
    if (!initState) {
        throw new WorkerValidationError("ENGINE_NOT_INITIALIZED", "Engine not initialized");
    }
    const state = initState;

    if (req.options.maxFileBytes && req.file.size > req.options.maxFileBytes) {
        throw new WorkerValidationError(
            "FILE_TOO_LARGE",
            `File size ${req.file.size} exceeds maxFileBytes=${req.options.maxFileBytes}`,
            {
                details: `Uploaded file is ${req.file.size} bytes but limit is ${req.options.maxFileBytes} bytes.`
            }
        );
    }

    const startedAtMs = Date.now();
    const format = req.options.format ?? "csv";
    const validateChunkSize = resolveChunkSize(req.file.size, req.options.chunkSize, "validate");
    const estimateChunkSize = resolveChunkSize(
        req.file.size,
        req.options.estimateChunkSize ?? req.options.chunkSize,
        "estimate"
    );
    const flags = deriveValidatePassFlags(req.options);

    const result = await runCancellable(
        (signal) => validateWithSignal(
            req,
            post,
            state,
            format,
            flags.shouldEmitEstimate,
            flags.estimateOnly,
            flags.needsCsvEstimate,
            validateChunkSize,
            estimateChunkSize,
            signal
        ),
        req.options.timeoutMs
    );

    const safeResult = result ?? { rowsProcessed: 0, errorsPosted: 0, dryRun: false };
    postMetrics(post, {
        format,
        startedAtMs,
        finishedAtMs: Date.now(),
        rowsProcessed: safeResult.rowsProcessed,
        errorsPosted: safeResult.errorsPosted,
        fileSizeBytes: req.file.size,
        dryRun: safeResult.dryRun || !!req.options.dryRunRows,
    });
}

async function handleEstimate(
    req: Extract<WorkerRequest, { type: "estimate" }>,
    post: PostFn
) {
    const format = req.format ?? "csv";
    const estimateChunkSize = resolveChunkSize(req.file.size, req.chunkSize, "estimate");
    const out = await runCancellable(async (signal) => {
        return format === "excel"
            ? await estimateXlsx(req.file, { signal })
            : await estimateCsv(req.file, estimateChunkSize, {
                delimiter: initState?.schemaDelimiter,
                hasHeaders: initState?.schemaHasHeaders ?? true,
                signal,
            });
    }, undefined);
    post({ type: "estimate", rows: out.rows, avgBytesPerRow: out.avgBytesPerRow, columns: out.columns });
}

async function validateWithSignal(
    req: WorkerValidate,
    post: PostFn,
    state: WorkerInitState,
    format: "csv" | "excel",
    shouldEmitEstimate: boolean,
    estimateOnly: boolean,
    needsCsvEstimate: boolean,
    validateChunkSize: number,
    estimateChunkSize: number,
    signal?: AbortSignal
): Promise<{ rowsProcessed: number; errorsPosted: number; dryRun: boolean }> {
    const postPackedErrors = state.clientProtocolVersion >= 2;

    if (format === "excel") {
        // Parse the ZIP container once; the estimate preflight and the
        // validation run share it (the sheet used to be inflated twice).
        const opened = await openXlsxSource(req.file);

        const needsExcelEstimate =
            shouldEmitEstimate ||
            !!req.options.maxRowsEstimate ||
            !!req.options.maxColumns ||
            estimateOnly;
        await runExcelPreflight(
            req.file,
            req.options,
            post,
            shouldEmitEstimate,
            needsExcelEstimate,
            opened,
            signal
        );

        if (estimateOnly) {
            post({ type: "done" });
            return { rowsProcessed: 0, errorsPosted: 0, dryRun: true };
        }

        const maxErrors = req.options.maxErrors ?? state.defaultMaxErrors;
        const emitNormalized = req.options.emitNormalized ?? state.defaultEmitNormalized;
        const engine = await takeOrCreateEngine(state, maxErrors, emitNormalized);

        const out = await runXlsx(req.file, engine, post, {
            emitNormalized: req.options.emitNormalized,
            maxPostErrorsTotal: req.options.maxPostErrorsTotal,
            postErrorBatch: req.options.postErrorBatch,
            maxErrorRowsToShow: req.options.maxErrorRowsToShow,
            progressFlushRows: req.options.progressFlushRows,
            progressFlushIntervalMs: req.options.progressFlushIntervalMs,
            chunkSize: validateChunkSize,
            dryRunRows: req.options.dryRunRows,
            signal,
            postPackedErrors,
        }, opened);
        return { ...out, dryRun: false };
    }

    await runCsvPreflight(
        req.file,
        req.options,
        post,
        shouldEmitEstimate,
        needsCsvEstimate,
        estimateChunkSize,
        state.schemaDelimiter,
        state.schemaHasHeaders,
        signal
    );
    if (estimateOnly) {
        post({ type: "done" });
        return { rowsProcessed: 0, errorsPosted: 0, dryRun: true };
    }

    const maxErrors = req.options.maxErrors ?? state.defaultMaxErrors;
    const emitNormalized = req.options.emitNormalized ?? state.defaultEmitNormalized;
    const engine = await takeOrCreateEngine(state, maxErrors, emitNormalized);

    const out = await runCsv(req.file, engine, post, {
        emitNormalized: req.options.emitNormalized,
        maxPostErrorsTotal: req.options.maxPostErrorsTotal,
        postErrorBatch: req.options.postErrorBatch,
        maxErrorRowsToShow: req.options.maxErrorRowsToShow,
        progressFlushRows: req.options.progressFlushRows,
        progressFlushIntervalMs: req.options.progressFlushIntervalMs,
        chunkSize: validateChunkSize,
        dryRunRows: req.options.dryRunRows,
        signal,
        postPackedErrors,
    });
    return { ...out, dryRun: false };
}

async function runCsvPreflight(
    file: File,
    options: WorkerValidateOptions,
    post: PostFn,
    shouldEmitEstimate: boolean,
    needsEstimate: boolean,
    estimateChunkSize: number,
    schemaDelimiter: number | string | undefined,
    schemaHasHeaders: boolean,
    signal?: AbortSignal
): Promise<CsvEstimate | undefined> {
    if (!needsEstimate) {
        return undefined;
    }

    const estimate = await estimateCsv(file, estimateChunkSize, {
        delimiter: schemaDelimiter,
        hasHeaders: schemaHasHeaders,
        signal,
    });
    enforceEstimateLimits(options, estimate);

    if (shouldEmitEstimate) {
        post({ type: "estimate", rows: estimate.rows, avgBytesPerRow: estimate.avgBytesPerRow, columns: estimate.columns });
    }

    return estimate;
}

async function runExcelPreflight(
    file: File,
    options: WorkerValidateOptions,
    post: PostFn,
    shouldEmitEstimate: boolean,
    needsEstimate: boolean,
    opened: OpenedXlsx,
    signal?: AbortSignal
): Promise<XlsxEstimate | undefined> {
    if (!needsEstimate) {
        return undefined;
    }

    const estimate = await estimateXlsx(file, {
        signal,
        preferDimension: !options.maxRowsEstimate && !options.maxColumns,
        opened,
    });
    enforceEstimateLimits(options, estimate);

    if (shouldEmitEstimate) {
        post({ type: "estimate", rows: estimate.rows, avgBytesPerRow: estimate.avgBytesPerRow, columns: estimate.columns });
    }

    return estimate;
}

function enforceEstimateLimits(
    options: WorkerValidateOptions,
    estimate: { rows: number; columns?: number }
) {
    if (options.maxRowsEstimate && estimate.rows > options.maxRowsEstimate) {
        throw new WorkerValidationError(
            "ROWS_LIMIT_EXCEEDED",
            `Estimated rows ${estimate.rows} exceeds maxRowsEstimate=${options.maxRowsEstimate}`
        );
    }

    if (options.maxColumns && estimate.columns && estimate.columns > options.maxColumns) {
        throw new WorkerValidationError(
            "COLUMNS_LIMIT_EXCEEDED",
            `Estimated columns ${estimate.columns} exceeds maxColumns=${options.maxColumns}`
        );
    }
}

function resolveChunkSize(
    fileSizeBytes: number,
    requestedChunkSize: number | undefined,
    mode: "estimate" | "validate"
): number {
    if (requestedChunkSize && requestedChunkSize > 0) return requestedChunkSize;
    const baseChunk = chooseChunkSizeSmart(fileSizeBytes);
    if (mode === "estimate") return Math.min(baseChunk, 512 * 1024);
    return baseChunk;
}

/**
 * Run an operation with cancel support (worker "cancel" message) and an
 * optional timeout. Both abort the same signal; the abort reason
 * distinguishes TIMEOUT from CANCELLED in the fatal taxonomy.
 */
async function runCancellable<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    timeoutMs?: number
): Promise<T> {
    const controller = new AbortController();
    currentOperation = controller;
    const timer =
        timeoutMs && timeoutMs > 0
            ? setTimeout(() => controller.abort("timeout"), timeoutMs)
            : null;

    try {
        return await fn(controller.signal);
    } catch (err) {
        if (controller.signal.aborted) {
            if (controller.signal.reason === "cancel") {
                throw new WorkerValidationError("CANCELLED", "Validation cancelled by client.", { retryable: true });
            }
            throw new WorkerValidationError("TIMEOUT", `Validation timeout after ${timeoutMs} ms`, { retryable: true });
        }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
        if (currentOperation === controller) currentOperation = null;
    }
}

async function takeOrCreateEngine(
    state: WorkerInitState,
    maxErrors: number,
    emitNormalized: boolean
): Promise<import("@import-validator/core").Engine> {
    if (
        cachedEngine &&
        cachedEngine.maxErrors === maxErrors &&
        cachedEngine.emitNormalized === emitNormalized
    ) {
        const eng = cachedEngine.engine;
        cachedEngine = null;
        return eng;
    }
    return createEngine(state.wasmUrl, state.schema, maxErrors, emitNormalized);
}

function extractSchemaDelimiter(schema: object): number | string | undefined {
    const raw = (schema as any)?.delimiter;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") return raw;
    return undefined;
}

function extractSchemaHasHeaders(schema: object): boolean {
    const raw = (schema as any)?.hasHeaders;
    return typeof raw === "boolean" ? raw : true;
}

function postMetrics(
    post: PostFn,
    data: {
        format: "csv" | "excel";
        startedAtMs: number;
        finishedAtMs: number;
        rowsProcessed: number;
        errorsPosted: number;
        fileSizeBytes: number;
        dryRun: boolean;
    }
) {
    const elapsedMs = Math.max(1, data.finishedAtMs - data.startedAtMs);
    const rowsPerSec = Math.round((data.rowsProcessed * 1000) / elapsedMs);
    post({
        type: "metrics",
        metrics: {
            format: data.format,
            startedAtMs: data.startedAtMs,
            finishedAtMs: data.finishedAtMs,
            elapsedMs,
            rowsProcessed: data.rowsProcessed,
            errorsPosted: data.errorsPosted,
            fileSizeBytes: data.fileSizeBytes,
            rowsPerSec,
            dryRun: data.dryRun,
        },
    });
}
