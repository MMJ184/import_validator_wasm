export type ChunkMode = "estimate" | "validate";
export type ChunkSizeHints = {
    mode?: ChunkMode;
    deviceMemoryGb?: number;
};
export declare function chooseChunkSizeSmart(fileSizeBytes: number, hints?: ChunkSizeHints): number;
