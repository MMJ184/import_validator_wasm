import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedSchemaVersion } from "../dist/flow.js";

test("schemaVersion 1 is accepted", () => {
    assert.doesNotThrow(() => assertSupportedSchemaVersion(1));
});

test("omitted schemaVersion defaults to 1 and is accepted", () => {
    assert.doesNotThrow(() => assertSupportedSchemaVersion(undefined));
});

test("future schemaVersion is rejected with stable code", () => {
    assert.throws(
        () => assertSupportedSchemaVersion(2),
        (err) => err.code === "SCHEMA_VERSION_UNSUPPORTED"
    );
});

test("schemaVersion 0 and negatives are rejected", () => {
    for (const v of [0, -1]) {
        assert.throws(
            () => assertSupportedSchemaVersion(v),
            (err) => err.code === "SCHEMA_VERSION_UNSUPPORTED",
            `expected schemaVersion=${v} to be rejected`
        );
    }
});
