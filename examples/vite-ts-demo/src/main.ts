// examples/vite-ts-demo/src/main.ts

import {WorkerRequest, WorkerResponse} from "@import-validator/worker/protocol";

const logEl = document.querySelector<HTMLPreElement>('#log');
const fileInput = document.querySelector<HTMLInputElement>('#file');
const btn = document.querySelector<HTMLButtonElement>('#run');

if (!logEl || !fileInput || !btn) {
    throw new Error('Missing required DOM elements: #log, #file, #run');
}

function append(line: string) {
    logEl.textContent += `${line}\n`;
}

// ✅ Worker comes from node_modules package (NO local worker file)
const worker = new Worker(
    new URL('@import-validator/worker/src/worker.ts', import.meta.url),
    { type: 'module' }
);

let schemaColumns: string[] = [];
let ready = false;

worker.onerror = (e) => {
    append(`WORKER ERROR: ${(e as ErrorEvent).message || 'unknown'}`);
    console.error('Worker error:', e);
};

worker.onmessageerror = (e) => {
    append('WORKER MESSAGE ERROR (structured clone failed)');
    console.error('Worker message error:', e);
};

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;

    if (msg.type === 'ready') {
        schemaColumns = msg.columns ?? [];
        ready = true;
        btn.disabled = false;
        append('Worker ready ✅');
        return;
    }

    if (msg.type === 'fatal') {
        append(`FATAL: ${msg.message}`);
        btn.disabled = true;
        ready = false;
        return;
    }

    if (msg.type === 'errors') {
        const u32 = new Uint32Array(msg.packed);
        for (let i = 0; i < u32.length; i += 2) {
            const row = u32[i];
            const word = u32[i + 1];
            const col = word >>> 8;
            const code = word & 0xff;
            const colName = schemaColumns[col] ?? `col#${col}`;
            append(`Error row=${row} col=${colName} code=${code}`);
        }
        return;
    }

    if (msg.type === 'normalized') {
        append(`Normalized chunk: ${msg.bytes.byteLength} bytes`);
        return;
    }

    if (msg.type === 'done') {
        append('DONE ✅');
        return;
    }

    append(`(debug) ${JSON.stringify(msg)}`);
};

btn.disabled = true;

// Example schema (same as your old sample)
const schema = {
    hasHeaders: true,
    delimiter: ','.charCodeAt(0),
    failOnExtraColumns: false,
    columns: [
        { name: 'id', required: true, type: 'int' },
        { name: 'amount', required: true, type: 'decimal', precision: 2 },
        { name: 'date', required: true, type: 'date', dateFormat: 'ymd-dash' },
        { name: 'status', required: true, type: 'string', allowed: ['OPEN', 'CLOSED'] },
        { name: 'note', required: false, type: 'string', maxLen: 140 }
    ]
};

// ✅ IMPORTANT: get the wasm URL from node_modules via Vite asset URL
// Your screenshot shows: core/src/wasm/pkg/import_validator_wasm_bg.wasm
const wasmUrl = new URL(
    '@import-validator/core/src/wasm/pkg/import_validator_wasm_bg.wasm',
    import.meta.url
).toString();

// init
append('Initializing worker...');

const initMsg: WorkerRequest = {
    type: 'init',
    wasmUrl,
    schema: JSON.stringify(schema),
    maxErrors: 10_000,
    emitNormalized: false
};

worker.postMessage(initMsg);

btn.onclick = () => {
    if (!ready) {
        append('Worker not ready yet...');
        return;
    }

    const file = fileInput.files?.[0];
    if (!file) {
        append('Pick a CSV file first');
        return;
    }

    append(`Validating: ${file.name} (${file.size} bytes)`);

    const validateMsg: WorkerRequest = {
        type: 'validate',
        file
    };

    worker.postMessage(validateMsg);
};
