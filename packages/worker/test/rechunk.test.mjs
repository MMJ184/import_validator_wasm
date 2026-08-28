// Chunk shaping: byte-exactness matters more than the size shaping, because
// the worksheet scanner is chunk-boundary sensitive.
import assert from "node:assert/strict";
import test from "node:test";
import {
    rechunk,
    DEFAULT_PUSH_CHUNK_BYTES,
    DEFAULT_INFLATE_CHUNK_BYTES,
} from "@import-validator/core";

async function* fromChunks(chunks) {
    for (const c of chunks) yield c;
}

async function collect(iter) {
    const out = [];
    for await (const c of iter) out.push(c);
    return out;
}

function flatten(chunks) {
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

test("merges undersized chunks up to the target", async () => {
    const source = [];
    let counter = 0;
    for (let i = 0; i < 200; i++) {
        source.push(Uint8Array.from({ length: 37 }, () => counter++ & 0xff));
    }
    const got = await collect(rechunk(fromChunks(source), 1024));
    assert.deepEqual(flatten(got), flatten(source));
    for (const c of got.slice(0, -1)) {
        assert.equal(c.length, 1024, "every chunk but the last is exactly the target");
    }
});

test("splits oversized chunks down to the target, without copying", async () => {
    const big = new Uint8Array(4096).fill(7);
    const got = await collect(rechunk(fromChunks([big]), 1024));
    assert.equal(got.length, 4);
    assert.ok(
        got.every((c) => c.buffer === big.buffer),
        "splits must be views onto the source buffer, not copies"
    );
    assert.deepEqual(flatten(got), Buffer.from(big));
});

test("carries a remainder across chunk boundaries in order", async () => {
    // 1500 then 1500 at target 1000 => 1000, 1000, 1000
    const a = Uint8Array.from({ length: 1500 }, (_, i) => i & 0xff);
    const b = Uint8Array.from({ length: 1500 }, (_, i) => (i + 7) & 0xff);
    const got = await collect(rechunk(fromChunks([a, b]), 1000));
    assert.deepEqual(got.map((c) => c.length), [1000, 1000, 1000]);
    assert.deepEqual(flatten(got), flatten([a, b]));
});

test("drops empty chunks", async () => {
    const source = [
        new Uint8Array(0),
        Uint8Array.from([1, 2, 3]),
        new Uint8Array(0),
        Uint8Array.from([4, 5]),
        new Uint8Array(0),
    ];
    const got = await collect(rechunk(fromChunks(source), 1024));
    assert.deepEqual(flatten(got), Buffer.from([1, 2, 3, 4, 5]));
    assert.ok(got.every((c) => c.length > 0));
});

test("drops empty chunks on the pass-through path too", async () => {
    const source = [new Uint8Array(0), Uint8Array.from([1]), new Uint8Array(0)];
    const got = await collect(rechunk(fromChunks(source), 0));
    assert.equal(got.length, 1, "empties must not reach the engine as zero-length pushes");
});

test("handles an empty source", async () => {
    assert.deepEqual(await collect(rechunk(fromChunks([]), 1024)), []);
});

test("passes through when the target is unusable", async () => {
    const source = [new Uint8Array(10), new Uint8Array(20)];
    // Infinity is the one that matters: a naive `buffered >= target` check
    // never fires, so the whole stream would accumulate in memory.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const got = await collect(rechunk(fromChunks(source), bad));
        assert.equal(got.length, 2, `target ${bad} must not buffer the stream`);
    }
});

test("a target of 1 is honoured literally, not treated as unusable", async () => {
    const got = await collect(rechunk(fromChunks([Uint8Array.from([1, 2, 3])]), 1));
    assert.deepEqual(got.map((c) => c.length), [1, 1, 1]);
});

test("exports sane defaults, with pushes smaller than inflate units", () => {
    assert.equal(DEFAULT_PUSH_CHUNK_BYTES, 64 * 1024);
    assert.equal(DEFAULT_INFLATE_CHUNK_BYTES, 1024 * 1024);
    assert.ok(
        DEFAULT_PUSH_CHUNK_BYTES < DEFAULT_INFLATE_CHUNK_BYTES,
        "inflate in large units, push in small ones"
    );
});

test("byte-exact across many random chunk shapes", async () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

    for (let trial = 0; trial < 25; trial++) {
        const source = [];
        let value = 0;
        const chunkCount = 1 + Math.floor(rand() * 40);
        for (let i = 0; i < chunkCount; i++) {
            const len = Math.floor(rand() * 300);
            source.push(Uint8Array.from({ length: len }, () => value++ & 0xff));
        }
        const target = 1 + Math.floor(rand() * 2000);
        const got = await collect(rechunk(fromChunks(source), target));
        assert.deepEqual(
            flatten(got),
            flatten(source),
            `trial ${trial} (target ${target}) must preserve bytes`
        );
    }
});
