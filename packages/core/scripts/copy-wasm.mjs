import { mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const from = path.resolve(__dirname, "../src/wasm");
const to = path.resolve(__dirname, "../dist/wasm");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

console.log(`[copy-wasm] copied ${from} -> ${to}`);
