import "./style.css";

import { createValidator, type ValidationFormat } from "@import-validator/sdk";
import { defaultWorkerUrl } from "@import-validator/sdk/vite";
import { defaultWasmUrl } from "@import-validator/core";
import { demoSchema } from "./schema";

const $file = document.getElementById("file") as HTMLInputElement;
const $estimate = document.getElementById("estimate") as HTMLInputElement;
const $estimateOnly = document.getElementById("estimateOnly") as HTMLInputElement;
const $format = document.getElementById("format") as HTMLSelectElement;
const $run = document.getElementById("run") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLPreElement;
const $errors = document.getElementById("errors") as HTMLPreElement;
const $metrics = document.getElementById("metrics") as HTMLPreElement;

let lastValidator: ReturnType<typeof createValidator> | null = null;
let pendingFile: File | null = null;
let shouldEstimate = false;
let shouldEstimateOnly = false;
let selectedFormat: ValidationFormat = "auto";

let totalRowsProcessed = 0;
let totalErrorsAdded = 0;
let totalRowsExpected = 0;

let startedAt = 0;
let finishedAt = 0;
let avgBytesPerRow = 0;
let estimatedRowsFromSize = 0;
let assumedMaxRowsForDevice = 0;
const MAX_ERROR_ROWS_TO_RENDER = 200;
let renderedErrorDetailsByRow = new Map<number, string[]>();
let renderedErrorDetailSetByRow = new Map<number, Set<string>>();
let headerMissingRequiredColumns = new Set<string>();
let headerHasInvalidEncoding = false;

function setStatus(s: string) {
    $status.textContent = s;
}

function resetUI() {
    $errors.textContent = "(none)";
    $metrics.textContent = "(none)";
    totalRowsProcessed = 0;
    totalErrorsAdded = 0;
    totalRowsExpected = 0;
    startedAt = 0;
    finishedAt = 0;
    avgBytesPerRow = 0;
    estimatedRowsFromSize = 0;
    assumedMaxRowsForDevice = 0;
    renderedErrorDetailsByRow = new Map<number, string[]>();
    renderedErrorDetailSetByRow = new Map<number, Set<string>>();
    headerMissingRequiredColumns = new Set<string>();
    headerHasInvalidEncoding = false;
}

function pendingLabel() {
    return totalRowsExpected > 0
        ? String(Math.max(0, totalRowsExpected - totalRowsProcessed))
        : "n/a";
}

$run.onclick = () => {
    const f = $file.files?.[0];
    if (!f) {
        alert("Pick a CSV or XLSX file first.");
        return;
    }

    lastValidator?.terminate();
    lastValidator = null;

    pendingFile = f;
    shouldEstimate = $estimate.checked;
    shouldEstimateOnly = $estimateOnly.checked;
    selectedFormat = ($format.value as ValidationFormat) ?? "auto";
    const inferredFormat = inferFormatFromFileName(f.name);
    if (selectedFormat !== "auto" && inferredFormat !== "auto" && selectedFormat !== inferredFormat) {
        alert(`Selected format "${selectedFormat}" does not match file type "${f.name}". Choose "${inferredFormat}" or "auto".`);
        return;
    }
    resetUI();

    $metrics.textContent = [
        `File size: ${formatBytes(f.size)}`,
        `Route: ${selectedFormat}`,
        `Estimate requested: ${shouldEstimate ? "yes" : "no"}`,
        `Estimate only: ${shouldEstimateOnly ? "yes" : "no"}`
    ].join("\n");

    if (shouldEstimateOnly) {
        setStatus("Estimating only | Done rows: 0 | Pending rows: calculating");
    } else if (shouldEstimate) {
        setStatus("Estimating | Done rows: 0 | Pending rows: calculating");
    } else {
        setStatus("Ready to validate | Done rows: 0 | Pending rows: n/a");
    }

    const v = createValidator(
        {
            schema: demoSchema,
            wasmUrl: defaultWasmUrl,
            workerUrl: defaultWorkerUrl,
            maxErrors: 10_000,
            emitNormalized: false
        },
        {
            onReady: () => {
                if (!pendingFile) return;
                startedAt = performance.now();
                if (shouldEstimateOnly) {
                    setStatus("Estimating only | Done rows: 0 | Pending rows: calculating");
                } else {
                    setStatus(`Validating | Done rows: ${totalRowsProcessed} | Pending rows: ${pendingLabel()} | Errors: ${totalErrorsAdded}`);
                }

                v.validate(pendingFile, {
                    emitNormalized: false,
                    maxPostErrorsTotal: 20_000,
                    postErrorBatch: 2_000,
                    estimate: shouldEstimate,
                    estimateOnly: shouldEstimateOnly,
                    format: selectedFormat,
                    profile: "balanced",
                    maxFileBytes: 600 * 1024 * 1024,
                    maxRowsEstimate: 2_0_000_000,
                    maxColumns: 500,
                    timeoutMs: 120_000,
                });
                pendingFile = null;
            },

            onEstimate: (rows, avg, columns) => {
                totalRowsExpected = rows;
                avgBytesPerRow = avg;
                estimatedRowsFromSize = avg > 0 ? Math.round(f.size / avg) : 0;
                const safeBytes = chooseSafeBytesForDevice();
                assumedMaxRowsForDevice = avg > 0 ? Math.round(safeBytes / avg) : 0;

                $metrics.textContent = [
                    `File size: ${formatBytes(f.size)}`,
                    `Average bytes/row (estimated): ${avgBytesPerRow.toFixed(1)}`,
                    `Estimated rows by file size: ${estimatedRowsFromSize}`,
                    `Estimated columns: ${columns ?? "n/a"}`,
                    `Assumed max rows for this device: ${assumedMaxRowsForDevice}`
                ].join("\n");
            },
            onMetrics: (m) => {
                $metrics.textContent = [
                    `Format: ${m.format}`,
                    `File size: ${formatBytes(m.fileSizeBytes)}`,
                    `Time taken: ${m.elapsedMs} ms`,
                    `Throughput: ${m.rowsPerSec} rows/sec`,
                    `Rows processed: ${m.rowsProcessed}`,
                    `Errors posted: ${m.errorsPosted}`,
                    `Dry run: ${m.dryRun ? "yes" : "no"}`,
                    `Average bytes/row (estimated): ${avgBytesPerRow > 0 ? avgBytesPerRow.toFixed(1) : "n/a"}`,
                    `Estimated rows by file size: ${estimatedRowsFromSize || "n/a"}`,
                    `Assumed max rows for this device: ${assumedMaxRowsForDevice || "n/a"}`
                ].join("\n");
            },

            onProgress: (p) => {
                totalRowsProcessed += p.rowsProcessed;
                totalErrorsAdded += p.errorsAdded;
                setStatus(`Validating | Done rows: ${totalRowsProcessed} | Pending rows: ${pendingLabel()} | Errors: ${totalErrorsAdded}`);
            },

            onErrors: (errs) => {
                for (const e of errs) {
                    const row = e.row;

                    if (row === 0 && e.codeString === "InvalidUtf8") {
                        headerHasInvalidEncoding = true;
                    }

                    if (row === 0 && e.codeString === "MissingRequiredColumn" && e.columnName) {
                        if (!renderedErrorDetailsByRow.has(0) && renderedErrorDetailsByRow.size < MAX_ERROR_ROWS_TO_RENDER) {
                            renderedErrorDetailsByRow.set(0, []);
                            renderedErrorDetailSetByRow.set(0, new Set<string>());
                        }
                        headerMissingRequiredColumns.add(e.columnName);
                        continue;
                    }

                    let rowDetails = renderedErrorDetailsByRow.get(row);
                    let rowDetailSet = renderedErrorDetailSetByRow.get(row);

                    if (!rowDetails || !rowDetailSet) {
                        if (renderedErrorDetailsByRow.size >= MAX_ERROR_ROWS_TO_RENDER) break;
                        rowDetails = [];
                        rowDetailSet = new Set<string>();
                        renderedErrorDetailsByRow.set(row, rowDetails);
                        renderedErrorDetailSetByRow.set(row, rowDetailSet);
                    }

                    const detail = compactRowMessage(e.message, row);
                    if (!detail) continue;
                    if (rowDetailSet.has(detail)) continue;
                    rowDetailSet.add(detail);
                    rowDetails.push(detail);
                }

                if (!renderedErrorDetailsByRow.size) {
                    $errors.textContent = "(none)";
                    return;
                }

                const lines = Array.from(renderedErrorDetailsByRow.entries())
                    .sort((a, b) => a[0] - b[0])
                    .map(([row, details]) => {
                        let parts = [...details];
                        if (row !== 0 && parts.length > 1) {
                            parts = parts.filter((p) => !/^validation error$/i.test(p));
                        }
                        if (row === 0 && headerHasInvalidEncoding) {
                            parts = parts.filter((p) => !/^validation error$/i.test(p));
                            if (!parts.some((p) => /UTF-8/i.test(p))) {
                                parts.push("file encoding must be UTF-8");
                            }
                        }
                        if (row === 0 && !headerHasInvalidEncoding && headerMissingRequiredColumns.size > 0) {
                            const missing = Array.from(headerMissingRequiredColumns).sort((a, b) => a.localeCompare(b));
                            parts.push(`missing required columns (${missing.length}): ${missing.join(", ")}`);
                        }
                        if (!parts.length) {
                            parts = ["validation error"];
                        }
                        const label = row === 0 ? "Header" : `Row ${row}`;
                        return `${label}: ${parts.join(", ")}`;
                    });

                $errors.textContent = lines.join("\n");
            },

            onDone: () => {
                finishedAt = performance.now();
                const elapsedMs = Math.max(1, Math.round(finishedAt - startedAt));
                const rowsPerSec = Math.round((totalRowsProcessed * 1000) / elapsedMs);

                if (shouldEstimateOnly) {
                    setStatus(`Done (estimate only) | Estimated rows: ${totalRowsExpected || "n/a"} | Errors: 0`);
                } else {
                    setStatus(`Done | Done rows: ${totalRowsProcessed} | Pending rows: ${pendingLabel()} | Errors: ${totalErrorsAdded}`);
                }
                $metrics.textContent = [
                    `File size: ${formatBytes(f.size)}`,
                    `Time taken: ${elapsedMs} ms`,
                    `Throughput: ${rowsPerSec} rows/sec`,
                    `Average bytes/row (estimated): ${avgBytesPerRow > 0 ? avgBytesPerRow.toFixed(1) : "n/a"}`,
                    `Estimated rows by file size: ${estimatedRowsFromSize || "n/a"}`,
                    `Assumed max rows for this device: ${assumedMaxRowsForDevice || "n/a"}`
                ].join("\n");
            },

            onFatal: (msg, fatal) => {
                setStatus("Failed");
                if (fatal) {
                    $errors.textContent = [
                        `[${fatal.code}] ${fatal.message}`,
                        fatal.fileName ? `File: ${fatal.fileName}` : "",
                        typeof fatal.fileSizeBytes === "number" ? `Size: ${fatal.fileSizeBytes} bytes` : "",
                        fatal.details ? `Details: ${fatal.details}` : ""
                    ].filter(Boolean).join("\n");
                } else {
                    $errors.textContent = `Validation failed: ${msg}`;
                }
                pendingFile = null;
            }
        }
    );

    lastValidator = v;
};

function chooseSafeBytesForDevice() {
    const MB = 1024 * 1024;
    const mem = (navigator as any).deviceMemory as number | undefined;
    if (!mem || mem <= 4) return 25 * MB;
    if (mem <= 8) return 100 * MB;
    return 200 * MB;
}

function formatBytes(bytes: number): string {
    const KB = 1024;
    const MB = KB * 1024;
    if (bytes < KB) return `${bytes} B`;
    if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
    return `${(bytes / MB).toFixed(2)} MB`;
}

function compactRowMessage(message: string, row: number): string {
    const text = message.trim();

    if (row === 0) {
        return text
            .replace(/^Header\s*:\s*/i, "")
            .replace(/^Header\s*,\s*/i, "")
            .replace(/^Header\s+/i, "")
            .trim();
    }

    const exactPrefix = new RegExp(`^(?:Row\\s+${row}\\s*[:,-]\\s*)+`, "i");
    if (exactPrefix.test(text)) {
        return text.replace(exactPrefix, "").trim();
    }

    // fallback for any row prefix pattern
    return text.replace(/^(?:Row\s+\d+\s*[:,-]\s*)+/i, "").trim();
}

function inferFormatFromFileName(name: string): ValidationFormat {
    const lower = name.toLowerCase();
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) return "excel";
    return "auto";
}
