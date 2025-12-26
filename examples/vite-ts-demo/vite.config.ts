import { defineConfig } from "vite";

export default defineConfig({
    // Ensure workspace packages resolve correctly
    resolve: {
        preserveSymlinks: true
    },

    // WASM + Worker friendly defaults
    worker: {
        format: "es"
    },

    build: {
        target: "es2020",
        sourcemap: true
    },

    optimizeDeps: {
        // Prevent Vite from trying to prebundle wasm-pack output
        exclude: [
            "@import-validator/core",
            "@import-validator/sdk",
            "@import-validator/worker"
        ]
    }
});
