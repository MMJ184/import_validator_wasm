import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(root, "artifacts", "build-traces", stamp);
mkdirSync(outDir, { recursive: true });

const steps = [
    { name: "build-wasm", cmd: "pnpm", args: ["run", "build:wasm"] },
    { name: "build-core-pkg", cmd: "pnpm", args: ["--filter", "@import-validator/core", "run", "build:pkg"] },
    { name: "build-worker", cmd: "pnpm", args: ["--filter", "@import-validator/worker", "run", "build"] },
    { name: "build-node", cmd: "pnpm", args: ["--filter", "@import-validator/node", "run", "build"] },
    { name: "build-sdk", cmd: "pnpm", args: ["--filter", "@import-validator/sdk", "run", "build"] },
    { name: "build-example-vite", cmd: "pnpm", args: ["--filter", "vite-ts-demo", "run", "build"] },
];

const summary = [];

for (const step of steps) {
    const startedAt = Date.now();
    const logPath = join(outDir, `${step.name}.log`);
    const commandStr = `${step.cmd} ${step.args.join(" ")}`;
    process.stdout.write(`\n[trace] ${commandStr}\n`);

    const result = await runStep(step.cmd, step.args, root);
    const elapsedMs = Date.now() - startedAt;

    const log = [
        `# ${step.name}`,
        "",
        `command: ${commandStr}`,
        `exitCode: ${result.code}`,
        `elapsedMs: ${elapsedMs}`,
        "",
        "## stdout",
        result.stdout || "(empty)",
        "",
        "## stderr",
        result.stderr || "(empty)",
        "",
    ].join("\n");
    writeFileSync(logPath, log, "utf8");

    summary.push({
        step: step.name,
        command: commandStr,
        elapsedMs,
        exitCode: result.code,
        logPath,
    });

    if (result.code !== 0) {
        writeSummary(outDir, summary, true);
        process.stderr.write(`\n[trace] failed at ${step.name}. Trace: ${outDir}\n`);
        process.exit(result.code ?? 1);
    }
}

writeSummary(outDir, summary, false);
process.stdout.write(`\n[trace] completed. Trace: ${outDir}\n`);

function runStep(cmd, args, cwd) {
    return new Promise((resolvePromise) => {
        const child = spawn(cmd, args, { cwd, env: process.env, shell: false });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (buf) => {
            const s = String(buf);
            stdout += s;
            process.stdout.write(s);
        });
        child.stderr.on("data", (buf) => {
            const s = String(buf);
            stderr += s;
            process.stderr.write(s);
        });
        child.on("close", (code) => {
            resolvePromise({ code: code ?? 1, stdout, stderr });
        });
    });
}

function writeSummary(outDirPath, rows, failed) {
    const summaryJsonPath = join(outDirPath, "summary.json");
    writeFileSync(summaryJsonPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        failed,
        steps: rows,
    }, null, 2));

    const mdLines = [
        "# Build Trace Summary",
        "",
        `generatedAt: ${new Date().toISOString()}`,
        `status: ${failed ? "failed" : "ok"}`,
        "",
        "| Step | Exit | Elapsed (ms) | Log |",
        "|---|---:|---:|---|",
        ...rows.map((r) => `| ${r.step} | ${r.exitCode} | ${r.elapsedMs} | ${r.logPath} |`),
        "",
    ];
    writeFileSync(join(outDirPath, "summary.md"), mdLines.join("\n"), "utf8");
}
