import type {DecodedError, Progress} from "@import-validator/core";

export type ValidationFormat = "auto" | "csv" | "excel";
export type ValidationProfile = "fast" | "balanced" | "strict";
export type ValidationFatalCode =
    | "SCHEMA_VERSION_UNSUPPORTED"
    | "WASM_URL_REQUIRED"
    | "ENGINE_NOT_INITIALIZED"
    | "FILE_TOO_LARGE"
    | "ROWS_LIMIT_EXCEEDED"
    | "COLUMNS_LIMIT_EXCEEDED"
    | "TIMEOUT"
    | "WASM_RUNTIME"
    | "EXCEL_ROUTE_DISABLED"
    | "VALIDATION_FAILED";

export type ValidationFatalPhase = "init" | "estimate" | "validate";

export interface ValidationFatal {
    code: ValidationFatalCode;
    message: string;
    details?: string;
    retryable: boolean;
    phase: ValidationFatalPhase;
    format?: "csv" | "excel";
    fileName?: string;
    fileSizeBytes?: number;
}

export interface ValidatorEvents {
    onReady?(columns: string[]): void;
    onEstimate?(rows: number, avgBytesPerRow: number, columns?: number): void;
    onMetrics?(m: ValidationMetrics): void;
    onProgress?(p: Progress): void;
    onErrors?(errors: DecodedError[]): void;
    onNormalized?(chunk: Uint8Array): void;
    onDone?(): void;
    onFatal?(msg: string, fatal?: ValidationFatal): void;
}

export interface ValidationMetrics {
    format: Exclude<ValidationFormat, "auto">;
    startedAtMs: number;
    finishedAtMs: number;
    elapsedMs: number;
    rowsProcessed: number;
    errorsPosted: number;
    fileSizeBytes: number;
    rowsPerSec: number;
    dryRun: boolean;
}

export interface ValidatorOptions {
    schema: object;

    /**
     * Version of request schema contract sent from customer app.
     * Default is 1.
     */
    schemaVersion?: number;

    /**
     * Optional. If not provided, core can still use its own default wasm URL
     * (recommended: always provide in real apps).
     */
    wasmUrl?: string | URL;

    /**
     * Recommended: Provide a resolved Worker URL (works in all bundlers).
     */
    workerUrl?: string | URL;

    /**
     * Alternative to workerUrl: provide a Worker factory.
     */
    workerFactory?: () => Worker;

    maxErrors?: number;
    emitNormalized?: boolean;
    profile?: ValidationProfile;
}

export interface ValidateFileOptions {
    /**
     * Override max errors for THIS file only
     */
    maxErrors?: number;

    /**
     * Override normalized output for THIS file only
     */
    emitNormalized?: boolean;

    /**
     * Safety cap for UI
     */
    maxPostErrorsTotal?: number;

    /**
     * Errors per postMessage batch
     */
    postErrorBatch?: number;

    /**
     * Limit errors emitted to UI by distinct row count.
     * Example: 100 means show errors from at most 100 rows.
     */
    maxErrorRowsToShow?: number;

    /**
     * Emit progress to UI after at least N processed rows.
     * Larger values reduce postMessage overhead.
     */
    progressFlushRows?: number;

    /**
     * Emit progress to UI at least once every N milliseconds.
     */
    progressFlushIntervalMs?: number;

    /**
     * Optional override chunk size (advanced users)
     */
    chunkSize?: number;

    /**
     * Optional override chunk size for estimate pre-pass only.
     */
    estimateChunkSize?: number;

    /**
     * If true, run a separate chunked estimate pass before validate.
     * Default: false
     */
    estimate?: boolean;

    /**
     * If true, only run estimate pre-pass and skip full validation.
     * Useful for "can this file be handled?" checks.
     */
    estimateOnly?: boolean;

    /**
     * CSV/Excel route selection. Default: auto (by extension).
     */
    format?: ValidationFormat;

    /**
     * Stop validation after N rows for dry-run UX.
     */
    dryRunRows?: number;

    /**
     * Hard guardrails for multi-tenant safety.
     */
    maxFileBytes?: number;
    maxRowsEstimate?: number;
    maxColumns?: number;

    /**
     * Optional timeout for worker-side operation.
     */
    timeoutMs?: number;

    /**
     * Profile override for per-file behavior.
     */
    profile?: ValidationProfile;
}
