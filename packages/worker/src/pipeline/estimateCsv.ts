import { CsvRowCounter, isWasmReady } from "@import-validator/core";
import { createTickPacer, streamFile } from "./csvPipeline.js";

export type CsvEstimate = {
    rows: number;
    avgBytesPerRow: number;
    columns?: number;
};

export type CsvEstimateOptions = {
    delimiter?: number | string;
    hasHeaders?: boolean;
    signal?: AbortSignal;
};

/**
 * Row/column estimate for a CSV file (exact counts — every byte is scanned).
 *
 * Uses the WASM RowCounter when the engine module is initialized (an order of
 * magnitude faster than scanning bytes in JS); falls back to a JS scanner so
 * standalone `estimate` requests before `init` keep working.
 */
export async function estimateCsv(
    file: File,
    chunkSize?: number,
    options: CsvEstimateOptions = {}
): Promise<CsvEstimate> {
    const delimiter = resolveDelimiterByte(options.delimiter);
    const hasHeaders = options.hasHeaders ?? true;

    const counts = isWasmReady()
        ? await countRowsWasm(file, chunkSize, delimiter, options.signal)
        : await countRowsJs(file, chunkSize, delimiter, options.signal);

    const rows = hasHeaders ? Math.max(0, counts.rows - 1) : counts.rows;
    const avgBytesPerRow = rows > 0 ? file.size / rows : file.size;

    return { rows, avgBytesPerRow, columns: counts.firstRowColumns };
}

async function countRowsWasm(
    file: File,
    chunkSize: number | undefined,
    delimiter: number,
    signal?: AbortSignal
): Promise<{ rows: number; firstRowColumns?: number }> {
    const counter = await CsvRowCounter.create(delimiter);
    const maybeTick = createTickPacer();
    for await (const chunk of streamFile(file, chunkSize, signal)) {
        counter.push(chunk);
        await maybeTick();
    }
    return counter.finish();
}

/**
 * JS fallback scanner. Semantics mirror the Rust RowCounter exactly,
 * including the CRLF fix (the '\n' of a CRLF pair must not clear the
 * row-break flag — the legacy estimator counted a phantom trailing row for
 * CRLF-terminated files).
 */
async function countRowsJs(
    file: File,
    chunkSize: number | undefined,
    delimiter: number,
    signal?: AbortSignal
): Promise<{ rows: number; firstRowColumns?: number }> {
    let hasAnyByte = false;
    let totalRows = 0;
    let firstRowColumns: number | undefined;
    let currentRowColumns = 1;
    let endedWithRowBreak = false;
    let prevCR = false;
    let inQuotes = false;
    let quotePending = false;

    const finishRow = () => {
        totalRows += 1;
        if (firstRowColumns === undefined) {
            firstRowColumns = currentRowColumns;
        }
        currentRowColumns = 1;
        endedWithRowBreak = true;
        prevCR = false;
    };

    for await (const chunk of streamFile(file, chunkSize, signal)) {
        if (!chunk.length) continue;
        hasAnyByte = true;

        for (let i = 0; i < chunk.length; i += 1) {
            const b = chunk[i];

            if (quotePending) {
                if (b === 34) {
                    quotePending = false;
                    continue;
                }
                inQuotes = false;
                quotePending = false;
            }

            if (inQuotes) {
                if (b === 34) quotePending = true;
                continue;
            }

            // CRLF second byte: same row break — must not clear the flag.
            if (b === 10 && prevCR) {
                prevCR = false;
                continue;
            }

            if (endedWithRowBreak) endedWithRowBreak = false;

            if (b === 34) {
                inQuotes = true;
                continue;
            }

            if (b === delimiter) {
                currentRowColumns += 1;
                prevCR = false;
                continue;
            }

            if (b === 13) {
                finishRow();
                prevCR = true;
                continue;
            }

            if (b === 10) {
                finishRow();
                continue;
            }

            prevCR = false;
        }
    }

    if (quotePending) {
        inQuotes = false;
        quotePending = false;
    }

    if (hasAnyByte && !endedWithRowBreak) {
        finishRow();
    }

    return { rows: totalRows, firstRowColumns };
}

function resolveDelimiterByte(delimiter?: number | string): number {
    if (typeof delimiter === "number" && delimiter >= 0 && delimiter <= 255) {
        return delimiter;
    }
    if (typeof delimiter === "string" && delimiter.length === 1) {
        return delimiter.charCodeAt(0);
    }
    return 44;
}
