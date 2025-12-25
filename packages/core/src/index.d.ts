import { Progress, PackedError } from "./types";
export type { Progress, PackedError };
export declare function initWasm(wasmUrl: string): Promise<void>;
export declare class Engine {
    private engine;
    constructor(schema: object, maxErrors: number, emitNormalized: boolean);
    pushChunk(chunk: Uint8Array, finalChunk: boolean): Progress;
    takeErrors(max: number): PackedError[];
    takeNormalized(): Uint8Array;
    schemaColumns(): string[];
    static errorCodeToString(code: number): string;
}
