export const demoSchema = {
    hasHeaders: true,
    delimiter: ",",
    failOnExtraColumns: false, // since we model all columns anyway, can be true too
    columns: [
        { name: "id", required: true, type: "int" },
        { name: "amount", required: true, type: "decimal", precision: 2 },
        { name: "date", required: true, type: "date", dateFormat: "ymd-dash" },
        { name: "status", required: true, type: "string", allowed: ["OPEN", "CLOSED"] },
        { name: "note", required: false, type: "string", maxLen: 200 }
    ]
};
