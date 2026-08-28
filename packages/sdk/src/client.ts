import { createWorker } from "./workerFactory.js";
import type {
    ValidateFileOptions,
    ValidationFatal,
    ValidationFormat,
    ValidationMetrics,
    ValidationProfile,
    ValidatorEvents,
    ValidatorOptions
} from "./types.js";
import {chooseEmitNormalizedSmart, chooseMaxErrorsSmart, profileDefaults} from "./defaults.js";
import { chooseChunkSizeSmart, decodePackedErrors } from "@import-validator/core";

/** Protocol version this SDK speaks (packed errors + cancel). */
const SDK_PROTOCOL_VERSION = 2;

export class ValidatorClient {
    private worker: Worker;
    private events: ValidatorEvents;
    private baseProfile: ValidationProfile;
    /** Constructor-level emitNormalized, if the caller set one explicitly. */
    private baseEmitNormalized: boolean | undefined;

    private isReady = false;
    private pendingValidates: Array<{ file: File; options?: ValidateFileOptions }> = [];

    constructor(opts: ValidatorOptions, events: ValidatorEvents = {}) {
        this.events = events;
        const baseProfile = opts.profile ?? "balanced";
        this.baseProfile = baseProfile;
        this.baseEmitNormalized = opts.emitNormalized;
        const baseDefaults = profileDefaults(baseProfile);

        this.worker = createWorker({
            workerUrl: opts.workerUrl,
            workerFactory: opts.workerFactory,
        });

        this.worker.onmessage = (e) => {
            const m = e.data;

            switch (m.type) {
                case "ready":
                    this.isReady = true;
                    events.onReady?.(m.columns);

                    // flush validates queued before the worker became ready
                    while (this.pendingValidates.length) {
                        const next = this.pendingValidates.shift()!;
                        this.validate(next.file, next.options);
                    }
                    break;
                case "estimate":
                    events.onEstimate?.(m.rows, m.avgBytesPerRow, m.columns);
                    break;
                case "metrics":
                    events.onMetrics?.(m.metrics as ValidationMetrics);
                    break;

                case "progress":
                    events.onProgress?.(m.progress);
                    break;
                case "errors":
                    // v1 path (older worker): pre-decoded error objects
                    events.onErrors?.(m.errors);
                    break;
                case "errorsPacked":
                    // v2 path: packed u32 pairs transferred zero-copy from the
                    // worker; decode into the same DecodedError[] shape here.
                    events.onErrors?.(
                        decodePackedErrors(m.packed, m.schemaColumns, m.inputColumns)
                    );
                    break;
                case "normalized":
                    events.onNormalized?.(m.chunk);
                    break;
                case "done":
                    events.onDone?.(m.errorsSuppressed);
                    break;
                case "fatal":
                    events.onFatal?.(m.message, m.error as ValidationFatal | undefined);
                    break;
            }
        };

        const wasmUrl =
            typeof opts.wasmUrl === "string"
                ? opts.wasmUrl
                : opts.wasmUrl?.toString();

        // Important: send init only once, with string url
        this.worker.postMessage({
            type: "init",
            wasmUrl, // string | undefined
            schema: opts.schema,
            schemaVersion: opts.schemaVersion ?? 1,
            maxErrors: opts.maxErrors ?? 10_000,
            emitNormalized: opts.emitNormalized ?? baseDefaults.emitNormalized,
            protocolVersion: SDK_PROTOCOL_VERSION,
        });
    }

    validate(file: File, options?: ValidateFileOptions) {
        if (!this.isReady) {
            this.pendingValidates.push({ file, options });
            return;
        }
        validateRuntimeOptions(options);

        const maxErrors =
            options?.maxErrors ??
            chooseMaxErrorsSmart(file.size);
        const activeProfile = options?.profile ?? this.baseProfile;
        const defaults = profileDefaults(activeProfile);

        // Per-call option wins; then the constructor's explicit choice (still
        // size-gated); then the profile default. Without the constructor tier
        // `new ValidatorClient({ emitNormalized: true })` would never emit,
        // because every profile default is false.
        const emitNormalized =
            options?.emitNormalized ??
            ((this.baseEmitNormalized ?? defaults.emitNormalized) &&
                chooseEmitNormalizedSmart(file.size));
        const chunkSize =
            options?.chunkSize ??
            chooseChunkSizeSmart(file.size);
        const estimateChunkSize =
            options?.estimateChunkSize ??
            Math.min(chunkSize, 512 * 1024);
        const format = chooseFormat(file, options?.format);
        const estimate = options?.estimate ?? defaults.estimate;
        const estimateOnly = options?.estimateOnly === true;

        this.worker.postMessage({
            type: "validate",
            file,
            options: {
                maxErrors,
                emitNormalized,
                chunkSize,
                estimateChunkSize,
                maxPostErrorsTotal: options?.maxPostErrorsTotal ?? defaults.maxPostErrorsTotal,
                postErrorBatch: options?.postErrorBatch ?? defaults.postErrorBatch,
                maxErrorRowsToShow: options?.maxErrorRowsToShow,
                progressFlushRows: options?.progressFlushRows,
                progressFlushIntervalMs: options?.progressFlushIntervalMs,
                estimate,
                estimateOnly,
                format,
                dryRunRows: options?.dryRunRows,
                maxFileBytes: options?.maxFileBytes,
                maxRowsEstimate: options?.maxRowsEstimate,
                maxColumns: options?.maxColumns,
                timeoutMs: options?.timeoutMs,
            }
        });
    }

    /**
     * Cancel the currently running validation/estimate. The worker aborts
     * cooperatively and reports a fatal with code "CANCELLED". Queued
     * validates that have not reached the worker yet are also dropped.
     */
    cancel() {
        this.pendingValidates.length = 0;
        this.worker.postMessage({ type: "cancel" });
    }

    terminate() {
        this.worker.terminate();
    }
}

function chooseFormat(file: File, format: ValidationFormat | undefined): Exclude<ValidationFormat, "auto"> {
    if (format && format !== "auto") return format;
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "excel";
    return "csv";
}

function validateRuntimeOptions(options?: ValidateFileOptions) {
    if (!options) return;

    assertPositiveInt(options.maxErrors, "maxErrors");
    assertPositiveInt(options.maxPostErrorsTotal, "maxPostErrorsTotal");
    assertPositiveInt(options.postErrorBatch, "postErrorBatch");
    assertPositiveInt(options.maxErrorRowsToShow, "maxErrorRowsToShow");
    assertPositiveInt(options.progressFlushRows, "progressFlushRows");
    assertPositiveInt(options.progressFlushIntervalMs, "progressFlushIntervalMs");
    assertPositiveInt(options.chunkSize, "chunkSize");
    assertPositiveInt(options.estimateChunkSize, "estimateChunkSize");
    assertPositiveInt(options.dryRunRows, "dryRunRows");
    assertPositiveInt(options.maxFileBytes, "maxFileBytes");
    assertPositiveInt(options.maxRowsEstimate, "maxRowsEstimate");
    assertPositiveInt(options.maxColumns, "maxColumns");
    assertPositiveInt(options.timeoutMs, "timeoutMs");
}

function assertPositiveInt(value: number | undefined, name: string) {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}
