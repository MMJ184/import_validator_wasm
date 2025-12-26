import workerUrl from "@import-validator/worker/worker?url";

/**
 * Vite helper: a ready-to-use worker URL.
 * Use like: createValidator({ workerUrl: defaultWorkerUrl, ... })
 */
export const defaultWorkerUrl = workerUrl;
