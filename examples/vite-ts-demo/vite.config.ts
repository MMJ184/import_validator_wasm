import { defineConfig } from "vite";
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@import-validator/worker': path.resolve(__dirname, '../../packages/worker/src'),
            '@import-validator/core': path.resolve(__dirname, '../../packages/core/src'),
        },
    },
    server: {
        fs: {
            allow: [path.resolve(__dirname, '../..')],
        },
    },
    optimizeDeps: {
        exclude: ['@import-validator/worker', '@import-validator/core'],
    },
    build: {
        target: "es2020",
        outDir: "dist",
    },
});
