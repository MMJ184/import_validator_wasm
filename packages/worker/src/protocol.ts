import type { DecodedError, Progress } from "@import-validator/core";

export type FatalErrorCode =
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

export type FatalErrorPhase = "init" | "estimate" | "validate";

export interface FatalErrorDetails {
    code: FatalErrorCode;
    message: string;
    details?: string;
    retryable: boolean;
    phase: FatalErrorPhase;
    format?: "csv" | "excel";
    fileName?: string;
    fileSizeBytes?: number;
}

export interface WorkerValidateOptions {
    maxErrors?: number;
    emitNormalized?: boolean;
    maxPostErrorsTotal?: number;
    postErrorBatch?: number;
    maxErrorRowsToShow?: number;
    progressFlushRows?: number;
    progressFlushIntervalMs?: number;
    chunkSize?: number;
    estimateChunkSize?: number;
    estimate?: boolean;
    estimateOnly?: boolean;
    format?: "csv" | "excel";
    dryRunRows?: number;
    maxFileBytes?: number;
    maxRowsEstimate?: number;
    maxColumns?: number;
    timeoutMs?: number;
}

export type WorkerInit = {
    type: "init";
    wasmUrl?: string;
    schema: object;
    schemaVersion?: number;
    maxErrors: number;
    emitNormalized: boolean;
};

export type WorkerValidate = {
    type: "validate";
    file: File;
    options: WorkerValidateOptions;
};

export type WorkerEstimate = {
    type: "estimate";
    file: File;
    chunkSize?: number;
    format?: "csv" | "excel";
};

export type WorkerRequest = WorkerInit | WorkerValidate | WorkerEstimate;

export type WorkerResponse =
    | { type: "ready"; columns: string[] }
    | { type: "estimate"; rows: number; avgBytesPerRow: number; columns?: number }
    | { type: "metrics"; metrics: {
        format: "csv" | "excel";
        startedAtMs: number;
        finishedAtMs: number;
        elapsedMs: number;
        rowsProcessed: number;
        errorsPosted: number;
        fileSizeBytes: number;
        rowsPerSec: number;
        dryRun: boolean;
    } }
    | { type: "progress"; progress: Progress }
    | { type: "errors"; errors: DecodedError[] }
    | { type: "normalized"; chunk: Uint8Array }
    | { type: "done" }
    | { type: "fatal"; message: string; error: FatalErrorDetails };
