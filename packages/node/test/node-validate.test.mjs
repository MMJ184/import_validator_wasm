// @import-validator/node package tests: CSV + XLSX validation on Node.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
    init,
    validateBuffer,
    validateFile,
    validateXlsxBuffer,
    validateXlsxFile,
} from "../dist/index.js";

const WASM_PATH = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../core/dist/wasm/pkg/import_validator_wasm_bg.wasm"
);

const SCHEMA = {
    hasHeaders: true,
    columns: [
        { name: "id", type: "int", required: true, unique: true },
        { name: "email", type: "email", required: true },
    ],
};

test.before(async () => {
    await init(WASM_PATH);
});

test("validateBuffer flags CSV errors with column names", async () => {
    const csv = Buffer.from("id,email\n1,a@b.com\n1,broken\n");
    const result = await validateBuffer(csv, SCHEMA);
    assert.equal(result.rowsProcessed, 2);
    assert.equal(result.valid, false);
    const codes = result.errors.map((e) => e.codeString).sort();
    assert.deepEqual(codes, ["DuplicateValue", "InvalidEmail"]);
    assert.ok(result.errors.every((e) => e.columnName));
});

test("validateFile streams CSV from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iv-node-"));
    try {
        const path = join(dir, "data.csv");
        await writeFile(path, "id,email\n1,a@b.com\n2,b@c.com\n");
        const result = await validateFile(path, SCHEMA);
        assert.equal(result.valid, true);
        assert.equal(result.rowsProcessed, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("returns every queued error, not only the last drain batch", async () => {
    // Each drain call takes at most 5,000 errors. One chunk that queues more
    // than that must still surface all of them, not just the final batch.
    const rows = 50_000;
    const lines = ["id,email"];
    for (let i = 0; i < rows; i++) lines.push(`${i + 1},not-an-email`);
    const csv = Buffer.from(`${lines.join("\n")}\n`);

    const result = await validateBuffer(csv, SCHEMA, {
        maxErrors: rows,
        chunkSize: 8 * 1024 * 1024, // force a single chunk
    });
    assert.equal(result.rowsProcessed, rows);
    assert.equal(result.errors.length, rows);
    assert.ok(result.errors.every((e) => e.codeString === "InvalidEmail"));
});

test("maxErrors caps what is reported without changing what is validated", async () => {
    const rows = 30_000;
    const lines = ["id,email"];
    for (let i = 0; i < rows; i++) lines.push(`${i + 1},not-an-email`);
    const csv = Buffer.from(`${lines.join("\n")}\n`);

    // One chunk, so the engine queue fills and stays full for the whole file.
    const result = await validateBuffer(csv, SCHEMA, {
        maxErrors: 500,
        chunkSize: 8 * 1024 * 1024,
    });

    assert.equal(result.rowsProcessed, rows, "every row is still validated");
    assert.equal(result.errors.length, 500, "reporting is capped at maxErrors");
    assert.equal(
        result.errors.length + result.errorsSuppressed,
        rows,
        "reported + suppressed must account for every error in the file"
    );

    // maxErrors: 0 returns nothing at all — the file is still not valid.
    const none = await validateBuffer(csv, SCHEMA, {
        maxErrors: 0,
        chunkSize: 8 * 1024 * 1024,
    });
    assert.equal(none.errors.length, 0);
    assert.equal(none.errorsSuppressed, rows);
    assert.equal(none.valid, false, "suppressed errors must still make a file invalid");
});

test("normalized output keeps every row for inputs past the engine buffer limit", async () => {
    // The engine's normalized buffer soft-limit is 2 MB; one chunk may exceed it.
    const rows = 40_000;
    const local = "u".repeat(40);
    const lines = ["id,email"];
    for (let i = 0; i < rows; i++) lines.push(`${i + 1},${local}${i}@example.com`);
    const csv = Buffer.from(`${lines.join("\n")}\n`);
    assert.ok(csv.length > 2 * 1024 * 1024, "fixture must exceed the 2 MB limit");

    const result = await validateBuffer(csv, SCHEMA, {
        emitNormalized: true,
        chunkSize: 16 * 1024 * 1024, // force a single chunk
    });
    assert.equal(result.valid, true);
    const text = Buffer.from(result.normalized).toString("utf8");
    assert.ok(text.endsWith("\n"), "normalized output must not end mid-row");
    assert.equal(text.trimEnd().split("\n").length, rows);
    assert.ok(text.startsWith(`1,${local}0@example.com\n`));
    assert.ok(text.trimEnd().endsWith(`${rows},${local}${rows - 1}@example.com`));
});

const DEFAULT_SHEET = `<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>email</t></is></c></row>
<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>a@b.com</t></is></c></row>
<row r="3"><c r="A3"><v>oops</v></c><c r="B3" t="inlineStr"><is><t>b@c.com</t></is></c></row>
</sheetData></worksheet>`;

function buildXlsx(sheet = DEFAULT_SHEET) {
    const encoder = new TextEncoder();
    const raw = encoder.encode(sheet);
    const payload = new Uint8Array(deflateRawSync(raw));
    const name = encoder.encode("xl/worksheets/sheet1.xml");

    const local = new Uint8Array(30 + name.length + payload.length);
    let dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 8, true); // deflate
    dv.setUint32(18, payload.length, true);
    dv.setUint32(22, raw.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(payload, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    dv = new DataView(central.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, 8, true);
    dv.setUint32(20, payload.length, true);
    dv.setUint32(24, raw.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, 0, true);
    central.set(name, 46);

    const eocd = new Uint8Array(22);
    dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, 1, true);
    dv.setUint16(10, 1, true);
    dv.setUint32(12, central.length, true);
    dv.setUint32(16, local.length, true);

    const out = new Uint8Array(local.length + central.length + eocd.length);
    out.set(local, 0);
    out.set(central, local.length);
    out.set(eocd, local.length + central.length);
    return out;
}

test("validateXlsxBuffer validates the first worksheet", async () => {
    const result = await validateXlsxBuffer(buildXlsx(), SCHEMA);
    assert.equal(result.rowsProcessed, 2);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((e) => e.codeString), ["InvalidType"]);
    assert.equal(result.errors[0].columnName, "id");
    assert.deepEqual(result.inputColumns, ["id", "email"]);
});

test("xlsx validation returns every queued error across sheet chunks", async () => {
    const rows = 12_000;
    const parts = [
        "<worksheet><sheetData>",
        '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c>' +
            '<c r="B1" t="inlineStr"><is><t>email</t></is></c></row>',
    ];
    for (let i = 0; i < rows; i++) {
        const r = i + 2;
        parts.push(
            `<row r="${r}"><c r="A${r}"><v>${i + 1}</v></c>` +
                `<c r="B${r}" t="inlineStr"><is><t>bad</t></is></c></row>`
        );
    }
    parts.push("</sheetData></worksheet>");

    const result = await validateXlsxBuffer(buildXlsx(parts.join("")), SCHEMA, {
        maxErrors: rows,
    });
    assert.equal(result.rowsProcessed, rows);
    assert.equal(result.errors.length, rows);
    assert.ok(result.errors.every((e) => e.codeString === "InvalidEmail"));
});

test("xlsx rows validated do not depend on the push chunk size", async () => {
    // The engine once abandoned the rest of a push when its error queue filled,
    // so rows validated depended on the push size. Guards against regressing.
    const rows = 20_000;
    const parts = [
        "<worksheet><sheetData>",
        '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c>' +
            '<c r="B1" t="inlineStr"><is><t>email</t></is></c></row>',
    ];
    for (let i = 0; i < rows; i++) {
        const r = i + 2;
        parts.push(
            `<row r="${r}"><c r="A${r}"><v>${i + 1}</v></c>` +
                `<c r="B${r}" t="inlineStr"><is><t>bad</t></is></c></row>`
        );
    }
    parts.push("</sheetData></worksheet>");
    const xlsx = buildXlsx(parts.join(""));

    // Small maxErrors is the exposed case: the queue fills early in each push.
    const result = await validateXlsxBuffer(xlsx, SCHEMA, { maxErrors: 2_000 });
    assert.equal(
        result.rowsProcessed,
        rows,
        "every row must still be validated when the error queue keeps filling"
    );
});

test("validateXlsxFile streams the workbook from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iv-node-xlsx-"));
    try {
        const path = join(dir, "data.xlsx");
        await writeFile(path, buildXlsx());
        const result = await validateXlsxFile(path, SCHEMA);
        assert.equal(result.rowsProcessed, 2);
        assert.deepEqual(result.errors.map((e) => e.codeString), ["InvalidType"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
