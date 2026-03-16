// packages/core/src/validate/nodeSource.ts
import fs from "fs";

export async function* fromFilePath(path: string, chunkSize = 1024 * 1024) {
    const stream = fs.createReadStream(path, { highWaterMark: chunkSize });
    for await (const chunk of stream) {
        yield new Uint8Array(chunk as Buffer);
    }
}
