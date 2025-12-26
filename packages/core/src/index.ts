import type { Progress, PackedError,DecodedError } from "./types";
import { initValidatorWasm } from "./wasm";
export { defaultWasmUrl } from "./wasmUrl";

export type { Progress, PackedError, DecodedError };

let wasmReady: Promise<any> | null = null;

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
        const raw = this.engine.take_errors_packed(max) as number[];
        const out: PackedError[] = [];

        for (let i = 0; i < raw.length; i += 2) {
            const row = raw[i];
            const w1 = raw[i + 1];

            // kind is stored in top bit (bit 31)
            const kind = (w1 >>> 31) & 1;

            // col is stored in bits 8..30 (we mask off top bit and bottom 8 bits)
            const col = (w1 >>> 8) & 0x7fffff;

            const code = w1 & 0xff;

            out.push({
                row,
                col,
                code,
                // optional: you can extend type to include kind
                // kind,
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

    static async errorCodeToString(code: number): Promise<string> {
        const mod = await requireMod();
        return mod.ValidatorEngine.error_code_to_string(code);
    }

    inputColumns(): string[] {
        // new Rust method: input_columns_json()
        return JSON.parse(this.engine.input_columns_json());
    }

    takeErrorsDecoded(max: number): import("./types").DecodedError[] {
        const raw = this.engine.take_errors_packed(max) as number[];

        const schemaCols = this.schemaColumns();
        const inputCols = this.inputColumns();

        const out: import("./types").DecodedError[] = [];

        for (let i = 0; i < raw.length; i += 2) {
            const row = raw[i];
            const w1 = raw[i + 1];

            const kindBit = (w1 >>> 31) & 1;
            const colIndex = (w1 >>> 8) & 0x7fffff;
            const code = w1 & 0xff;

            const colKind = kindBit === 1 ? "input" : "schema";
            const columnName =
                colKind === "schema" ? schemaCols[colIndex] : inputCols[colIndex];

            const codeString = Engine.errorCodeToStringSync(code);

            out.push({
                row,
                code,
                codeString,
                colIndex,
                colKind,
                columnName,
                message: Engine.makeMessage(row, codeString, columnName),
            });
        }

        return out;
    }

    static errorCodeToStringSync(code: number) {
        switch (code) {
            case 1: return "MissingRequired";
            case 2: return "InvalidType";
            case 3: return "MaxLengthExceeded";
            case 4: return "NotAllowed";
            case 5: return "InvalidUtf8";
            case 6: return "MissingRequiredColumn";
            case 7: return "ExtraColumn";
            default: return "Unknown";
        }
    }

    private static makeMessage(row: number, codeString: string, col?: string) {
        const where = row === 0 ? "Header" : `Row ${row}`;
        const colPart = col ? `, column "${col}"` : "";

        switch (codeString) {
            case "MissingRequiredColumn":
                return `${where}${colPart}: missing required column`;
            case "ExtraColumn":
                return `${where}${colPart}: extra column not allowed`;
            case "MissingRequired":
                return `${where}${colPart}: value is required`;
            case "InvalidType":
                return `${where}${colPart}: invalid type`;
            case "MaxLengthExceeded":
                return `${where}${colPart}: exceeds max length`;
            case "NotAllowed":
                return `${where}${colPart}: value not allowed`;
            case "InvalidUtf8":
                return `${where}${colPart}: invalid text encoding`;
            default:
                return `${where}${colPart}: validation error`;
        }
    }
}
