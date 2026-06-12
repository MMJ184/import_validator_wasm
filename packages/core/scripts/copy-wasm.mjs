import { mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Copy only the wasm-pack output (pkg). The compiled wasm/index.js comes from
// tsc — copying the whole src/wasm dir would clobber it with stale files.
const from = path.resolve(__dirname, "../src/wasm/pkg");
const to = path.resolve(__dirname, "../dist/wasm/pkg");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

// wasm-pack emits a .gitignore ("*") that makes npm/pnpm pack drop the whole
// pkg dir from tarballs, and a nested package.json that resets Node's module
// type boundary for the ESM glue. Neither belongs in dist.
for (const junk of [".gitignore", "package.json", "README.md"]) {
    await rm(path.join(to, junk), { force: true });
}

console.log(`[copy-wasm] copied ${from} -> ${to}`);
