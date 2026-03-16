import assert from "node:assert/strict";
import test from "node:test";
import { estimateCsv } from "../dist/pipeline/estimateCsv.js";

test("counts rows correctly across chunk boundaries with quoted newlines", async () => {
    const text = `id,name\n1,"Alice\nBob"\n2,Carol\n`;
    const file = makeFileLike("quoted.csv", text);
    const out = await estimateCsv(file, 5, { hasHeaders: true });

    assert.equal(out.rows, 2);
    assert.equal(out.columns, 2);
    assert.ok(out.avgBytesPerRow > 0);
});

test("includes header in count when hasHeaders is false", async () => {
    const text = `a,b\n1,2`;
    const file = makeFileLike("no_header_mode.csv", text);
    const out = await estimateCsv(file, 3, { hasHeaders: false });

    assert.equal(out.rows, 2);
    assert.equal(out.columns, 2);
});

function makeFileLike(name, text) {
    const bytes = new TextEncoder().encode(text);
    const toArrayBuffer = (u8) =>
        u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    return {
        name,
        size: bytes.length,
        async arrayBuffer() {
            return toArrayBuffer(bytes);
        },
        slice(start = 0, end = bytes.length) {
            const part = bytes.subarray(start, end);
            return {
                size: part.length,
                async arrayBuffer() {
                    return toArrayBuffer(part);
                }
            };
        },
        stream() {
            throw new Error("stream() should not be used in this test path");
        }
    };
}
