import type { WorkerValidateOptions } from "./protocol";
import { WorkerValidationError } from "./errorTaxonomy.js";

/** Only schemaVersion 1 is supported. Rejects 0, negatives, and future versions. */
export function assertSupportedSchemaVersion(version: number | undefined): void {
    const v = version ?? 1;
    if (v !== 1) {
        throw new WorkerValidationError(
            "SCHEMA_VERSION_UNSUPPORTED",
            `Unsupported schemaVersion=${v}. Current supported version is 1.`
        );
    }
}

export type ValidatePassFlags = {
    shouldEmitEstimate: boolean;
    estimateOnly: boolean;
    needsCsvEstimate: boolean;
};

export function deriveValidatePassFlags(options: WorkerValidateOptions): ValidatePassFlags {
    const estimateOnly = options.estimateOnly === true;
    const shouldEmitEstimate = options.estimate === true || estimateOnly;
    const needsCsvEstimate =
        shouldEmitEstimate ||
        !!options.maxRowsEstimate ||
        !!options.maxColumns ||
        estimateOnly;

    return {
        shouldEmitEstimate,
        estimateOnly,
        needsCsvEstimate
    };
}
