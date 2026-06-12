/**
 * Reproducible throughput benchmark for the ImportValidator engine.
 *
 * Runs the WASM engine via @import-validator/node against generated CSV data
 * with a realistic schema (types, modifiers, unique columns, composite key).
 *
 * Usage:
 *   pnpm run build      # once, to produce package dists + WASM
 *   pnpm run bench      # prints a table and rewrites docs/BENCHMARKS.md
 */

import os from "node:os";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const { validateBuffer, init } = await import(
    path.join(rootDir, "packages", "node", "dist", "index.js")
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

function generateCsv(rows, errorRate, seed = 42) {
    const rand = mulberry32(seed);
    const lines = new Array(rows + 1);
    lines[0] = "id,email,firstName,lastName,amount,score,signupDate,status,country,notes";

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

        lines[i] = `${id},${email},  ${first}   ${last} ,${last},${amount},${score},${date},${status},${country},row ${i}`;
    }
    return Buffer.from(lines.join("\n") + "\n", "utf8");
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function timeOne(buffer) {
    const t0 = performance.now();
    const result = await validateBuffer(buffer, schema, { maxErrors: 100_000 });
    const elapsedMs = performance.now() - t0;
    return { elapsedMs, rows: result.rowsProcessed, errors: result.errors.length };
}

function fmt(n) {
    return Math.round(n).toLocaleString("en-US");
}

const cases = [
    { label: "100k rows, clean", rows: 100_000, errorRate: 0 },
    { label: "100k rows, 5% dirty", rows: 100_000, errorRate: 0.05 },
    { label: "1M rows, clean", rows: 1_000_000, errorRate: 0 },
    { label: "1M rows, 5% dirty", rows: 1_000_000, errorRate: 0.05 },
];

await init();

// Warmup (JIT + WASM warm paths).
await timeOne(generateCsv(50_000, 0));

const results = [];
for (const c of cases) {
    const buffer = generateCsv(c.rows, c.errorRate);
    const runs = [];
    for (let i = 0; i < 3; i++) {
        runs.push(await timeOne(buffer));
    }
    runs.sort((a, b) => a.elapsedMs - b.elapsedMs);
    const median = runs[1];
    const rowsPerSec = (median.rows / median.elapsedMs) * 1000;
    const mbPerSec = (buffer.length / 1e6 / median.elapsedMs) * 1000;
    results.push({
        label: c.label,
        sizeMb: buffer.length / 1e6,
        elapsedMs: median.elapsedMs,
        rowsPerSec,
        mbPerSec,
        errors: median.errors,
    });
    console.log(
        `${c.label.padEnd(22)} ${fmt(median.elapsedMs)} ms   ` +
        `${fmt(rowsPerSec)} rows/s   ${mbPerSec.toFixed(1)} MB/s   errors: ${fmt(median.errors)}`
    );
}

// ── Write docs/BENCHMARKS.md ─────────────────────────────────────────────────

const cpu = os.cpus()[0]?.model ?? "unknown CPU";
const now = new Date().toISOString().slice(0, 10);

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

| Scenario | File size | Median time | Throughput | Errors found |
|---|---:|---:|---:|---:|
${results
    .map(
        (r) =>
            `| ${r.label} | ${r.sizeMb.toFixed(1)} MB | ${fmt(r.elapsedMs)} ms | ` +
            `${fmt(r.rowsPerSec)} rows/s · ${r.mbPerSec.toFixed(1)} MB/s | ${fmt(r.errors)} |`
    )
    .join("\n")}

Browser numbers track these closely: the Web Worker runs the identical WASM
binary; expect a few percent overhead from chunked File reads and message
passing. The demo's metrics panel reports live rows/s for any file you drop in.

Reproduce:

\`\`\`bash
pnpm run build   # build WASM + packages
pnpm run bench   # rewrites this file with your machine's numbers
\`\`\`
`;

await writeFile(path.join(rootDir, "docs", "BENCHMARKS.md"), md, "utf8");
console.log("\n[bench] wrote docs/BENCHMARKS.md");
