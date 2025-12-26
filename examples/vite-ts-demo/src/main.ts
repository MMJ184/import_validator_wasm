import "./style.css";

import { createValidator } from "@import-validator/sdk";
import { defaultWorkerUrl } from "@import-validator/sdk/vite";
import { defaultWasmUrl } from "@import-validator/core";

import { demoSchema } from "./schema";

const $file = document.getElementById("file") as HTMLInputElement;
const $run = document.getElementById("run") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLPreElement;
const $errors = document.getElementById("errors") as HTMLPreElement;
const $normalized = document.getElementById("normalized") as HTMLPreElement;

const decoder = new TextDecoder();

let lastValidator: ReturnType<typeof createValidator> | null = null;
let normalizedText = "";

// ✅ NEW: ready + pending file for this run
let ready = false;
let pendingFile: File | null = null;

function setStatus(s: string) {
    $status.textContent = s;
}

function resetUI() {
    $errors.textContent = "(none)";
    normalizedText = "";
    $normalized.textContent = "(collecting...)";
    setStatus("Starting...");
}

function appendNormalized(chunk: Uint8Array) {
    if (normalizedText.length > 200_000) return;
    normalizedText += decoder.decode(chunk, { stream: true });
    $normalized.textContent = normalizedText;
}

$run.onclick = () => {
    const f = $file.files?.[0];
    if (!f) {
        alert("Pick a CSV file first.");
        return;
    }

    // terminate previous worker if user runs again
    lastValidator?.terminate();
    lastValidator = null;

    // reset per-run state
    ready = false;
    pendingFile = f;

    resetUI();

    const v = createValidator(
        {
            schema: demoSchema,
            wasmUrl: defaultWasmUrl,
            workerUrl: defaultWorkerUrl,
            maxErrors: 10_000,
            emitNormalized: true
        },
        {
            onReady: (cols) => {
                ready = true;
                setStatus(`Ready. Schema columns: ${cols.join(", ")}`);

                // ✅ IMPORTANT: only validate after worker is ready
                if (pendingFile) {
                    v.validate(pendingFile);
                    pendingFile = null;
                }
            },

            onProgress: (p) => {
                setStatus(`Rows: ${p.rowsProcessed} | +errors: ${p.errorsAdded} | done: ${p.done}`);
            },

            onErrors: (errs) => {
                const shown = errs.slice(0, 200);
                $errors.textContent =
                    shown.length === 0
                        ? "(none)"
                        : shown.map((e) => e.message).join("\n");
            },

            onNormalized: (chunk) => {
                appendNormalized(chunk);
            },

            onDone: () => {
                setStatus("Done ✅");
            },

            onFatal: (msg) => {
                setStatus("Fatal ❌");
                $errors.textContent = msg;
                // if init fails, don't keep a pending file
                pendingFile = null;
            }
        }
    );

    lastValidator = v;

    // ❌ removed: v.validate(f);
    // because we validate in onReady now
};
