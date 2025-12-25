import { ValidatorClient } from "./client";
import type { ValidatorOptions, ValidatorEvents } from "./types";

export function createValidator(
    options: ValidatorOptions,
    events?: ValidatorEvents
) {
    return new ValidatorClient(options, events);
}
