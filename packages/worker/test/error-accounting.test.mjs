// Error accounting through the REAL WASM engine.
//
// The pipeline unit tests use a mock engine that reports zero suppressed
// errors, so they only exercise the worker's own bookkeeping. This covers the
// whole chain — engine cap, maxErrorRowsToShow filtering, maxPostErrorsTotal
// residue — and asserts the contract the SDK documents:
//
//     errors delivered + done.errorsSuppressed === every error in the file
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { initWasm, Engine } from "@import-validator/core";
import { runCsvChunks } from "../dist/pipeline/csvPipeline.js";

const WASM_PATH = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../core/dist/wasm/pkg/import_validator_wasm_bg.wasm"
);

const SCHEMA = {
    hasHeaders: true,
    columns: [
        { name: "id", type: "int", required: true },
        { name: "email", type: "email", required: true },
    ],
};

const ROWS = 4_000; // every row fails on email
const CSV = (() => {
    const lines = ["id,email"];
    for (let i = 0; i < ROWS; i++) lines.push(`${i + 1},not-an-email`);
    return new TextEncoder().encode(`${lines.join("\n")}\n`);
})();

test.before(async () => {
    await initWasm(WASM_PATH);
});

async function* chunks(size) {
    for (let i = 0; i < CSV.length; i += size) yield CSV.subarray(i, i + size);
}

async function run(maxErrors, opts, chunkSize = 8 * 1024) {
    const engine = await Engine.create(SCHEMA, maxErrors, false);
    const posts = [];
    await runCsvChunks(chunks(chunkSize), engine, (m) => posts.push(m), {
        progressFlushRows: 1e9,
        progressFlushIntervalMs: 1e9,
        ...opts,
    });
    const delivered =
        posts
            .filter((m) => m.type === "errors")
            .reduce((sum, m) => sum + m.errors.length, 0) +
        posts
            .filter((m) => m.type === "errorsPacked")
            .reduce((sum, m) => sum + m.packed.length / 2, 0);
    const done = posts.at(-1);
    assert.equal(done.type, "done");
    return { delivered, suppressed: done.errorsSuppressed, posts };
}

test("delivered + suppressed equals every error in the file", async () => {
    const cases = [
        ["engine cap only", 500, {}],
        ["tiny engine cap", 1, {}],
        ["maxPostErrorsTotal residue", 2_000, { maxPostErrorsTotal: 300 }],
        ["maxErrorRowsToShow filtering", 2_000, { maxErrorRowsToShow: 50 }],
        ["packed transport", 2_000, { postPackedErrors: true }],
        ["packed + row limit", 2_000, { postPackedErrors: true, maxErrorRowsToShow: 50 }],
        ["both caps together", 500, { maxPostErrorsTotal: 200, maxErrorRowsToShow: 20 }],
    ];

    for (const [label, maxErrors, opts] of cases) {
        for (const chunkSize of [1024, 64 * 1024]) {
            const { delivered, suppressed } = await run(maxErrors, opts, chunkSize);
            assert.equal(
                delivered + suppressed,
                ROWS,
                `${label} @ chunk ${chunkSize}: ${delivered} delivered + ${suppressed} suppressed`
            );
        }
    }
});

test("suppressed is zero when everything is delivered", async () => {
    const { delivered, suppressed } = await run(ROWS * 2, {});
    assert.equal(delivered, ROWS);
    assert.equal(suppressed, 0);
});

test("progress errorsAdded sums to the true error count", async () => {
    // errorsAdded counts errors FOUND, so it stays truthful once the queue is
    // full — a queue-length delta would report 0 for most of the file.
    const engine = await Engine.create(SCHEMA, 10, false);
    const posts = [];
    await runCsvChunks(chunks(8 * 1024), engine, (m) => posts.push(m), {
        progressFlushRows: 1,
        progressFlushIntervalMs: 0,
    });
    const found = posts
        .filter((m) => m.type === "progress")
        .reduce((sum, m) => sum + m.progress.errorsAdded, 0);
    assert.equal(found, ROWS);
});
