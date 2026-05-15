import "./style.css";

import { createValidator, type ValidationFormat } from "@import-validator/sdk";
import { defaultWorkerUrl } from "@import-validator/sdk/vite";
import { defaultWasmUrl } from "@import-validator/core";
import { demoSchema } from "./schema";

// ── Dark mode ─────────────────────────────────────────────────────────────────
const $themeToggle = document.getElementById("themeToggle") as HTMLButtonElement;

function applyTheme(dark: boolean) {
    document.documentElement.dataset.theme = dark ? "dark" : "";
}

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const savedTheme = localStorage.getItem("theme");
applyTheme(savedTheme === "dark" || (savedTheme === null && prefersDark));

$themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    applyTheme(!isDark);
    localStorage.setItem("theme", !isDark ? "dark" : "light");
});

// ── Element refs ──────────────────────────────────────────────────────────────
const $file          = document.getElementById("file")               as HTMLInputElement;
const $estimate      = document.getElementById("estimate")           as HTMLInputElement;
const $estimateOnly  = document.getElementById("estimateOnly")       as HTMLInputElement;
const $format        = document.getElementById("format")             as HTMLSelectElement;
const $namePrefix    = document.getElementById("namePrefix")         as HTMLInputElement;
const $nameSuffix    = document.getElementById("nameSuffix")         as HTMLInputElement;
const $amountScale   = document.getElementById("amountScale")        as HTMLInputElement;
const $nameSubstringStart = document.getElementById("nameSubstringStart") as HTMLInputElement;
const $nameSubstringEnd   = document.getElementById("nameSubstringEnd")   as HTMLInputElement;
const $nameReplaceFrom = document.getElementById("nameReplaceFrom")  as HTMLInputElement;
const $nameReplaceTo   = document.getElementById("nameReplaceTo")    as HTMLInputElement;
const $nullTokens    = document.getElementById("nullTokens")         as HTMLInputElement;
const $modTrimCollapse    = document.getElementById("modTrimCollapse")    as HTMLInputElement;
const $modTitleCase       = document.getElementById("modTitleCase")       as HTMLInputElement;
const $modEmailLowercase  = document.getElementById("modEmailLowercase")  as HTMLInputElement;
const $modUnique          = document.getElementById("modUnique")          as HTMLInputElement;
const $modCompositeUnique = document.getElementById("modCompositeUnique") as HTMLInputElement;
const $run           = document.getElementById("run")                as HTMLButtonElement;
const $statusBar     = document.getElementById("statusBar")          as HTMLDivElement;
const $status        = document.getElementById("status")             as HTMLSpanElement;
const $metrics       = document.getElementById("metrics")            as HTMLDivElement;
const $errors        = document.getElementById("errors")             as HTMLDivElement;
const $errorCount    = document.getElementById("errorCount")         as HTMLSpanElement;
const $uploadZone    = document.getElementById("uploadZone")         as HTMLLabelElement;
const $fileName      = document.getElementById("fileName")           as HTMLDivElement;
const $fileNameText  = document.getElementById("fileNameText")       as HTMLSpanElement;

// ── State ─────────────────────────────────────────────────────────────────────
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

// ── File input + drag-drop ────────────────────────────────────────────────────
$file.addEventListener("change", () => {
    const f = $file.files?.[0];
    if (f) {
        $fileNameText.textContent = f.name;
        $fileName.classList.remove("hidden");
    } else {
        $fileName.classList.add("hidden");
    }
});

$uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    $uploadZone.classList.add("drag-over");
});
$uploadZone.addEventListener("dragleave", () => {
    $uploadZone.classList.remove("drag-over");
});
$uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    $uploadZone.classList.remove("drag-over");
    const droppedFile = e.dataTransfer?.files[0];
    if (droppedFile) {
        const dt = new DataTransfer();
        dt.items.add(droppedFile);
        $file.files = dt.files;
        $fileNameText.textContent = droppedFile.name;
        $fileName.classList.remove("hidden");
    }
});

// ── Render helpers ────────────────────────────────────────────────────────────
function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function setStatus(s: string) {
    $status.textContent = s;
    let state = "idle";
    if (/validat/i.test(s) || /estimat/i.test(s)) state = "running";
    else if (/done/i.test(s)) state = "done";
    else if (/failed/i.test(s)) state = "failed";
    $statusBar.dataset.state = state;
}

function renderMetrics(pairs: Array<[string, string | number]>) {
    if (!pairs.length) {
        $metrics.innerHTML = '<p class="empty-hint">No data yet</p>';
        return;
    }
    $metrics.innerHTML = pairs
        .map(([label, value]) =>
            `<div class="metric-tile">` +
            `<span class="metric-label">${esc(label)}</span>` +
            `<span class="metric-value">${esc(String(value))}</span>` +
            `</div>`
        )
        .join("");
}

function renderErrors(lines: string[]) {
    if (!lines.length) {
        $errors.innerHTML = '<p class="empty-hint">No errors</p>';
        $errorCount.classList.add("hidden");
        return;
    }
    $errorCount.textContent = String(lines.length);
    $errorCount.classList.remove("hidden");
    $errors.innerHTML = lines
        .map((line) => {
            const m = line.match(/^(Header|Row \d+):\s*(.*)/);
            if (m) {
                const isHeader = m[1] === "Header";
                return (
                    `<div class="error-item">` +
                    `<span class="error-badge${isHeader ? " error-badge--header" : ""}">${esc(m[1])}</span>` +
                    `<span class="error-msg">${esc(m[2])}</span>` +
                    `</div>`
                );
            }
            return `<div class="error-item"><span class="error-msg">${esc(line)}</span></div>`;
        })
        .join("");
}

function resetUI() {
    renderErrors([]);
    $metrics.innerHTML = '<p class="empty-hint">No data yet</p>';
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

// ── Validate ──────────────────────────────────────────────────────────────────
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
    if (
        selectedFormat !== "auto" &&
        inferredFormat !== "auto" &&
        selectedFormat !== inferredFormat
    ) {
        alert(`Selected format "${selectedFormat}" does not match file "${f.name}". Choose "${inferredFormat}" or "auto".`);
        return;
    }

    resetUI();
    const runtimeSchema = buildRuntimeSchema();
    const modifierSummary = describeRuntimeModifiers();

    renderMetrics([
        ["File size", formatBytes(f.size)],
        ["Route", selectedFormat],
        ["Estimate", shouldEstimate ? "yes" : "no"],
        ["Estimate only", shouldEstimateOnly ? "yes" : "no"],
    ]);

    if (shouldEstimateOnly) {
        setStatus("Estimating only | Done rows: 0 | Pending rows: calculating");
    } else if (shouldEstimate) {
        setStatus("Estimating | Done rows: 0 | Pending rows: calculating");
    } else {
        setStatus("Ready to validate | Done rows: 0 | Pending rows: n/a");
    }

    const v = createValidator(
        {
            schema: runtimeSchema,
            wasmUrl: defaultWasmUrl,
            workerUrl: defaultWorkerUrl,
            maxErrors: 10_000,
            emitNormalized: false,
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
                    maxRowsEstimate: 2_000_000,
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

                renderMetrics([
                    ["File size",          formatBytes(f.size)],
                    ["Avg bytes / row",    avg.toFixed(1)],
                    ["Est. rows (size)",   String(estimatedRowsFromSize)],
                    ["Est. columns",       String(columns ?? "n/a")],
                    ["Max rows (device)",  String(assumedMaxRowsForDevice)],
                    ["Modifiers",          modifierSummary],
                ]);
            },

            onMetrics: (m) => {
                renderMetrics([
                    ["Format",            m.format],
                    ["File size",         formatBytes(m.fileSizeBytes)],
                    ["Time",              `${m.elapsedMs} ms`],
                    ["Throughput",        `${m.rowsPerSec.toLocaleString()} rows/s`],
                    ["Rows processed",    m.rowsProcessed.toLocaleString()],
                    ["Errors posted",     String(m.errorsPosted)],
                    ["Dry run",           m.dryRun ? "yes" : "no"],
                    ["Avg bytes / row",   avgBytesPerRow > 0 ? avgBytesPerRow.toFixed(1) : "n/a"],
                    ["Est. rows (size)",  estimatedRowsFromSize ? String(estimatedRowsFromSize) : "n/a"],
                    ["Max rows (device)", assumedMaxRowsForDevice ? String(assumedMaxRowsForDevice) : "n/a"],
                ]);
            },

            onProgress: (p) => {
                totalRowsProcessed += p.rowsProcessed;
                totalErrorsAdded += p.errorsAdded;
                setStatus(`Validating | Done rows: ${totalRowsProcessed.toLocaleString()} | Pending rows: ${pendingLabel()} | Errors: ${totalErrorsAdded}`);
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
                    renderErrors([]);
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
                        if (!parts.length) parts = ["validation error"];
                        const label = row === 0 ? "Header" : `Row ${row}`;
                        return `${label}: ${parts.join(", ")}`;
                    });

                renderErrors(lines);
            },

            onDone: () => {
                finishedAt = performance.now();
                const elapsedMs = Math.max(1, Math.round(finishedAt - startedAt));
                const rowsPerSec = Math.round((totalRowsProcessed * 1000) / elapsedMs);

                if (shouldEstimateOnly) {
                    setStatus(`Done (estimate only) | Estimated rows: ${totalRowsExpected || "n/a"} | Errors: 0`);
                } else {
                    setStatus(`Done | Rows: ${totalRowsProcessed.toLocaleString()} | Errors: ${totalErrorsAdded}`);
                }

                renderMetrics([
                    ["File size",         formatBytes(f.size)],
                    ["Time",              `${elapsedMs} ms`],
                    ["Throughput",        `${rowsPerSec.toLocaleString()} rows/s`],
                    ["Rows processed",    totalRowsProcessed.toLocaleString()],
                    ["Errors found",      String(totalErrorsAdded)],
                    ["Avg bytes / row",   avgBytesPerRow > 0 ? avgBytesPerRow.toFixed(1) : "n/a"],
                    ["Est. rows (size)",  estimatedRowsFromSize ? String(estimatedRowsFromSize) : "n/a"],
                    ["Max rows (device)", assumedMaxRowsForDevice ? String(assumedMaxRowsForDevice) : "n/a"],
                ]);
            },

            onFatal: (msg, fatal) => {
                setStatus("Failed");
                const lines: string[] = [];
                if (fatal) {
                    lines.push(`[${fatal.code}] ${fatal.message}`);
                    if (fatal.fileName)                           lines.push(`File: ${fatal.fileName}`);
                    if (typeof fatal.fileSizeBytes === "number")  lines.push(`Size: ${fatal.fileSizeBytes} bytes`);
                    if (fatal.details)                            lines.push(`Details: ${fatal.details}`);
                } else {
                    lines.push(`Validation failed: ${msg}`);
                }
                renderErrors(lines.map((l) => `Header: ${l}`));
                pendingFile = null;
            },
        }
    );

    lastValidator = v;
};

// ── Utilities ─────────────────────────────────────────────────────────────────
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
    if (exactPrefix.test(text)) return text.replace(exactPrefix, "").trim();
    return text.replace(/^(?:Row\s+\d+\s*[:,-]\s*)+/i, "").trim();
}

function inferFormatFromFileName(name: string): ValidationFormat {
    const lower = name.toLowerCase();
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) return "excel";
    return "auto";
}

function buildRuntimeSchema() {
    const schema = JSON.parse(JSON.stringify(demoSchema));
    const byName = new Map<string, any>(
        schema.columns.map((c: any) => [c.name, c])
    );

    const namePrefix = $namePrefix.value.trim();
    const nameSuffix = $nameSuffix.value.trim();
    const amountScale = safeScale($amountScale.value);
    const nameSubstringStart = parseOptionalNonNegativeInt($nameSubstringStart.value);
    const nameSubstringEnd = parseOptionalNonNegativeInt($nameSubstringEnd.value);
    const nameReplaceFrom = $nameReplaceFrom.value;
    const nameReplaceTo = $nameReplaceTo.value;
    const nullTokens = parseNullTokens($nullTokens.value);
    const trimCollapseEnabled = $modTrimCollapse.checked;
    const titleCaseEnabled = $modTitleCase.checked;
    const lowercaseEmails = $modEmailLowercase.checked;
    const uniqueEnabled = $modUnique.checked;
    const compositeUniqueEnabled = $modCompositeUnique.checked;

    const nameTargets = ["firstName", "middleName", "lastName", "surname"];
    for (const colName of nameTargets) {
        const col = byName.get(colName);
        if (!col) continue;
        col.modifiers = {
            ...(col.modifiers ?? {}),
            trim: trimCollapseEnabled,
            collapseWhitespace: trimCollapseEnabled,
            titleCase: titleCaseEnabled,
            substringStart: nameSubstringStart,
            substringEnd: nameSubstringEnd,
            replaceFrom: nameReplaceFrom || undefined,
            replaceTo: nameReplaceTo || undefined,
            prefix: namePrefix || undefined,
            suffix: nameSuffix || undefined,
            nullValues: nullTokens,
            nullValuesCaseInsensitive: true,
        };
    }

    const email = byName.get("email");
    if (email) {
        email.modifiers = {
            ...(email.modifiers ?? {}),
            trim: true,
            lowercase: lowercaseEmails,
            nullValues: nullTokens,
            nullValuesCaseInsensitive: true,
        };
    }

    for (const amountColName of ["amount", "taxAmount"]) {
        const amountCol = byName.get(amountColName);
        if (!amountCol) continue;
        amountCol.strictPrecision = false;
        amountCol.modifiers = {
            ...(amountCol.modifiers ?? {}),
            decimalScale: amountScale,
        };
    }

    if (!uniqueEnabled) {
        for (const col of schema.columns) col.unique = false;
    }
    if (!compositeUniqueEnabled) {
        schema.uniqueGroups = [];
    }

    return schema;
}

function describeRuntimeModifiers() {
    const prefix = $namePrefix.value.trim() || "(none)";
    const suffix = $nameSuffix.value.trim() || "(none)";
    const scale = safeScale($amountScale.value);
    return [
        `namePrefix=${prefix}`,
        `nameSuffix=${suffix}`,
        `nameTrimCollapse=${$modTrimCollapse.checked ? "on" : "off"}`,
        `nameTitleCase=${$modTitleCase.checked ? "on" : "off"}`,
        `nameSubstring=${optionalPairLabel(parseOptionalNonNegativeInt($nameSubstringStart.value), parseOptionalNonNegativeInt($nameSubstringEnd.value))}`,
        `nameReplace=${$nameReplaceFrom.value ? `${$nameReplaceFrom.value}->${$nameReplaceTo.value}` : "(none)"}`,
        `emailLowercase=${$modEmailLowercase.checked ? "on" : "off"}`,
        `nullTokens=${parseNullTokens($nullTokens.value).length}`,
        `amountScale=${scale}`,
        `uniqueChecks=${$modUnique.checked ? "on" : "off"}`,
        `compositeUnique=${$modCompositeUnique.checked ? "on" : "off"}`,
    ].join(", ");
}

function safeScale(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 2;
    if (parsed < 0) return 0;
    if (parsed > 8) return 8;
    return parsed;
}

function parseOptionalNonNegativeInt(raw: string): number | undefined {
    const t = raw.trim();
    if (!t) return undefined;
    const parsed = Number.parseInt(t, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
}

function parseNullTokens(raw: string): string[] {
    return raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

function optionalPairLabel(start?: number, end?: number): string {
    const a = start === undefined ? "-" : String(start);
    const b = end === undefined ? "-" : String(end);
    return `[${a},${b}]`;
}
