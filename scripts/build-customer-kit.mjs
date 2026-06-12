import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "artifacts", "customer-kit");

const packageNames = ["core", "worker", "sdk", "node"];

const docFiles = [
    "CLIENT_QUICKSTART.md",
    "SCHEMA_REFERENCE.md",
    "SDK_API.md",
    "CUSTOMER_DISTRIBUTION.md",
    "NATIVE_CLIENTS.md",
    "validation-config.schema.json",
    "customer-profiles.json",
];

async function assertBuildOutputs() {
    for (const name of packageNames) {
        const dist = path.join(rootDir, "packages", name, "dist");
        try {
            await stat(dist);
        } catch {
            throw new Error(
                `Missing build output: packages/${name}/dist. ` +
                `Run "pnpm run build" before creating the customer kit.`
            );
        }
    }

    // The shipped worker must be self-contained: a statically hosted worker.js
    // with bare module specifiers cannot load in any browser.
    const workerJs = await readFile(
        path.join(rootDir, "packages", "worker", "dist", "worker.js"),
        "utf8"
    );
    if (/from\s*["']@import-validator\//.test(workerJs) || /import\s*["']@import-validator\//.test(workerJs)) {
        throw new Error(
            "packages/worker/dist/worker.js still contains bare @import-validator imports. " +
            "Rebuild with: pnpm --filter @import-validator/worker run build"
        );
    }
}

function readGitSha() {
    try {
        return execSync("git rev-parse --short HEAD", { cwd: rootDir }).toString().trim();
    } catch {
        return "unknown";
    }
}

async function createKit() {
    await assertBuildOutputs();

    const sdkPkg = JSON.parse(
        await readFile(path.join(rootDir, "packages", "sdk", "package.json"), "utf8")
    );
    const version = sdkPkg.version;
    const gitSha = readGitSha();

    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.join(outDir, "packages"), { recursive: true });
    await mkdir(path.join(outDir, "static"), { recursive: true });
    await mkdir(path.join(outDir, "docs"), { recursive: true });

    // 1. Installable tarballs (pnpm pack rewrites workspace:* to real versions).
    const tarballs = [];
    for (const name of packageNames) {
        const pkgDir = path.join(rootDir, "packages", name);
        const output = execSync(
            `pnpm pack --pack-destination "${path.join(outDir, "packages")}"`,
            { cwd: pkgDir }
        ).toString().trim();
        const tarball = path.basename(output.split("\n").at(-1));
        tarballs.push(tarball);
        console.log(`[customer-kit] packed ${tarball}`);
    }

    // 2. Static assets for direct hosting (no bundler required).
    await cp(
        path.join(rootDir, "packages", "worker", "dist", "worker.js"),
        path.join(outDir, "static", "worker.js")
    );
    await cp(
        path.join(rootDir, "packages", "worker", "dist", "worker.js.map"),
        path.join(outDir, "static", "worker.js.map")
    ).catch(() => {});
    await cp(
        path.join(rootDir, "packages", "core", "dist", "wasm", "pkg", "import_validator_wasm_bg.wasm"),
        path.join(outDir, "static", "import_validator_wasm_bg.wasm")
    );

    // 3. Docs + license.
    for (const doc of docFiles) {
        await cp(path.join(rootDir, "docs", doc), path.join(outDir, "docs", doc));
    }
    await cp(path.join(rootDir, "LICENSE"), path.join(outDir, "LICENSE"));

    // 4. Manifest.
    const manifest = {
        product: "import-validator",
        version,
        gitSha,
        generatedAtUtc: new Date().toISOString(),
        contents: {
            packages: tarballs,
            static: ["worker.js", "worker.js.map", "import_validator_wasm_bg.wasm"],
            docs: docFiles,
        },
        runtimeNotes: {
            install: "npm install ./packages/<all .tgz files in one command>",
            staticHosting: "host static/worker.js and static/import_validator_wasm_bg.wasm on your origin",
            estimateOption: "estimate=true runs estimate+validate",
            estimateOnlyOption: "estimateOnly=true runs estimate pass only",
            excelSupport: ".xlsx supported, .xls rejected",
            fatalPayload: "onFatal(message, fatal) with stable fatal.code",
        },
    };
    await writeFile(
        path.join(outDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
    );

    // 5. Kit README.
    const tarballList = tarballs.map((t) => `  packages/${t}`).join("\n");
    await writeFile(
        path.join(outDir, "README.txt"),
        [
            `Import Validator Customer Kit v${version} (${gitSha})`,
            "",
            "1) Install the SDK packages into your app (single command):",
            `   npm install ${tarballs.map((t) => `./packages/${t}`).join(" ")}`,
            "",
            "2) Host the static assets on your origin (e.g. /assets/):",
            "   static/worker.js",
            "   static/import_validator_wasm_bg.wasm",
            "",
            "3) Integrate following docs/CLIENT_QUICKSTART.md:",
            "   createValidator({ schema, workerUrl: \"/assets/worker.js\",",
            "                     wasmUrl: \"/assets/import_validator_wasm_bg.wasm\" }, events)",
            "",
            "Included tarballs:",
            tarballList,
            "",
            "Docs:",
            "  docs/CLIENT_QUICKSTART.md        — integration steps and examples",
            "  docs/SCHEMA_REFERENCE.md         — full schema field reference",
            "  docs/SDK_API.md                  — SDK API and event reference",
            "  docs/CUSTOMER_DISTRIBUTION.md    — asset hosting and deployment guide",
            "  docs/NATIVE_CLIENTS.md           — Node.js / Python / C# / Go server-side guide",
            "  docs/validation-config.schema.json — machine-readable schema contract",
            "",
            "License: see LICENSE (commercial license required).",
            "",
            `Generated: ${manifest.generatedAtUtc}`,
        ].join("\n"),
        "utf8"
    );

    // 6. Zip the kit for handoff.
    const zipName = `import-validator-kit-v${version}.zip`;
    const zipPath = path.join(rootDir, "artifacts", zipName);
    await rm(zipPath, { force: true });
    execSync(`zip -qr "${zipPath}" .`, { cwd: outDir });

    console.log(`[customer-kit] created at ${outDir}`);
    console.log(`[customer-kit] zip: ${zipPath}`);
}

createKit().catch((err) => {
    console.error("[customer-kit] failed:", err);
    process.exit(1);
});
