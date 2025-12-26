import type { Engine } from "@import-validator/core";
import type { WorkerResponse } from "../protocol";

export async function runCsv(
    file: File,
    engine: Engine,
    post: (msg: WorkerResponse) => void
) {
    const reader = file.stream().getReader();

    while (true) {
        const { value, done } = await reader.read();

        if (value) {
            const progress = engine.pushChunk(value, false);
            post({ type: "progress", progress });

            const errors = engine.takeErrorsDecoded(256);
            if (errors.length) {
                post({ type: "errors", errors });
            }

            const normalized = engine.takeNormalized();
            if (normalized.length) {
                post({ type: "normalized", chunk: normalized });
            }
        }

        if (done) break;
    }

    const finalProgress = engine.pushChunk(new Uint8Array(), true);
    post({ type: "progress", progress: finalProgress });

    // ✅ final drain must also be decoded
    const finalErrors = engine.takeErrorsDecoded(1_000_000);
    if (finalErrors.length) {
        post({ type: "errors", errors: finalErrors });
    }

    const normalized = engine.takeNormalized();
    if (normalized.length) {
        post({ type: "normalized", chunk: normalized });
    }

    post({ type: "done" });
}
