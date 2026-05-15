import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "artifacts", "customer-kit");

const requiredPaths = [
    path.join(rootDir, "packages", "core", "dist"),
    path.join(rootDir, "packages", "worker", "dist"),
    path.join(rootDir, "packages", "sdk", "dist"),
];

const copyPlan = [
    {
        from: path.join(rootDir, "packages", "core", "dist"),
        to: path.join(outDir, "packages", "core-dist"),
    },
    {
        from: path.join(rootDir, "packages", "worker", "dist"),
        to: path.join(outDir, "packages", "worker-dist"),
    },
    {
        from: path.join(rootDir, "packages", "sdk", "dist"),
        to: path.join(outDir, "packages", "sdk-dist"),
    },
    {
        from: path.join(rootDir, "docs", "CUSTOMER_DISTRIBUTION.md"),
        to: path.join(outDir, "docs", "CUSTOMER_DISTRIBUTION.md"),
    },
    {
        from: path.join(rootDir, "docs", "CLIENT_QUICKSTART.md"),
        to: path.join(outDir, "docs", "CLIENT_QUICKSTART.md"),
    },
    {
        from: path.join(rootDir, "docs", "SCHEMA_REFERENCE.md"),
        to: path.join(outDir, "docs", "SCHEMA_REFERENCE.md"),
    },
    {
        from: path.join(rootDir, "docs", "SDK_API.md"),
        to: path.join(outDir, "docs", "SDK_API.md"),
    },
    {
        from: path.join(rootDir, "docs", "validation-config.schema.json"),
        to: path.join(outDir, "docs", "validation-config.schema.json"),
    },
    {
        from: path.join(rootDir, "docs", "customer-profiles.json"),
        to: path.join(outDir, "docs", "customer-profiles.json"),
    },
];

async function assertBuildOutputs() {
    for (const target of requiredPaths) {
        try {
            await stat(target);
        } catch {
            throw new Error(
                `Missing build output: ${path.relative(rootDir, target)}. ` +
                `Run "pnpm run build" before creating customer kit.`
            );
        }
    }
}

async function createKit() {
    await assertBuildOutputs();

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    for (const item of copyPlan) {
        await mkdir(path.dirname(item.to), { recursive: true });
        await cp(item.from, item.to, { recursive: true });
    }

    const manifest = {
        generatedAtUtc: new Date().toISOString(),
        kitVersion: 1,
        includes: copyPlan.map((item) => path.relative(outDir, item.to)),
        runtimeNotes: {
            estimateOption: "estimate=true runs estimate+validate",
            estimateOnlyOption: "estimateOnly=true runs estimate pass only",
            excelSupport: ".xlsx supported, .xls rejected",
            fatalPayload: "onFatal(message, fatal) with stable fatal.code"
        }
    };

    await writeFile(
        path.join(outDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
    );

    await writeFile(
        path.join(outDir, "README.txt"),
        [
            "Import Validator Customer Kit",
            "",
            "Start here:",
            "  docs/CLIENT_QUICKSTART.md        — integration steps and examples",
            "  docs/SCHEMA_REFERENCE.md         — full schema field reference",
            "  docs/SDK_API.md                  — SDK API and event reference",
            "  docs/CUSTOMER_DISTRIBUTION.md    — asset hosting and deployment guide",
            "  docs/validation-config.schema.json — machine-readable schema contract",
            "",
            "3) Integrate sdk-dist + worker-dist + core-dist in customer app",
            "",
            `Generated: ${manifest.generatedAtUtc}`
        ].join("\n"),
        "utf8"
    );

    console.log(`[customer-kit] created at ${outDir}`);
}

createKit().catch((err) => {
    console.error("[customer-kit] failed:", err);
    process.exit(1);
});
