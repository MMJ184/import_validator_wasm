import type { Engine } from "@import-validator/core";
import type { WorkerResponse } from "../protocol";

const CHUNK_SIZE = 64 * 1024;

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

            const errors = engine.takeErrors(256);
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

    const errors = engine.takeErrors(1_000_000);
    if (errors.length) {
        post({ type: "errors", errors });
    }

    const normalized = engine.takeNormalized();
    if (normalized.length) {
        post({ type: "normalized", chunk: normalized });
    }

    post({ type: "done" });
}
