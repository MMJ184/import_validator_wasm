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

function buildXlsx() {
    const sheet = `<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>email</t></is></c></row>
<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>a@b.com</t></is></c></row>
<row r="3"><c r="A3"><v>oops</v></c><c r="B3" t="inlineStr"><is><t>b@c.com</t></is></c></row>
</sheetData></worksheet>`;

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
