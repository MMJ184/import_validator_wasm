import assert from "node:assert/strict";
import test from "node:test";
import {
    formatFatalMessage,
    inferFatalCode,
    toFatalError,
    WorkerValidationError
} from "../dist/errorTaxonomy.js";

test("maps known runtime failures to stable fatal codes", () => {
    assert.equal(inferFatalCode("RuntimeError: unreachable"), "WASM_RUNTIME");
    assert.equal(
        inferFatalCode('WebAssembly.instantiate(): Import #0 "wbg" "__wbg_set_...": function import requires a callable'),
        "WASM_RUNTIME"
    );
    assert.equal(inferFatalCode("File size 999 exceeds maxFileBytes=100"), "FILE_TOO_LARGE");
    assert.equal(
        inferFatalCode("XLSX worksheet XML is too large (300000000 bytes). Limit is 201326592 bytes."),
        "FILE_TOO_LARGE"
    );
    assert.equal(inferFatalCode("Estimated rows 200 exceeds maxRowsEstimate=100"), "ROWS_LIMIT_EXCEEDED");
    assert.equal(inferFatalCode("Validation timeout after 30000 ms"), "TIMEOUT");
});

test("preserves explicit WorkerValidationError metadata", () => {
    const req = {
        type: "validate",
        file: { name: "demo_10000.csv", size: 567816 },
        options: { format: "csv" },
    };

    const fatal = toFatalError(
        new WorkerValidationError("FILE_TOO_LARGE", "File size exceeded", {
            details: "Configured maxFileBytes=500000",
            retryable: false
        }),
        req
    );

    assert.equal(fatal.code, "FILE_TOO_LARGE");
    assert.equal(fatal.message, "File size exceeded");
    assert.equal(fatal.phase, "validate");
    assert.equal(fatal.fileName, "demo_10000.csv");
    assert.equal(fatal.fileSizeBytes, 567816);
    assert.equal(fatal.details, "Configured maxFileBytes=500000");
    assert.equal(fatal.retryable, false);
});

test("formats fatal messages with context", () => {
    const text = formatFatalMessage({
        code: "TIMEOUT",
        message: "Validation timed out before completion.",
        retryable: true,
        phase: "validate",
        format: "csv",
        fileName: "demo_100000.csv",
        fileSizeBytes: 12345,
        details: "Validation timeout after 1000 ms"
    });

    assert.match(text, /^\[TIMEOUT\] Validation timed out before completion\./);
    assert.match(text, /phase=validate/);
    assert.match(text, /format=csv/);
    assert.match(text, /file=demo_100000\.csv/);
    assert.match(text, /size=12345 bytes/);
});
