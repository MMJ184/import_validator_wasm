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
import { chooseChunkSizeSmart } from "@import-validator/core";

export class ValidatorClient {
    private worker: Worker;
    private events: ValidatorEvents;
    private baseProfile: ValidationProfile;

    private isReady = false;
    private pendingValidate: { file: File; options?: ValidateFileOptions } | null = null;

    constructor(opts: ValidatorOptions, events: ValidatorEvents = {}) {
        this.events = events;
        const baseProfile = opts.profile ?? "balanced";
        this.baseProfile = baseProfile;
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

                    // flush queued validate if user called validate early
                    if (this.pendingValidate) {
                        const { file, options } = this.pendingValidate;
                        this.pendingValidate = null;
                        this.validate(file, options);
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
                    events.onErrors?.(m.errors);
                    break;
                case "normalized":
                    events.onNormalized?.(m.chunk);
                    break;
                case "done":
                    events.onDone?.();
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
        });
    }

    validate(file: File, options?: ValidateFileOptions) {
        if (!this.isReady) {
            this.pendingValidate = { file, options };
            return;
        }
        validateRuntimeOptions(options);

        const maxErrors =
            options?.maxErrors ??
            chooseMaxErrorsSmart(file.size);
        const activeProfile = options?.profile ?? this.baseProfile;
        const defaults = profileDefaults(activeProfile);

        const emitNormalized =
            options?.emitNormalized ??
            (defaults.emitNormalized && chooseEmitNormalizedSmart(file.size));
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
