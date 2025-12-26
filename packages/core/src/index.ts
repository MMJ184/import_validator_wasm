import type { Progress, PackedError } from "./types";
import { initValidatorWasm } from "./wasm";
export { defaultWasmUrl } from "./wasmUrl";

export type { Progress, PackedError };

let wasmReady: Promise<ReturnType<typeof initValidatorWasm> extends Promise<infer T> ? T : never> | null = null;

export function initWasm(wasmUrl?: string | URL) {
    if (!wasmReady) wasmReady = initValidatorWasm(wasmUrl);
    return wasmReady;
}

async function requireMod() {
    if (!wasmReady) throw new Error("WASM not initialized. Call initWasm(wasmUrl) first.");
    return await wasmReady;
}

export class Engine {
    private engine: any;
    private constructor() {}

    static async create(schema: object, maxErrors: number, emitNormalized: boolean) {
        const mod = await requireMod();
        const inst = new Engine();
        inst.engine = new mod.ValidatorEngine(JSON.stringify(schema), maxErrors, emitNormalized);
        return inst;
    }

    pushChunk(chunk: Uint8Array, finalChunk: boolean): Progress {
        const json = this.engine.push_chunk(chunk, finalChunk) as unknown as string;
        return JSON.parse(json);
    }

    takeErrors(max: number): PackedError[] {
        const raw: number[] = this.engine.take_errors_packed(max);
        const out: PackedError[] = [];
        for (let i = 0; i < raw.length; i += 2) {
            const row = raw[i];
            const w1 = raw[i + 1];
            out.push({ row, col: w1 >>> 8, code: w1 & 0xff });
        }
        return out;
    }

    takeNormalized(): Uint8Array {
        return this.engine.take_normalized();
    }

    schemaColumns(): string[] {
        return JSON.parse(this.engine.schema_columns_json());
    }

    static async errorCodeToString(code: number): Promise<string> {
        const mod = await requireMod();
        return mod.ValidatorEngine.error_code_to_string(code);
    }
}
