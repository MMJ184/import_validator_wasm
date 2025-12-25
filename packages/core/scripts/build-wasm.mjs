import { execSync } from "node:child_process";
import { resolve } from "node:path";

const crateDir = resolve(process.cwd(), "../../crates/validator");
const outDir = resolve(process.cwd(), "./src/wasm/pkg");

execSync(
    "wasm-pack build --target web --out-dir " + outDir,
    { cwd: crateDir, stdio: "inherit" }
);
