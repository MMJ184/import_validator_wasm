import type { Progress, PackedError, DecodedError } from "../types";
import { Engine } from "../engine";
import { type ChunkSource } from "./sources";
export type ValidateCsvOptions = {
    chunkSize?: number;
    drainErrorsEvery?: number;
    drainNormalized?: boolean;
    decodeErrors?: boolean;
    onProgress?: (p: Progress) => void;
    signal?: AbortSignal;
};
export declare function validateCsv(engine: Engine, input: ChunkSource, opts?: ValidateCsvOptions): Promise<{
    progress: Progress;
    errorsPacked: PackedError[];
    errorsDecoded: DecodedError[] | undefined;
    normalized: Uint8Array<ArrayBuffer> | undefined;
    chunkSizeUsed: number;
}>;
