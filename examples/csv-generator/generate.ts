import * as path from "path";
import * as fs from "fs";

const OUTPUT_DIR = path.join(__dirname, "output");

type Status = "OPEN" | "CLOSED";

interface CsvRow {
    id: number;
    amount: string;
    date: string;
    status: Status;
    note: string;
}

function ensureOutputDir() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
}

function generateRows(count: number): CsvRow[] {
    const rows: CsvRow[] = [];

    for (let i = 1; i <= count; i++) {
        const amount = (100 + (i % 500) + 0.25).toFixed(2);
        const date = new Date(2025, 0, (i % 28) + 1).toISOString().slice(0, 10)

        rows.push({
            id: i,
            amount,
            date,
            status: i % 2 === 0 ? "CLOSED" : "OPEN",
            note: `Auto generated record ${i}`
        });
    }

    return rows;
}

function writeCsv(fileName: string, rows: CsvRow[]) {
    const header = "id,amount,date,status,note";

    // ✅ Use CRLF and always end with newline
    const content =
        [header, ...rows.map(r => `${r.id},${r.amount},${r.date},${r.status},${r.note}`)]
            .join("\r\n") + "\r\n";

    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), content, { encoding: "utf8" });
    console.log(`✅ ${fileName} created (${rows.length} rows)`);
}


function run() {
    ensureOutputDir();

    writeCsv("demo_100.csv", generateRows(100));
    writeCsv("demo_10000.csv", generateRows(10_000));
}

run();
