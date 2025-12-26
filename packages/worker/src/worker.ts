import { createEngine } from "./loaders/wasmLoader";
import { runCsv } from "./pipeline/csvPipeline";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let engine: any = null;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    const post = (m: WorkerResponse) => self.postMessage(m);

    try {
        if (e.data.type === "init") {
            if (!e.data.wasmUrl) {
                throw new Error("wasmUrl is required (pass it from SDK/client).");
            }

            engine = await createEngine(
                e.data.wasmUrl,
                e.data.schema,
                e.data.maxErrors,
                e.data.emitNormalized
            );

            post({ type: "ready", columns: engine.schemaColumns() });
            return;
        }

        if (e.data.type === "validate") {
            if (!engine) throw new Error("Engine not initialized");
            await runCsv(e.data.file, engine, post);
            return;
        }
    } catch (err: any) {
        post({ type: "fatal", message: err?.message || String(err) });
    }
};
