import assert from "node:assert/strict";
import test from "node:test";
import { deriveValidatePassFlags } from "../dist/flow.js";

test("estimateOnly enables estimate pass and skips validation pass", () => {
    const flags = deriveValidatePassFlags({
        estimateOnly: true
    });

    assert.equal(flags.estimateOnly, true);
    assert.equal(flags.shouldEmitEstimate, true);
    assert.equal(flags.needsCsvEstimate, true);
});

test("guard-based limits still force estimate preflight", () => {
    const flags = deriveValidatePassFlags({
        estimate: false,
        maxRowsEstimate: 1000
    });

    assert.equal(flags.estimateOnly, false);
    assert.equal(flags.shouldEmitEstimate, false);
    assert.equal(flags.needsCsvEstimate, true);
});

test("no estimate flags and no guards skip estimate preflight", () => {
    const flags = deriveValidatePassFlags({
        estimate: false
    });

    assert.equal(flags.estimateOnly, false);
    assert.equal(flags.shouldEmitEstimate, false);
    assert.equal(flags.needsCsvEstimate, false);
});
