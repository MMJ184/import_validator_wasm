import type { DecodedError, Progress } from "@import-validator/core";

/**
 * Worker protocol version. v2 adds packed-error transfer ("errorsPacked"
 * messages, decoded in the SDK) and the "cancel" request. A v1 client (older
 * SDK) that omits protocolVersion in init keeps receiving decoded "errors"
 * messages — new worker, old SDK stays compatible.
 */
export const WORKER_PROTOCOL_VERSION = 2;

export type FatalErrorCode =
    | "SCHEMA_VERSION_UNSUPPORTED"
    | "WASM_URL_REQUIRED"
    | "ENGINE_NOT_INITIALIZED"
    | "FILE_TOO_LARGE"
    | "ROWS_LIMIT_EXCEEDED"
    | "COLUMNS_LIMIT_EXCEEDED"
    | "TIMEOUT"
    | "CANCELLED"
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
    /** Highest protocol version the client understands (default 1). */
    protocolVersion?: number;
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

/** Abort the currently running validate/estimate operation. */
export type WorkerCancel = {
    type: "cancel";
};

export type WorkerRequest = WorkerInit | WorkerValidate | WorkerEstimate | WorkerCancel;

export type WorkerResponse =
    | { type: "ready"; columns: string[]; protocolVersion?: number; engineVersion?: string }
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
    /**
     * v2: packed errors (2 u32 words per error, transferable buffer) plus the
     * column tables needed to decode them. Decoded by the SDK into the same
     * DecodedError[] shape apps already consume.
     */
    | { type: "errorsPacked"; packed: Uint32Array; schemaColumns: string[]; inputColumns: string[] }
    | { type: "normalized"; chunk: Uint8Array }
    /**
     * `errorsSuppressed`: every error found but not delivered — capped by the
     * engine's `maxErrors` queue, filtered out by `maxErrorRowsToShow`, or
     * still queued when `maxPostErrorsTotal` was reached. Errors received plus
     * this is the exact total for the rows that were validated, which is the
     * whole file unless `dryRunRows` stopped it early.
     */
    | { type: "done"; errorsSuppressed?: number }
    | { type: "fatal"; message: string; error: FatalErrorDetails };

/** postMessage sink with optional transfer list (zero-copy for big buffers). */
export type PostFn = (msg: WorkerResponse, transfer?: Transferable[]) => void;
