import assert from "node:assert/strict";
import test from "node:test";
import { runCsvChunks } from "../dist/pipeline/csvPipeline.js";

test("coalesces progress events based on row threshold", async () => {
    const posts = [];
    const engine = createMockEngine();

    await runCsvChunks(makeChunks(9), engine, (message) => posts.push(message), {
        progressFlushRows: 4,
        progressFlushIntervalMs: 60_000,
    });

    const progress = posts
        .filter((m) => m.type === "progress")
        .map((m) => m.progress);

    assert.deepEqual(
        progress.map((p) => p.rowsProcessed),
        [4, 4, 1]
    );
    assert.equal(progress.at(-1)?.done, true);
    assert.equal(progress.reduce((sum, p) => sum + p.rowsProcessed, 0), 9);
    assert.equal(posts.at(-1)?.type, "done");
});

test("emits terminal progress even when source has no rows", async () => {
    const posts = [];
    const engine = createMockEngine();

    await runCsvChunks(makeChunks(0), engine, (message) => posts.push(message), {
        progressFlushRows: 100,
        progressFlushIntervalMs: 60_000,
    });

    const progress = posts.find((m) => m.type === "progress");
    assert.ok(progress);
    assert.equal(progress.progress.rowsProcessed, 0);
    assert.equal(progress.progress.done, true);
    assert.equal(posts.at(-1)?.type, "done");
});

test("drains normalized output when the engine emits it but options omit the flag", async () => {
    const posts = [];
    const engine = createMockEngine();
    // Engine was built with normalization on; the caller forgot to pass it.
    engine.emitNormalized = true;
    let drained = 0;
    engine.takeNormalized = () => {
        drained += 1;
        return new Uint8Array([1, 2, 3]);
    };

    await runCsvChunks(makeChunks(3), engine, (message) => posts.push(message), {
        progressFlushRows: 100,
        progressFlushIntervalMs: 60_000,
    });

    assert.ok(drained > 0, "engine buffer must be drained, not left to grow");
    assert.ok(
        posts.some((m) => m.type === "normalized"),
        "normalized chunks must be posted to the host"
    );
});

test("reports every error it did not deliver, not just the engine's own cap", async () => {
    // The worker drops errors in two places the engine cannot see: filtered out
    // by maxErrorRowsToShow, and left queued once maxPostErrorsTotal is hit.
    // done.errorsSuppressed must account for both, or "showing N of TOTAL" lies.
    const TOTAL = 900;
    const PER_CHUNK = 100;

    const makeEngine = () => {
        let produced = 0;
        let queue = [];
        return {
            emitNormalized: false,
            pushChunk(chunk, finalChunk) {
                if (finalChunk) return { rowsProcessed: 0, errorsAdded: 0, done: true };
                for (let i = 0; i < PER_CHUNK && produced < TOTAL; i++, produced++) {
                    queue.push({ row: produced + 1, col: 0, code: 1 });
                }
                return { rowsProcessed: PER_CHUNK, errorsAdded: PER_CHUNK, done: false };
            },
            takeErrorsDecoded(max) {
                return queue.splice(0, max);
            },
            takeErrors(max) {
                return queue.splice(0, max);
            },
            takeNormalized: () => new Uint8Array(),
            errorsLen: () => queue.length,
            dropErrors(max) {
                const n = Math.min(max, queue.length);
                queue.splice(0, n);
                return n;
            },
            errorsSuppressed: () => 0,
            schemaColumns: () => [],
            inputColumns: () => [],
        };
    };

    for (const [label, opts] of [
        ["maxPostErrorsTotal", { maxPostErrorsTotal: 250 }],
        ["maxErrorRowsToShow", { maxErrorRowsToShow: 40 }],
    ]) {
        const posts = [];
        await runCsvChunks(makeChunks(TOTAL / PER_CHUNK), makeEngine(), (m) => posts.push(m), {
            progressFlushRows: 1e9,
            progressFlushIntervalMs: 1e9,
            ...opts,
        });

        const delivered = posts
            .filter((m) => m.type === "errors")
            .reduce((sum, m) => sum + m.errors.length, 0);
        const done = posts.at(-1);
        assert.equal(done.type, "done");
        assert.equal(
            delivered + done.errorsSuppressed,
            TOTAL,
            `${label}: delivered + suppressed must equal every error found`
        );
    }
});

function createMockEngine() {
    return {
        pushChunk(chunk, finalChunk) {
            if (finalChunk) {
                return { rowsProcessed: 0, errorsAdded: 0, done: true };
            }
            const rows = chunk.length ? 1 : 0;
            return { rowsProcessed: rows, errorsAdded: 0, done: false };
        },
        takeErrorsDecoded() {
            return [];
        },
        takeNormalized() {
            return new Uint8Array();
        },
        takeErrors() {
            return [];
        },
        errorsLen() {
            return 0;
        },
        errorsSuppressed() {
            return 0;
        }
    };
}

async function* makeChunks(count) {
    for (let i = 0; i < count; i += 1) {
        yield new Uint8Array([65]);
    }
}
