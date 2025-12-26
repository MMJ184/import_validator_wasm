import type { PackedError, Progress } from "@import-validator/core";

export type WorkerInit = {
    type: "init";
    wasmUrl?: string;
    schema: object;
    maxErrors: number;
    emitNormalized: boolean;
};

export type WorkerValidate = {
    type: "validate";
    file: File;
};

export type WorkerRequest = WorkerInit | WorkerValidate;

export type WorkerResponse =
    | { type: "ready"; columns: string[] }
    | { type: "progress"; progress: Progress }
    | { type: "errors"; errors: PackedError[] }
    | { type: "normalized"; chunk: Uint8Array }
    | { type: "done" }
    | { type: "fatal"; message: string };
