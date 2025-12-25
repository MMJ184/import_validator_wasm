import { initWasm, Engine } from "@import-validator/core";

export async function createEngine(
    wasmUrl: string,
    schema: object,
    maxErrors: number,
    emitNormalized: boolean
) {
    await initWasm(wasmUrl);
    return new Engine(schema, maxErrors, emitNormalized);
}
