/**
 * Reproducible throughput benchmark for the ImportValidator engine.
 *
 * Runs the WASM engine via @import-validator/node against generated CSV and
 * XLSX data with a realistic schema (types, modifiers, unique columns,
 * composite key), plus estimate-pass and normalized-output scenarios.
 *
 * Usage:
 *   pnpm run build            # once, to produce package dists + WASM
 *   pnpm run bench            # prints tables and rewrites docs/BENCHMARKS.md
 *   node scripts/bench.mjs --quick   # CSV 100k smoke only, no file rewrite
 */

import os from "node:os";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { deflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const QUICK = process.argv.includes("--quick");

const { validateBuffer, validateXlsxBuffer, init } = await import(
    path.join(rootDir, "packages", "node", "dist", "index.js")
);
const { Engine, CsvRowCounter } = await import(
    path.join(rootDir, "packages", "core", "dist", "index.js")
);

// ── Benchmark schema: representative of a real import screen ────────────────

const schema = {
    hasHeaders: true,
    caseInsensitiveHeaders: false,
    uniqueGroups: [{ name: "id-email", columns: ["id", "email"] }],
    columns: [
        { name: "id", type: "int", required: true, unique: true },
        { name: "email", type: "email", required: true, unique: true, modifiers: { trim: true, lowercase: true } },
        { name: "firstName", type: "string", required: true, minLen: 2, maxLen: 40, modifiers: { trim: true, collapseWhitespace: true, titleCase: true } },
        { name: "lastName", type: "string", required: true, minLen: 2, maxLen: 40, modifiers: { trim: true, collapseWhitespace: true, titleCase: true } },
        { name: "amount", type: "decimal", precision: 2, required: true, modifiers: { decimalScale: 2 } },
        { name: "score", type: "number", required: true },
        { name: "signupDate", type: "date", dateFormat: "ymd-dash", required: true },
        { name: "status", type: "string", required: true, allowed: ["ACTIVE", "INACTIVE", "PENDING"] },
        { name: "country", type: "string", required: true, allowed: ["IN", "US", "AE", "DE"] },
        { name: "notes", type: "string", maxLen: 200 },
    ],
};

// ── Deterministic data generator ─────────────────────────────────────────────

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const FIRST = ["john", "priya", "wei", "fatima", "carlos", "anna", "tom", "sara"];
const LAST = ["doe", "sharma", "chen", "khan", "garcia", "meyer", "lee", "patel"];
const STATUS = ["ACTIVE", "INACTIVE", "PENDING"];
const COUNTRY = ["IN", "US", "AE", "DE"];

function generateRows(rows, errorRate, seed = 42) {
    const rand = mulberry32(seed);
    const out = new Array(rows);
    for (let i = 1; i <= rows; i++) {
        const dirty = errorRate > 0 && rand() < errorRate;
        const first = FIRST[(rand() * FIRST.length) | 0];
        const last = LAST[(rand() * LAST.length) | 0];
        const id = dirty && rand() < 0.34 ? "not-int" : String(i);
        const email = dirty && rand() < 0.5 ? `broken email ${i}` : `${first}.${last}.${i}@example.com`;
        const amount = (rand() * 10000).toFixed(2);
        const score = String((rand() * 1000) | 0);
        const day = String(1 + ((rand() * 28) | 0)).padStart(2, "0");
        const month = String(1 + ((rand() * 12) | 0)).padStart(2, "0");
        const date = dirty && rand() < 0.25 ? `2024-13-40` : `20${10 + ((rand() * 16) | 0)}-${month}-${day}`;
        const status = STATUS[(rand() * STATUS.length) | 0];
        const country = COUNTRY[(rand() * COUNTRY.length) | 0];

        out[i - 1] = [id, email, `  ${first}   ${last} `, last, amount, score, date, status, country, `row ${i}`];
    }
    return out;
}

const HEADER = ["id", "email", "firstName", "lastName", "amount", "score", "signupDate", "status", "country", "notes"];

function rowsToCsv(rows) {
    const lines = new Array(rows.length + 1);
    lines[0] = HEADER.join(",");
    for (let i = 0; i < rows.length; i++) lines[i + 1] = rows[i].join(",");
    return Buffer.from(lines.join("\n") + "\n", "utf8");
}

/** Build a real .xlsx (deflated ZIP, inline strings) from row arrays. */
function rowsToXlsx(rows) {
    const esc = (s) =>
        s.includes("&") || s.includes("<") || s.includes(">")
            ? s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
            : s;
    const parts = [
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`,
    ];
    const emitRow = (values, r) => {
        const cells = values
            .map((v, c) => {
                const ref = `${columnLetter(c)}${r}`;
                // numbers go through <v>, text through inlineStr — like real exports
                return /^-?\d+(\.\d+)?$/.test(v)
                    ? `<c r="${ref}"><v>${v}</v></c>`
                    : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
            })
            .join("");
        parts.push(`<row r="${r}">${cells}</row>`);
    };
    emitRow(HEADER, 1);
    rows.forEach((row, i) => emitRow(row, i + 2));
    parts.push(`</sheetData></worksheet>`);
    const sheetXml = Buffer.from(parts.join(""), "utf8");

    return buildZip([
        { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
        { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
        { name: "xl/worksheets/sheet1.xml", data: sheetXml },
    ]);
}

function columnLetter(index) {
    let out = "";
    let n = index + 1;
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = ((n - 1) / 26) | 0;
    }
    return out;
}

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBytes = Buffer.from(name, "utf8");
        const payload = deflateRawSync(data);
        const local = Buffer.alloc(30 + nameBytes.length + payload.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        nameBytes.copy(local, 30);
        payload.copy(local, 30 + nameBytes.length);
        locals.push(local);

        const central = Buffer.alloc(46 + nameBytes.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        nameBytes.copy(central, 46);
        centrals.push(central);
        offset += local.length;
    }
    const centralOffset = offset;
    const centralSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    return Buffer.concat([...locals, ...centrals, eocd]);
}

// ── Runner ───────────────────────────────────────────────────────────────────

function fmt(n) {
    return Math.round(n).toLocaleString("en-US");
}

async function median3(fn) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await fn());
    runs.sort((a, b) => a.elapsedMs - b.elapsedMs);
    return runs[1];
}

async function benchCase(label, buffer, runner) {
    const median = await median3(runner);
    const rowsPerSec = (median.rows / median.elapsedMs) * 1000;
    const mbPerSec = (buffer.length / 1e6 / median.elapsedMs) * 1000;
    const result = {
        label,
        sizeMb: buffer.length / 1e6,
        elapsedMs: median.elapsedMs,
        rowsPerSec,
        mbPerSec,
        errors: median.errors,
    };
    console.log(
        `${label.padEnd(30)} ${fmt(median.elapsedMs).padStart(7)} ms   ` +
        `${fmt(rowsPerSec).padStart(10)} rows/s   ${mbPerSec.toFixed(1).padStart(7)} MB/s   errors: ${fmt(median.errors)}`
    );
    return result;
}

const csvRunner = (buffer, opts = {}) => async () => {
    const t0 = performance.now();
    const result = await validateBuffer(buffer, schema, { maxErrors: 100_000, ...opts });
    return { elapsedMs: performance.now() - t0, rows: result.rowsProcessed, errors: result.errors.length };
};

const xlsxRunner = (buffer) => async () => {
    const t0 = performance.now();
    const result = await validateXlsxBuffer(buffer, schema, { maxErrors: 100_000 });
    return { elapsedMs: performance.now() - t0, rows: result.rowsProcessed, errors: result.errors.length };
};

const estimateRunner = (buffer) => async () => {
    const t0 = performance.now();
    const counter = await CsvRowCounter.create(44);
    const CHUNK = 4 * 1024 * 1024;
    for (let i = 0; i < buffer.length; i += CHUNK) {
        counter.push(buffer.subarray(i, i + CHUNK));
    }
    const { rows } = counter.finish();
    return { elapsedMs: performance.now() - t0, rows, errors: 0 };
};

await init();

// Warmup (JIT + WASM warm paths).
await median3(csvRunner(rowsToCsv(generateRows(50_000, 0))));

console.log("\n── CSV validation ──");
const csvResults = [];
{
    const cases = QUICK
        ? [{ label: "100k rows, clean", rows: 100_000, errorRate: 0 }]
        : [
            { label: "100k rows, clean", rows: 100_000, errorRate: 0 },
            { label: "100k rows, 5% dirty", rows: 100_000, errorRate: 0.05 },
            { label: "1M rows, clean", rows: 1_000_000, errorRate: 0 },
            { label: "1M rows, 5% dirty", rows: 1_000_000, errorRate: 0.05 },
        ];
    for (const c of cases) {
        const buffer = rowsToCsv(generateRows(c.rows, c.errorRate));
        csvResults.push(await benchCase(c.label, buffer, csvRunner(buffer)));
    }
}

let xlsxResults = [];
let extraResults = [];
if (!QUICK) {
    console.log("\n── Excel (XLSX) validation ──");
    for (const c of [
        { label: "100k rows, clean (xlsx)", rows: 100_000, errorRate: 0 },
        { label: "100k rows, 5% dirty (xlsx)", rows: 100_000, errorRate: 0.05 },
        // 250k keeps the decompressed sheet XML under the product's 192 MB cap
        { label: "250k rows, clean (xlsx)", rows: 250_000, errorRate: 0 },
    ]) {
        const buffer = rowsToXlsx(generateRows(c.rows, c.errorRate));
        xlsxResults.push(await benchCase(c.label, buffer, xlsxRunner(buffer)));
    }

    console.log("\n── Auxiliary passes ──");
    {
        const buffer = rowsToCsv(generateRows(1_000_000, 0));
        extraResults.push(await benchCase("1M rows, estimate pass (csv)", buffer, estimateRunner(buffer)));
        extraResults.push(
            await benchCase("1M rows, clean + normalized", buffer, csvRunner(buffer, { emitNormalized: true }))
        );
    }
}

if (QUICK) {
    console.log("\n[bench] quick mode: skipping BENCHMARKS.md rewrite");
    process.exit(0);
}

// ── Write docs/BENCHMARKS.md ─────────────────────────────────────────────────

const cpu = os.cpus()[0]?.model ?? "unknown CPU";
const now = new Date().toISOString().slice(0, 10);

const table = (rows) =>
    rows
        .map(
            (r) =>
                `| ${r.label} | ${r.sizeMb.toFixed(1)} MB | ${fmt(r.elapsedMs)} ms | ` +
                `${fmt(r.rowsPerSec)} rows/s · ${r.mbPerSec.toFixed(1)} MB/s | ${fmt(r.errors)} |`
        )
        .join("\n");

const md = `# Benchmarks

Measured with \`pnpm run bench\` (median of 3 runs after warmup), schema with
10 columns: int + email (both \`unique\`), two modifier-heavy strings
(trim/collapse/titleCase), decimal with scale, number, date, two allow-lists,
and a composite \`uniqueGroups\` key — a deliberately validation-heavy setup,
not a parse-only best case.

- Date: ${now}
- Machine: ${cpu} (${os.arch()}), Node ${process.version}
- Engine: fast WASM tier (no regex), \`opt-level=3\`, LTO, \`wasm-opt -O4\`
- Runtime: @import-validator/node (same engine the browser worker runs)

## CSV validation

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
${table(csvResults)}

## Excel (XLSX) validation

The workbook streams through ZIP + DEFLATE into the Rust worksheet scanner;
rows validate through the same engine as CSV. File size below is the
COMPRESSED .xlsx size (XML expands ~6-10x when decompressed), so rows/s is
the comparable number, not MB/s.

| Scenario | File size (compressed) | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
${table(xlsxResults)}

## Auxiliary passes

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
${table(extraResults)}

Browser numbers track these closely: the Web Worker runs the identical WASM
binary; expect a few percent overhead from chunked File reads and message
passing. The demo's metrics panel reports live rows/s for any file you drop in.

See docs/PERFORMANCE.md for the tuning guide, memory model, and the
before/after history of engine optimizations.

Reproduce:

\`\`\`bash
pnpm run build   # build WASM + packages
pnpm run bench   # rewrites this file with your machine's numbers
\`\`\`
`;

await writeFile(path.join(rootDir, "docs", "BENCHMARKS.md"), md, "utf8");
console.log("\n[bench] wrote docs/BENCHMARKS.md");
