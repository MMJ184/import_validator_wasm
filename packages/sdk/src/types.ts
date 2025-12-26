import type {DecodedError, Progress} from "@import-validator/core";

export interface ValidatorEvents {
    onReady?(columns: string[]): void;
    onProgress?(p: Progress): void;
    onErrors?(errors: DecodedError[]): void;
    onNormalized?(chunk: Uint8Array): void;
    onDone?(): void;
    onFatal?(msg: string): void;
}

export interface ValidatorOptions {
    schema: object;

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
}
