import type { DecodedError } from "@import-validator/core";

export function buildErrorReportCsv(errors: DecodedError[]): string {
    const header = "row,colKind,colIndex,columnName,code,codeString,message";
    const lines = errors.map((e) =>
        [
            e.row,
            esc(e.colKind),
            e.colIndex,
            esc(e.columnName ?? ""),
            e.code,
            esc(e.codeString),
            esc(e.message),
        ].join(",")
    );
    return [header, ...lines].join("\n");
}

function esc(v: string) {
    if (!/[,"\n\r]/.test(v)) return v;
    return `"${v.replace(/"/g, "\"\"")}"`;
}
