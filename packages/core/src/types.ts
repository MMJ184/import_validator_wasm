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
