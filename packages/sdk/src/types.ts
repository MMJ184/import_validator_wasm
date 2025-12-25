import type { PackedError, Progress } from "@import-validator/core";

export interface ValidatorEvents {
    onReady?(columns: string[]): void;
    onProgress?(p: Progress): void;
    onErrors?(errors: PackedError[]): void;
    onNormalized?(chunk: Uint8Array): void;
    onDone?(): void;
    onFatal?(msg: string): void;
}

export interface ValidatorOptions {
    wasmUrl: string;
    schema: object;
    maxErrors?: number;
    emitNormalized?: boolean;
}
