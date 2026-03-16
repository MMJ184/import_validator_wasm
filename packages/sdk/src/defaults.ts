export function chooseMaxErrorsSmart(fileSizeBytes: number) {
    const MB = 1024 * 1024;

    if (fileSizeBytes < 5 * MB) return 2_000;
    if (fileSizeBytes < 50 * MB) return 5_000;
    if (fileSizeBytes < 200 * MB) return 10_000;
    return 20_000; // don't go crazy in browser
}

export function chooseEmitNormalizedSmart(fileSizeBytes: number) {
    const MB = 1024 * 1024;
    // normalized output becomes huge; disable for large files
    return fileSizeBytes <= 20 * MB;
}

export type ProfileDefaults = {
    maxPostErrorsTotal: number;
    postErrorBatch: number;
    estimate: boolean;
    emitNormalized: boolean;
};

export function profileDefaults(profile: "fast" | "balanced" | "strict" = "balanced"): ProfileDefaults {
    switch (profile) {
        case "fast":
            return {
                maxPostErrorsTotal: 10_000,
                postErrorBatch: 2_000,
                estimate: false,
                emitNormalized: false,
            };
        case "strict":
            return {
                maxPostErrorsTotal: 100_000,
                postErrorBatch: 1_000,
                estimate: true,
                emitNormalized: false,
            };
        default:
            return {
                maxPostErrorsTotal: 50_000,
                postErrorBatch: 2_000,
                estimate: false,
                emitNormalized: false,
            };
    }
}
