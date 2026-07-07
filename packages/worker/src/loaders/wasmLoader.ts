import { initWasm, Engine } from "@import-validator/core";

export async function createEngine(
    wasmUrl: string,
    schema: object,
    maxErrors: number,
    emitNormalized: boolean
) {
    await initWasm(wasmUrl);
    return await Engine.create(schema, maxErrors, emitNormalized);
}

/** Engine crate version (for the ready handshake / diagnostics). */
export async function engineVersion(): Promise<string | undefined> {
    try {
        const mod = await initWasm();
        return typeof mod.engine_version === "function" ? mod.engine_version() : undefined;
    } catch {
        return undefined;
    }
}
