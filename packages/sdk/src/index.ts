import { ValidatorClient } from "./client.js";
import type {
    ValidationFatal,
    ValidationFatalCode,
    ValidationFatalPhase,
    ValidationFormat,
    ValidationMetrics,
    ValidationProfile,
    ValidatorEvents,
    ValidatorOptions
} from "./types.js";

export function createValidator(options: ValidatorOptions, events?: ValidatorEvents) {
    return new ValidatorClient(options, events);
}

export type {
    ValidatorOptions,
    ValidatorEvents,
    ValidationMetrics,
    ValidationProfile,
    ValidationFormat,
    ValidationFatal,
    ValidationFatalCode,
    ValidationFatalPhase
};
export { buildErrorReportCsv } from "./report.js";
