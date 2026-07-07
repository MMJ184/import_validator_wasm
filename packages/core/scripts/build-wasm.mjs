import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const crateDir = resolve(process.cwd(), "../../crates/validator");
const outDir = resolve(process.cwd(), "./src/wasm/pkg");
const wasmFeatures = process.env.WASM_FEATURES?.trim();

// Optional WASM SIMD128 + bulk-memory build (IV_WASM_SIMD=1). Benchmarked
// ~neutral on the CSV validate hot path (the engine is compute-bound in
// per-field logic, not byte scanning), so the default build keeps the widest
// browser floor. SIMD floor would be: Chrome 91+, Firefox 89+, Safari 16.4+.
const targetFeatures =
    process.env.IV_WASM_SIMD === "1"
        ? "-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint"
        : "";

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
    {
        cwd: crateDir,
        stdio: "inherit",
        env: {
            ...process.env,
            RUSTFLAGS: [process.env.RUSTFLAGS, targetFeatures].filter(Boolean).join(" "),
        },
    }
);
