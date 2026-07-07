import type { FatalErrorCode, FatalErrorDetails, WorkerRequest } from "./protocol";

export class WorkerValidationError extends Error {
    readonly code: FatalErrorCode;
    readonly details?: string;
    readonly retryable: boolean;

    constructor(code: FatalErrorCode, message: string, opts?: { details?: string; retryable?: boolean }) {
        super(message);
        this.code = code;
        this.details = opts?.details;
        this.retryable = opts?.retryable ?? false;
    }
}

export function toFatalError(err: unknown, req: WorkerRequest): FatalErrorDetails {
    const phase = requestPhase(req);
    const format = requestFormat(req);
    const fileName = requestFileName(req);
    const fileSizeBytes = requestFileSize(req);

    if (err instanceof WorkerValidationError) {
        return {
            code: err.code,
            message: err.message,
            details: err.details,
            retryable: err.retryable,
            phase,
            format,
            fileName,
            fileSizeBytes,
        };
    }

    const rawMessage =
        err instanceof Error
            ? err.message
            : typeof err === "string"
                ? err
                : String(err);

    const code = inferFatalCode(rawMessage);
    const details = errorDetails(err);

    return {
        code,
        message: friendlyMessage(code, rawMessage),
        details,
        retryable: code === "TIMEOUT" || code === "WASM_RUNTIME",
        phase,
        format,
        fileName,
        fileSizeBytes,
    };
}

export function inferFatalCode(message: string): FatalErrorCode {
    const text = message.toLowerCase();
    if (text.includes("unsupported schemaversion")) return "SCHEMA_VERSION_UNSUPPORTED";
    if (text.includes("wasmurl is required")) return "WASM_URL_REQUIRED";
    if (text.includes("engine not initialized")) return "ENGINE_NOT_INITIALIZED";
    if (text.includes("exceeds maxfilebytes")) return "FILE_TOO_LARGE";
    if (text.includes("is too large") && text.includes("limit is")) return "FILE_TOO_LARGE";
    if (text.includes("too many entries") && text.includes("xlsx")) return "FILE_TOO_LARGE";
    if (text.includes("decompressed size exceeds safe limit")) return "FILE_TOO_LARGE";
    if (text.includes("maxrowsestimate")) return "ROWS_LIMIT_EXCEEDED";
    if (text.includes("maxcolumns")) return "COLUMNS_LIMIT_EXCEEDED";
    if (text.includes("cancelled by client")) return "CANCELLED";
    if (text.includes("timeout")) return "TIMEOUT";
    if (text.includes("excel validation is routed separately")) return "EXCEL_ROUTE_DISABLED";
    if (
        text.includes("unreachable") ||
        text.includes("validator engine crashed") ||
        text.includes("panic") ||
        text.includes("function import requires a callable")
    ) {
        return "WASM_RUNTIME";
    }
    return "VALIDATION_FAILED";
}

export function friendlyMessage(code: FatalErrorCode, rawMessage: string): string {
    switch (code) {
        case "SCHEMA_VERSION_UNSUPPORTED":
            return "Schema version is not supported by this runtime.";
        case "WASM_URL_REQUIRED":
            return "WASM runtime URL is missing.";
        case "ENGINE_NOT_INITIALIZED":
            return "Validation engine is not initialized.";
        case "FILE_TOO_LARGE":
            return "Uploaded file exceeds allowed size.";
        case "ROWS_LIMIT_EXCEEDED":
            return "Estimated row count exceeds configured limit.";
        case "COLUMNS_LIMIT_EXCEEDED":
            return "Estimated column count exceeds configured limit.";
        case "TIMEOUT":
            return "Validation timed out before completion.";
        case "WASM_RUNTIME":
            return "Internal WASM runtime error while validating input.";
        case "EXCEL_ROUTE_DISABLED":
            return "Excel route is not enabled in this build.";
        default:
            return rawMessage;
    }
}

export function formatFatalMessage(fatal: FatalErrorDetails): string {
    const contextParts = [
        `phase=${fatal.phase}`,
        fatal.format ? `format=${fatal.format}` : "",
        fatal.fileName ? `file=${fatal.fileName}` : "",
        typeof fatal.fileSizeBytes === "number" ? `size=${fatal.fileSizeBytes} bytes` : "",
    ].filter(Boolean);
    const context = contextParts.length ? ` (${contextParts.join(", ")})` : "";
    const details = fatal.details ? `\nDetails: ${fatal.details}` : "";
    return `[${fatal.code}] ${fatal.message}${context}${details}`;
}

function errorDetails(err: unknown): string | undefined {
    if (!(err instanceof Error)) return undefined;
    const stackTop = err.stack?.split("\n").slice(0, 2).join(" | ");
    if (!stackTop) return err.message;
    return `${err.message} | ${stackTop}`;
}

function requestPhase(req: WorkerRequest): FatalErrorDetails["phase"] {
    if (req.type === "init") return "init";
    if (req.type === "estimate") return "estimate";
    return "validate";
}

function requestFormat(req: WorkerRequest): FatalErrorDetails["format"] | undefined {
    if (req.type === "estimate") return req.format ?? "csv";
    if (req.type === "validate") return req.options.format ?? "csv";
    return undefined;
}

function requestFileName(req: WorkerRequest): string | undefined {
    if (req.type !== "validate" && req.type !== "estimate") return undefined;
    return req.file?.name;
}

function requestFileSize(req: WorkerRequest): number | undefined {
    if (req.type !== "validate" && req.type !== "estimate") return undefined;
    return req.file?.size;
}
