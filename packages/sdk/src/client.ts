import { createWorker } from "./workerFactory";
import type { ValidatorEvents, ValidatorOptions } from "./types";

export class ValidatorClient {
    private worker: Worker;
    private events: ValidatorEvents;

    private isReady = false;
    private pendingValidate: File | null = null;

    constructor(opts: ValidatorOptions, events: ValidatorEvents = {}) {
        this.events = events;

        this.worker = createWorker({
            workerUrl: opts.workerUrl,
            workerFactory: opts.workerFactory,
        });

        this.worker.onmessage = (e) => {
            const m = e.data;

            switch (m.type) {
                case "ready":
                    this.isReady = true;
                    events.onReady?.(m.columns);

                    // flush queued validate if user called validate early
                    if (this.pendingValidate) {
                        const f = this.pendingValidate;
                        this.pendingValidate = null;
                        this.validate(f);
                    }
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

        const wasmUrl =
            typeof opts.wasmUrl === "string"
                ? opts.wasmUrl
                : opts.wasmUrl?.toString();

        // Important: send init only once, with string url
        this.worker.postMessage({
            type: "init",
            wasmUrl, // string | undefined
            schema: opts.schema,
            maxErrors: opts.maxErrors ?? 10_000,
            emitNormalized: opts.emitNormalized ?? false,
        });
    }

    validate(file: File) {
        if (!this.isReady) {
            // queue latest request (simple + predictable)
            this.pendingValidate = file;
            return;
        }
        this.worker.postMessage({ type: "validate", file });
    }

    terminate() {
        this.worker.terminate();
    }
}
