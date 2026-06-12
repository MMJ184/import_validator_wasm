// core/src/wasm.ts
import initWasm, * as api from "./pkg/import_validator_wasm.js";

let ready: Promise<typeof api> | null = null;

export function initValidatorWasm(url?: string | URL) {
    if (!ready) {
        ready = initialize(url).catch((err) => {
            ready = null;
            throw err;
        });
    }
    return ready;
}

async function initialize(url?: string | URL) {
    const defaultUrl = new URL("./pkg/import_validator_wasm_bg.wasm", import.meta.url);
    const wasmPath = url ?? defaultUrl;

    try {
        await initOnce(wasmPath);
    } catch (err) {
        if (!isImportMismatchError(err)) {
            throw err;
        }
        try {
            // Retry once with cache-busting query for stale browser/worker asset caches.
            await initOnce(withCacheBust(wasmPath));
        } catch (retryErr) {
            if (!isImportMismatchError(retryErr)) {
                throw retryErr;
            }
            if (url === undefined) {
                throw retryErr;
            }
            // Final fallback for monorepo/dev duplicate-package scenarios:
            // force using wasm that is adjacent to this glue module.
            await initOnce(withCacheBust(defaultUrl));
        }
    }

    return api;
}

function isImportMismatchError(err: unknown): boolean {
    const text = err instanceof Error ? err.message : String(err);
    return text.includes("WebAssembly.instantiate()") && text.includes("function import requires a callable");
}

function withCacheBust(input: string | URL): string | URL {
    const stamp = Date.now().toString();
    if (input instanceof URL) {
        const out = new URL(input.toString());
        out.searchParams.set("v", stamp);
        return out;
    }
    const sep = input.includes("?") ? "&" : "?";
    return `${input}${sep}v=${stamp}`;
}

async function initOnce(moduleOrPath: string | URL) {
    const localBytes = await maybeReadLocalBytes(moduleOrPath);
    if (localBytes) {
        await initWasm({ module_or_path: localBytes as any });
        return;
    }
    await initWasm({ module_or_path: moduleOrPath as any });
}

/**
 * Node.js cannot fetch() file:// URLs or bare paths, so read the wasm bytes
 * from disk there. Returns null in browsers/workers (fetch path is used).
 */
async function maybeReadLocalBytes(input: string | URL): Promise<Uint8Array | null> {
    const proc = (globalThis as any).process;
    const isNode = !!proc?.versions?.node;
    if (!isNode) return null;

    const asString = input instanceof URL ? input.href : input;
    if (asString.startsWith("http://") || asString.startsWith("https://")) {
        return null;
    }

    const { readFile } = await import("node:fs/promises");
    if (asString.startsWith("file://")) {
        const { fileURLToPath } = await import("node:url");
        const clean = new URL(asString);
        clean.search = ""; // strip cache-bust params before path conversion
        return new Uint8Array(await readFile(fileURLToPath(clean)));
    }
    return new Uint8Array(await readFile(asString));
}
