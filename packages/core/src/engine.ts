import {PackedError, Progress} from "./types.js";
import {initValidatorWasm} from "./wasm/index.js";

let wasmReady: Promise<any> | null = null;

export function initWasm(wasmUrl?: string | URL) {
    if (!wasmReady) wasmReady = initValidatorWasm(wasmUrl);
    return wasmReady;
}

async function requireMod() {
    if (!wasmReady) throw new Error("WASM not initialized. Call initWasm(wasmUrl) first.");
    return await wasmReady;
}

/** True once initWasm() has resolved at least once. */
export function isWasmReady(): boolean {
    return wasmReady !== null;
}

export class Engine {
    private engine: any;
    private cachedSchemaColumns: string[] | null = null;
    private cachedInputColumns: string[] | null = null;
    /**
     * Whether this engine accumulates normalized output. Hosts must drain with
     * takeNormalized() whenever this is true — the engine buffers until they do.
     */
    readonly emitNormalized: boolean = false;
    private constructor() {}

    static async create(schema: object, maxErrors: number, emitNormalized: boolean) {
        const mod = await requireMod();
        const inst = new Engine();
        inst.engine = new mod.ValidatorEngine(JSON.stringify(schema), maxErrors, emitNormalized);
        (inst as { emitNormalized: boolean }).emitNormalized = emitNormalized;
        return inst;
    }

    pushChunk(chunk: Uint8Array, finalChunk: boolean): Progress {
        const value = this.engine.push_chunk(chunk, finalChunk) as unknown;
        if (typeof value === "string") {
            return JSON.parse(value);
        }
        return value as Progress;
    }

    /**
     * Push a chunk of decompressed xl/sharedStrings.xml. Must complete
     * (finalChunk=true) before the first pushSheetChunk call.
     */
    pushSharedStringsChunk(chunk: Uint8Array, finalChunk: boolean): void {
        this.engine.push_shared_strings_chunk(chunk, finalChunk);
    }

    /**
     * Push a chunk of decompressed worksheet XML. Rows validate identically
     * to CSV rows — same errors, same normalized output.
     */
    pushSheetChunk(chunk: Uint8Array, finalChunk: boolean): Progress {
        const value = this.engine.push_sheet_chunk(chunk, finalChunk) as unknown;
        if (typeof value === "string") {
            return JSON.parse(value);
        }
        return value as Progress;
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

    /**
     * Drain up to `max` errors as the raw packed Uint32Array (2 words per
     * error). Zero-decode path — transferable across postMessage.
     */
    takeErrorsPacked(max: number): Uint32Array {
        const raw = this.engine.take_errors_packed(max);
        return raw instanceof Uint32Array ? raw : Uint32Array.from(raw as number[]);
    }

    /** Discard up to `max` queued errors without materializing them. */
    dropErrors(max: number): number {
        if (typeof this.engine.drop_errors === "function") {
            return this.engine.drop_errors(max) as number;
        }
        return this.engine.take_errors_packed(max).length / 2;
    }

    errorsLen(): number {
        return this.engine.errors_count() as number;
    }

    /**
     * Errors found but not kept because the queue was at `maxErrors`.
     * `maxErrors` caps what is recorded, never which rows are validated, so
     * errors received plus this is the exact total in the file — enough to
     * render "showing 2,000 of 47,331".
     *
     * Unguarded on purpose: the WASM binary ships inside this package, so the
     * export is always present. A missing export should fail loudly rather
     * than report 0 and let a caller claim it saw every error.
     */
    errorsSuppressed(): number {
        return this.engine.errors_suppressed() as number;
    }

    /** Total data rows processed so far (header excluded). */
    rowsProcessed(): number {
        return this.engine.rows_processed() as number;
    }

    takeNormalized(): Uint8Array {
        return this.engine.take_normalized();
    }

    schemaColumns(): string[] {
        if (!this.cachedSchemaColumns) {
            this.cachedSchemaColumns = JSON.parse(this.engine.schema_columns_json());
        }
        return this.cachedSchemaColumns!;
    }

    static async errorCodeToString(code: number): Promise<string> {
        const mod = await requireMod();
        return mod.ValidatorEngine.error_code_to_string(code);
    }

    inputColumns(): string[] {
        if (this.cachedInputColumns) return this.cachedInputColumns;
        const cols = JSON.parse(this.engine.input_columns_json()) as string[];
        // input columns become available after header parse; cache once non-empty.
        if (cols.length) this.cachedInputColumns = cols;
        return cols;
    }

    takeErrorsDecoded(max: number): import("./types").DecodedError[] {
        const packed = this.takeErrorsPacked(max);
        return decodePackedErrors(packed, this.schemaColumns(), this.inputColumns());
    }

    static errorCodeToStringSync(code: number) {
        return errorCodeToStringSync(code);
    }
}

/**
 * Quote-aware streaming CSV row counter (estimate pass). Wraps the WASM
 * RowCounter; requires initWasm() to have completed.
 */
export class CsvRowCounter {
    private counter: any;
    private constructor() {}

    static async create(delimiter: number): Promise<CsvRowCounter> {
        const mod = await requireMod();
        const inst = new CsvRowCounter();
        inst.counter = new mod.RowCounter(delimiter);
        return inst;
    }

    push(chunk: Uint8Array): void {
        this.counter.push(chunk);
    }

    finish(): { rows: number; firstRowColumns?: number } {
        const packed = this.counter.finish() as Uint32Array | number[];
        const rows = Number(packed[0]) + Number(packed[1]) * 0x1_0000_0000;
        return {
            rows,
            firstRowColumns: packed[3] ? Number(packed[2]) : undefined,
        };
    }
}

/**
 * Worksheet-XML row counter (XLSX estimate fallback when no <dimension> is
 * present). Feed decompressed sheet XML chunks.
 */
export class XlsxSheetRowCounter {
    private counter: any;
    private constructor() {}

    static async create(): Promise<XlsxSheetRowCounter> {
        const mod = await requireMod();
        const inst = new XlsxSheetRowCounter();
        inst.counter = new mod.XlsxRowCounter();
        return inst;
    }

    push(chunk: Uint8Array): void {
        this.counter.push(chunk);
    }

    finish(): { rows: number; columns?: number } {
        const packed = this.counter.finish() as Uint32Array | number[];
        const rows = Number(packed[0]) + Number(packed[1]) * 0x1_0000_0000;
        return {
            rows,
            columns: packed[3] ? Number(packed[2]) : undefined,
        };
    }
}

/**
 * Decode packed errors (2 u32 words per error) into rich DecodedError
 * objects. Shared by Engine.takeErrorsDecoded and the SDK's packed-transfer
 * path — keep the message wording in ONE place.
 */
export function decodePackedErrors(
    packed: ArrayLike<number>,
    schemaCols: string[],
    inputCols: string[]
): import("./types").DecodedError[] {
    const out: import("./types").DecodedError[] = [];

    for (let i = 0; i + 1 < packed.length; i += 2) {
        const row = packed[i];
        const w1 = packed[i + 1];

        const kindBit = (w1 >>> 31) & 1;
        const colIndex = (w1 >>> 8) & 0x7fffff;
        const code = w1 & 0xff;

        const colKind = kindBit === 1 ? "input" : "schema";
        const columnName = colKind === "schema" ? schemaCols[colIndex] : inputCols[colIndex];

        const codeString = errorCodeToStringSync(code);

        out.push({
            row,
            code,
            codeString,
            colIndex,
            colKind,
            columnName,
            message: makeMessage(row, codeString, columnName),
        });
    }

    return out;
}

export function errorCodeToStringSync(code: number): import("./types").ErrorCodeString {
    switch (code) {
        case 1: return "MissingRequired";
        case 2: return "InvalidType";
        case 3: return "MaxLengthExceeded";
        case 4: return "NotAllowed";
        case 5: return "InvalidUtf8";
        case 6: return "MissingRequiredColumn";
        case 7: return "ExtraColumn";
        case 8: return "MinLengthNotMet";
        case 9: return "InvalidEmail";
        case 10: return "PatternMismatch";
        case 11: return "PrecisionExceeded";
        case 12: return "ColumnCountMismatch";
        case 13: return "DuplicateValue";
        case 14: return "DuplicateCombination";
        default: return "Unknown";
    }
}

function makeMessage(row: number, codeString: string, col?: string) {
    const where = row === 0 ? "Header" : `Row ${row}`;
    const colPart = col ? `, column "${col}"` : "";

    switch (codeString) {
        case "MissingRequiredColumn":
            return `${where}${colPart}: missing required column`;
        case "ExtraColumn":
            return `${where}${colPart}: extra column not allowed`;
        case "ColumnCountMismatch":
            return `${where}: column count does not match configured totalColumns`;
        case "MissingRequired":
            return `${where}${colPart}: value is required`;
        case "InvalidType":
            return `${where}${colPart}: invalid type`;
        case "MaxLengthExceeded":
            return `${where}${colPart}: exceeds max length`;
        case "MinLengthNotMet":
            return `${where}${colPart}: below minimum length`;
        case "NotAllowed":
            return `${where}${colPart}: value not allowed`;
        case "InvalidEmail":
            return `${where}${colPart}: invalid email format`;
        case "PatternMismatch":
            return `${where}${colPart}: does not match required pattern`;
        case "PrecisionExceeded":
            return `${where}${colPart}: decimal precision exceeded`;
        case "InvalidUtf8":
            return `${where}${colPart}: invalid text encoding`;
        case "DuplicateValue":
            return `${where}${colPart}: duplicate value not allowed`;
        case "DuplicateCombination":
            return `${where}${colPart}: duplicate combination not allowed`;
        default:
            return `${where}${colPart}: validation error`;
    }
}
