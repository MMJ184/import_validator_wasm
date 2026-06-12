import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, "..");

// Overwrites the tsc-emitted dist/worker.js with a fully self-contained ESM
// bundle: no bare specifiers, so it can be hosted as a static asset and loaded
// with `new Worker(url, { type: "module" })` without any bundler involvement.
await build({
    entryPoints: [path.join(pkgDir, "src/worker.ts")],
    outfile: path.join(pkgDir, "dist/worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: true,
    legalComments: "none",
    // Node-only branch in core's wasm loader (guarded by a runtime check);
    // never evaluated in browsers, so leave the imports unresolved.
    external: ["node:fs/promises", "node:url"],
    allowOverwrite: true,
    logLevel: "info",
});

console.log("[bundle-worker] dist/worker.js is now self-contained");
