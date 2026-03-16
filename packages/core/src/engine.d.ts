import { PackedError, Progress } from "./types";
export declare function initWasm(wasmUrl?: string | URL): Promise<any>;
export declare class Engine {
    private engine;
    private cachedSchemaColumns;
    private cachedInputColumns;
    private constructor();
    static create(schema: object, maxErrors: number, emitNormalized: boolean): Promise<Engine>;
    pushChunk(chunk: Uint8Array, finalChunk: boolean): Progress;
    takeErrors(max: number): PackedError[];
    takeNormalized(): Uint8Array;
    schemaColumns(): string[];
    static errorCodeToString(code: number): Promise<string>;
    inputColumns(): string[];
    takeErrorsDecoded(max: number): import("./types").DecodedError[];
    static errorCodeToStringSync(code: number): "MissingRequired" | "InvalidType" | "MaxLengthExceeded" | "MinLengthNotMet" | "NotAllowed" | "InvalidEmail" | "PatternMismatch" | "PrecisionExceeded" | "ColumnCountMismatch" | "InvalidUtf8" | "MissingRequiredColumn" | "ExtraColumn" | "Unknown";
    private static makeMessage;
}
