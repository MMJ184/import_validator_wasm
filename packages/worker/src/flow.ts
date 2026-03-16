import type { WorkerValidateOptions } from "./protocol";

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
