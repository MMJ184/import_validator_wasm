import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const crateDir = resolve(process.cwd(), "../../crates/validator");
const outDir = resolve(process.cwd(), "./src/wasm/pkg");
const wasmFeatures = process.env.WASM_FEATURES?.trim();

// ✅ Avoid stale pkg outputs from older targets
rmSync(outDir, { recursive: true, force: true });

execSync(
    [
        "wasm-pack build",
        "--target web",
        "--release",
        "--out-dir " + outDir,
        "--out-name import_validator_wasm",
        ...(wasmFeatures ? ["--", "--features", wasmFeatures] : []),
    ].join(" "),
    { cwd: crateDir, stdio: "inherit" }
);
