import assert from "node:assert/strict";
import test from "node:test";
import { estimateXlsx } from "../dist/pipeline/xlsxPipeline.js";

test("rejects legacy .xls uploads with clear message", async () => {
    await assert.rejects(
        () =>
            estimateXlsx({
                name: "legacy.xls",
                size: 10,
                arrayBuffer: async () => new ArrayBuffer(0)
            }),
        /Only \.xlsx files are supported/
    );
});

test("rejects invalid .xlsx payload with zip validation error", async () => {
    await assert.rejects(
        () =>
            estimateXlsx({
                name: "broken.xlsx",
                size: 4,
                arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
            }),
        /end of central directory not found/i
    );
});

test("parses small worksheet without DOMParser dependency", async () => {
    const worksheetXml = [
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
        `<dimension ref="A1:B3"/>`,
        `<sheetData>`,
        `<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>`,
        `<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Alice</t></is></c></row>`,
        `<row r="3"><c r="A3"><v>2</v></c><c r="B3" t="inlineStr"><is><t>Bob</t></is></c></row>`,
        `</sheetData>`,
        `</worksheet>`
    ].join("");

    const bytes = buildStoredZip([
        { name: "xl/worksheets/sheet1.xml", data: worksheetXml }
    ]);
    const file = makeFileLike("ok.xlsx", bytes);
    const out = await estimateXlsx(file);

    assert.equal(out.rows, 2);
    assert.equal(out.columns, 2);
    assert.ok(out.avgBytesPerRow > 0);
});

test("rejects xlsx zip with excessive entry count", async () => {
    const bytes = buildZipWithEntryCount(25_000);
    const file = makeFileLike("too_many_entries.xlsx", bytes);

    await assert.rejects(() => estimateXlsx(file), /too many entries/i);
});

test("dimension estimate skips shared strings load when not needed", async () => {
    const worksheetXml = [
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
        `<dimension ref="A1:B3"/>`,
        `<sheetData>`,
        `<row r="1"><c r="A1"><v>id</v></c><c r="B1"><v>name</v></c></row>`,
        `</sheetData>`,
        `</worksheet>`
    ].join("");

    // Invalid UTF-8 in sharedStrings should not matter for dimension-only estimate.
    const invalidShared = Uint8Array.from([0xc3, 0x28]);
    const bytes = buildStoredZip([
        { name: "xl/worksheets/sheet1.xml", data: worksheetXml },
        { name: "xl/sharedStrings.xml", data: invalidShared }
    ]);

    const file = makeFileLike("dimension_only.xlsx", bytes);
    const out = await estimateXlsx(file);

    assert.equal(out.rows, 2);
    assert.equal(out.columns, 2);
});

function makeFileLike(name, bytes) {
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
        }
    };
}

function buildStoredZip(entries) {
    const locals = [];
    const centrals = [];
    let localOffset = 0;

    for (const entry of entries) {
        const nameBytes = new TextEncoder().encode(entry.name);
        const dataBytes = toBytes(entry.data);

        const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
        writeU32(local, 0, 0x04034b50);
        writeU16(local, 4, 20);
        writeU16(local, 6, 0);
        writeU16(local, 8, 0);
        writeU16(local, 10, 0);
        writeU16(local, 12, 0);
        writeU32(local, 14, 0);
        writeU32(local, 18, dataBytes.length);
        writeU32(local, 22, dataBytes.length);
        writeU16(local, 26, nameBytes.length);
        writeU16(local, 28, 0);
        local.set(nameBytes, 30);
        local.set(dataBytes, 30 + nameBytes.length);
        locals.push(local);

        const central = new Uint8Array(46 + nameBytes.length);
        writeU32(central, 0, 0x02014b50);
        writeU16(central, 4, 20);
        writeU16(central, 6, 20);
        writeU16(central, 8, 0);
        writeU16(central, 10, 0);
        writeU16(central, 12, 0);
        writeU16(central, 14, 0);
        writeU32(central, 16, 0);
        writeU32(central, 20, dataBytes.length);
        writeU32(central, 24, dataBytes.length);
        writeU16(central, 28, nameBytes.length);
        writeU16(central, 30, 0);
        writeU16(central, 32, 0);
        writeU16(central, 34, 0);
        writeU16(central, 36, 0);
        writeU32(central, 38, 0);
        writeU32(central, 42, localOffset);
        central.set(nameBytes, 46);
        centrals.push(central);

        localOffset += local.length;
    }

    const centralOffset = localOffset;
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const eocd = buildEocd(entries.length, centralSize, centralOffset);

    return concatBytes([...locals, ...centrals, eocd]);
}

function buildZipWithEntryCount(totalEntries) {
    return buildEocd(totalEntries, 0, 0);
}

function buildEocd(totalEntries, centralSize, centralOffset) {
    const eocd = new Uint8Array(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, totalEntries);
    writeU16(eocd, 10, totalEntries);
    writeU32(eocd, 12, centralSize);
    writeU32(eocd, 16, centralOffset);
    writeU16(eocd, 20, 0);
    return eocd;
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function writeU16(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    return new TextEncoder().encode(String(value));
}
