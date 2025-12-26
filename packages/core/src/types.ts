export interface Progress {
    rowsProcessed: number;
    errorsAdded: number;
    done: boolean;
}

export interface PackedError {
    row: number;
    col: number;
    code: number;
}

export type ErrorCodeString =
    | "MissingRequired"
    | "InvalidType"
    | "MaxLengthExceeded"
    | "NotAllowed"
    | "InvalidUtf8"
    | "MissingRequiredColumn"
    | "ExtraColumn"
    | "Unknown";

export type DecodedError = {
    row: number; // 0 means header-level
    code: number;
    codeString: ErrorCodeString;
    colIndex: number;
    colKind: "schema" | "input";
    columnName?: string;
    message: string;
};
