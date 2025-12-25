import init, { ValidatorEngine } from "./wasm/pkg/import_validator_wasm";
import { Progress, PackedError } from "./types";

export type { Progress, PackedError };

export async function initWasm(wasmUrl: string) {
    await init(wasmUrl);
}

export class Engine {
    private engine: ValidatorEngine;

    constructor(schema: object, maxErrors: number, emitNormalized: boolean) {
        this.engine = new ValidatorEngine(
            JSON.stringify(schema),
            maxErrors,
            emitNormalized
        );
    }

    pushChunk(chunk: Uint8Array, finalChunk: boolean): Progress {
        const json = this.engine.push_chunk(chunk, finalChunk) as unknown as string;
        return JSON.parse(json);
    }

    takeErrors(max: number): PackedError[] {
        const raw = this.engine.take_errors_packed(max);
        const out: PackedError[] = [];

        for (let i = 0; i < raw.length; i += 2) {
            const row = raw[i];
            const w1 = raw[i + 1];
            out.push({
                row,
                col: w1 >>> 8,
                code: w1 & 0xff,
            });
        }
        return out;
    }

    takeNormalized(): Uint8Array {
        return this.engine.take_normalized();
    }

    schemaColumns(): string[] {
        return JSON.parse(this.engine.schema_columns_json());
    }

    static errorCodeToString(code: number): string {
        return ValidatorEngine.error_code_to_string(code);
    }
}
