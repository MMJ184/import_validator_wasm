// core/src/wasm.ts
import initWasm, * as api from "./pkg/import_validator_wasm.js";

let ready: Promise<typeof api> | null = null;

export function initValidatorWasm(url?: string | URL) {
    if (!ready) {
        ready = (async () => {
            const defaultUrl = new URL("./pkg/import_validator_wasm_bg.wasm", import.meta.url);
            await initWasm(url ?? defaultUrl);
            return api;
        })();
    }
    return ready;
}
