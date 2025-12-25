export function createWorker(): Worker {
    return new Worker(
        new URL("@import-validator/worker/worker", import.meta.url),
        { type: "module" }
    );
}
