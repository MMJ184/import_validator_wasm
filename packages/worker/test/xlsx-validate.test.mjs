// End-to-end XLSX validation through the real WASM engine: ZIP (stored +
// deflated entries) → DecompressionStream → Rust scanner → packed errors.
import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { initWasm, Engine } from "@import-validator/core";
import { runXlsx, estimateXlsx } from "../dist/pipeline/xlsxPipeline.js";

const WASM_PATH = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../core/dist/wasm/pkg/import_validator_wasm_bg.wasm"
);

const SCHEMA = {
    hasHeaders: true,
    columns: [
        { name: "id", type: "int", required: true, unique: true },
        { name: "email", type: "email", required: true, modifiers: { trim: true, lowercase: true } },
        { name: "amount", type: "decimal", precision: 2 },
    ],
};

const SHARED_XML = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>id</t></si><si><t>email</t></si><si><t>amount</t></si>
</sst>`;

const SHEET_XML = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>A@Ex.com</t></is></c><c r="C2"><v>10.5</v></c></row>
    <row r="3"><c r="A3"><v>1</v></c><c r="B3" t="inlineStr"><is><t>broken</t></is></c><c r="C3"><v>1.999</v></c></row>
  </sheetData>
</worksheet>`;

function buildZip(entries, { deflate = false } = {}) {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBytes = encoder.encode(name);
        const raw = typeof data === "string" ? encoder.encode(data) : data;
        const payload = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
        const method = deflate ? 8 : 0;

        const local = new Uint8Array(30 + nameBytes.length + payload.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(8, method, true);
        dv.setUint32(18, payload.length, true);
        dv.setUint32(22, raw.length, true);
        dv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        local.set(payload, 30 + nameBytes.length);
        locals.push(local);

        const central = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(central.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);
        cdv.setUint16(6, 20, true);
        cdv.setUint16(10, method, true);
        cdv.setUint32(20, payload.length, true);
        cdv.setUint32(24, raw.length, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centrals.push(central);

        offset += local.length;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const c of centrals) centralSize += c.length;

    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, centralOffset, true);

    const parts = [...locals, ...centrals, eocd];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

function makeFile(name, bytes) {
    return new File([bytes], name);
}

async function runWorkbook({ deflate }) {
    await initWasm(WASM_PATH);
    const engine = await Engine.create(SCHEMA, 1000, true);

    const zip = buildZip(
        [
            { name: "xl/sharedStrings.xml", data: SHARED_XML },
            { name: "xl/worksheets/sheet1.xml", data: SHEET_XML },
        ],
        { deflate }
    );

    const messages = [];
    const post = (m) => messages.push(m);
    const out = await runXlsx(makeFile("wb.xlsx", zip), engine, post, {
        emitNormalized: true,
        postPackedErrors: false,
    });

    return { messages, out };
}

for (const deflate of [false, true]) {
    test(`validates workbook end-to-end through the WASM engine (deflate=${deflate})`, async () => {
        const { messages, out } = await runWorkbook({ deflate });

        assert.equal(out.rowsProcessed, 2);

        const errors = messages.filter((m) => m.type === "errors").flatMap((m) => m.errors);
        const codes = errors.map((e) => e.codeString).sort();
        // row 3: duplicate id, invalid email, decimal scale 3 > precision 2
        assert.deepEqual(codes, ["DuplicateValue", "InvalidEmail", "InvalidType"]);
        assert.ok(errors.every((e) => e.columnName), "errors carry column names");

        const normalized = messages
            .filter((m) => m.type === "normalized")
            .map((m) => new TextDecoder().decode(m.chunk))
            .join("");
        assert.ok(normalized.startsWith("1,a@ex.com,10.50\n"), `normalized: ${normalized}`);

        assert.equal(messages.at(-1).type, "done");
    });
}

test("packed error batches decode to the same errors", async () => {
    await initWasm(WASM_PATH);
    const engine = await Engine.create(SCHEMA, 1000, false);
    const zip = buildZip([
        { name: "xl/sharedStrings.xml", data: SHARED_XML },
        { name: "xl/worksheets/sheet1.xml", data: SHEET_XML },
    ]);

    const messages = [];
    await runXlsx(makeFile("wb.xlsx", zip), engine, (m) => messages.push(m), {
        postPackedErrors: true,
    });

    const packedMsgs = messages.filter((m) => m.type === "errorsPacked");
    assert.ok(packedMsgs.length >= 1);
    const { decodePackedErrors } = await import("@import-validator/core");
    const decoded = packedMsgs.flatMap((m) =>
        decodePackedErrors(m.packed, m.schemaColumns, m.inputColumns)
    );
    assert.deepEqual(
        decoded.map((e) => e.codeString).sort(),
        ["DuplicateValue", "InvalidEmail", "InvalidType"]
    );
    assert.ok(decoded.every((e) => typeof e.message === "string" && e.message.length > 0));
});

test("estimate and validate share one opened container", async () => {
    await initWasm(WASM_PATH);
    const zip = buildZip([
        { name: "xl/sharedStrings.xml", data: SHARED_XML },
        { name: "xl/worksheets/sheet1.xml", data: SHEET_XML },
    ]);
    const est = await estimateXlsx(makeFile("wb.xlsx", zip));
    // no <dimension> element → WASM row-counter fallback
    assert.equal(est.rows, 2);
    assert.equal(est.columns, 3);
});
