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

export async function estimateCsv(
    file: File,
    chunkSize?: number,
    options: CsvEstimateOptions = {}
): Promise<CsvEstimate> {
    const delimiter = resolveDelimiterByte(options.delimiter);
    const hasHeaders = options.hasHeaders ?? true;

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

    for await (const chunk of streamFile(file, chunkSize, options.signal)) {
        if (!chunk.length) continue;
        hasAnyByte = true;

        for (let i = 0; i < chunk.length; i += 1) {
            const b = chunk[i];

            if (endedWithRowBreak) endedWithRowBreak = false;

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
                if (prevCR) {
                    prevCR = false;
                    continue;
                }
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

    const rows = hasHeaders ? Math.max(0, totalRows - 1) : totalRows;
    const avgBytesPerRow = rows > 0 ? file.size / rows : file.size;

    return { rows, avgBytesPerRow, columns: firstRowColumns };
}

async function* streamFile(file: File, chunkSize?: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (chunkSize && chunkSize > 0) {
        for (let offset = 0; offset < file.size; offset += chunkSize) {
            if (signal?.aborted) throw abortedError();
            const part = file.slice(offset, offset + chunkSize);
            const buf = await part.arrayBuffer();
            if (buf.byteLength) yield new Uint8Array(buf);
        }
        return;
    }

    const reader = file.stream().getReader();
    try {
        while (true) {
            if (signal?.aborted) {
                try {
                    await reader.cancel();
                } catch {}
                throw abortedError();
            }
            const { value, done } = await reader.read();
            if (done) break;
            if (value?.length) yield value;
        }
    } finally {
        reader.releaseLock();
    }
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

function abortedError() {
    return new Error("Operation aborted");
}
