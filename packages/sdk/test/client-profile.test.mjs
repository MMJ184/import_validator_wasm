import test from "node:test";
import assert from "node:assert/strict";
import { createValidator } from "../dist/index.js";

class FakeWorker {
    constructor() {
        this.posted = [];
        this.onmessage = null;
    }
    postMessage(message) {
        this.posted.push(message);
    }
    terminate() {}
    emit(message) {
        this.onmessage?.({ data: message });
    }
}

const schema = { hasHeaders: true, columns: [{ name: "id", type: "int" }] };
const file = { size: 1024, name: "data.csv" };

function makeClient(options) {
    const worker = new FakeWorker();
    const client = createValidator({
        schema,
        wasmUrl: "/assets/engine.wasm",
        workerFactory: () => worker,
        ...options,
    });
    worker.emit({ type: "ready", columns: ["id"] });
    return { client, worker };
}

function lastValidateMessage(worker) {
    const msg = worker.posted.filter((m) => m.type === "validate").at(-1);
    assert.ok(msg, "expected a validate message to be posted");
    return msg;
}

test("constructor profile applies to validate calls (strict)", () => {
    const { client, worker } = makeClient({ profile: "strict" });
    client.validate(file);
    const msg = lastValidateMessage(worker);
    assert.equal(msg.options.maxPostErrorsTotal, 100_000);
    assert.equal(msg.options.postErrorBatch, 1_000);
    assert.equal(msg.options.estimate, true);
});

test("constructor profile applies to validate calls (fast)", () => {
    const { client, worker } = makeClient({ profile: "fast" });
    client.validate(file);
    const msg = lastValidateMessage(worker);
    assert.equal(msg.options.maxPostErrorsTotal, 10_000);
    assert.equal(msg.options.postErrorBatch, 2_000);
    assert.equal(msg.options.estimate, false);
});

test("per-call profile overrides constructor profile", () => {
    const { client, worker } = makeClient({ profile: "strict" });
    client.validate(file, { profile: "fast" });
    const msg = lastValidateMessage(worker);
    assert.equal(msg.options.maxPostErrorsTotal, 10_000);
    assert.equal(msg.options.estimate, false);
});

test("defaults to balanced when no profile given", () => {
    const { client, worker } = makeClient({});
    client.validate(file);
    const msg = lastValidateMessage(worker);
    assert.equal(msg.options.maxPostErrorsTotal, 50_000);
    assert.equal(msg.options.postErrorBatch, 2_000);
});

test("explicit per-call options beat profile defaults", () => {
    const { client, worker } = makeClient({ profile: "strict" });
    client.validate(file, { maxPostErrorsTotal: 123 });
    const msg = lastValidateMessage(worker);
    assert.equal(msg.options.maxPostErrorsTotal, 123);
});
