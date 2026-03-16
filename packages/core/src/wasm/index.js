// core/src/wasm.ts
import initWasm, * as api from "./pkg/import_validator_wasm.js";
let ready = null;
export function initValidatorWasm(url) {
    if (!ready) {
        ready = initialize(url).catch((err) => {
            ready = null;
            throw err;
        });
    }
    return ready;
}
async function initialize(url) {
    const defaultUrl = new URL("./pkg/import_validator_wasm_bg.wasm", import.meta.url);
    const wasmPath = url ?? defaultUrl;
    try {
        await initOnce(wasmPath);
    }
    catch (err) {
        if (!isImportMismatchError(err)) {
            throw err;
        }
        try {
            await initOnce(withCacheBust(wasmPath));
        }
        catch (retryErr) {
            if (!isImportMismatchError(retryErr)) {
                throw retryErr;
            }
            if (url === undefined) {
                throw retryErr;
            }
            await initOnce(withCacheBust(defaultUrl));
        }
    }
    return api;
}
function isImportMismatchError(err) {
    const text = err instanceof Error ? err.message : String(err);
    return text.includes("WebAssembly.instantiate()") && text.includes("function import requires a callable");
}
function withCacheBust(input) {
    const stamp = Date.now().toString();
    if (input instanceof URL) {
        const out = new URL(input.toString());
        out.searchParams.set("v", stamp);
        return out;
    }
    const sep = input.includes("?") ? "&" : "?";
    return `${input}${sep}v=${stamp}`;
}
async function initOnce(moduleOrPath) {
    await initWasm({ module_or_path: moduleOrPath });
}
