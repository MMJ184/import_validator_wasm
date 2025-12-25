import init, { ValidatorEngine } from "./wasm/pkg";
export async function initWasm(wasmUrl) {
    await init(wasmUrl);
}
export class Engine {
    constructor(schema, maxErrors, emitNormalized) {
        this.engine = new ValidatorEngine(JSON.stringify(schema), maxErrors, emitNormalized);
    }
    pushChunk(chunk, finalChunk) {
        const json = this.engine.push_chunk(chunk, finalChunk);
        return JSON.parse(json);
    }
    takeErrors(max) {
        const raw = this.engine.take_errors_packed(max);
        const out = [];
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
    takeNormalized() {
        return this.engine.take_normalized();
    }
    schemaColumns() {
        return JSON.parse(this.engine.schema_columns_json());
    }
    static errorCodeToString(code) {
        return ValidatorEngine.error_code_to_string(code);
    }
}
