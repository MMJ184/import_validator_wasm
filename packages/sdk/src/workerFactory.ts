export type WorkerFactoryOptions = {
    /**
     * Provide a custom factory if your bundler returns a Worker constructor,
     * or you need special Worker options.
     */
    workerFactory?: () => Worker;

    /**
     * Provide a fully resolved worker URL (string or URL).
     * This is the most universal approach.
     */
    workerUrl?: string | URL;
};

export function createWorker(opts: WorkerFactoryOptions = {}): Worker {
    if (opts.workerFactory) return opts.workerFactory();

    if (opts.workerUrl) {
        const url = typeof opts.workerUrl === "string" ? opts.workerUrl : opts.workerUrl.toString();
        return new Worker(url, { type: "module" });
    }

    throw new Error(
        "Worker not configured. Pass `workerUrl` (bundler-resolved) or `workerFactory` in ValidatorOptions."
    );
}
