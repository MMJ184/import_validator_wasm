import { createWorker } from "./workerFactory";
import type { ValidatorEvents, ValidatorOptions } from "./types";

export class ValidatorClient {
    private worker = createWorker();
    private events: ValidatorEvents;

    constructor(opts: ValidatorOptions, events: ValidatorEvents = {}) {
        this.events = events;

        this.worker.onmessage = (e) => {
            const m = e.data;
            switch (m.type) {
                case "ready":
                    events.onReady?.(m.columns);
                    break;
                case "progress":
                    events.onProgress?.(m.progress);
                    break;
                case "errors":
                    events.onErrors?.(m.errors);
                    break;
                case "normalized":
                    events.onNormalized?.(m.chunk);
                    break;
                case "done":
                    events.onDone?.();
                    break;
                case "fatal":
                    events.onFatal?.(m.message);
                    break;
            }
        };

        this.worker.postMessage({
            type: "init",
            wasmUrl: opts.wasmUrl,
            schema: opts.schema,
            maxErrors: opts.maxErrors ?? 10_000,
            emitNormalized: opts.emitNormalized ?? false,
        });
    }

    validate(file: File) {
        this.worker.postMessage({ type: "validate", file });
    }

    terminate() {
        this.worker.terminate();
    }
}
