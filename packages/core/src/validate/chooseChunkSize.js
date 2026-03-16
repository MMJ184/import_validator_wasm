export function chooseChunkSizeSmart(fileSizeBytes, hints = {}) {
    const KB = 1024;
    const MB = 1024 * KB;
    const mode = hints.mode ?? "validate";
    const deviceMemoryGb = hints.deviceMemoryGb ??
        (typeof navigator !== "undefined"
            ? navigator.deviceMemory
            : undefined);
    // Base chunk from file size.
    let chunk = fileSizeBytes < 1 * MB ? 128 * KB :
        fileSizeBytes < 10 * MB ? 256 * KB :
            fileSizeBytes < 50 * MB ? 512 * KB :
                fileSizeBytes < 200 * MB ? 1 * MB :
                    fileSizeBytes < 1000 * MB ? 2 * MB :
                        4 * MB;
    // Cap chunk size by available device memory.
    if (deviceMemoryGb !== undefined) {
        if (deviceMemoryGb <= 2) {
            chunk = Math.min(chunk, 256 * KB);
        }
        else if (deviceMemoryGb <= 4) {
            chunk = Math.min(chunk, 512 * KB);
        }
        else if (deviceMemoryGb <= 8) {
            chunk = Math.min(chunk, 1 * MB);
        }
        else {
            chunk = Math.min(chunk, 4 * MB);
        }
    }
    // Estimate pass should stay lighter to avoid blocking UI updates.
    if (mode === "estimate") {
        chunk = Math.min(chunk, 512 * KB);
    }
    // Safety bounds.
    chunk = Math.max(128 * KB, Math.min(chunk, 4 * MB));
    return chunk;
}
