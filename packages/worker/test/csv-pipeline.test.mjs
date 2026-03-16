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
        }
    };
}

async function* makeChunks(count) {
    for (let i = 0; i < count; i += 1) {
        yield new Uint8Array([65]);
    }
}
