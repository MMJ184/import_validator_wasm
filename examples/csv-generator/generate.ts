import * as path from "path";
import * as fs from "fs";
import { once } from "events";
import { deflateRawSync } from "zlib";

const OUTPUT_DIR = path.join(__dirname, "output");
const DEFAULT_SIZES = [
    100,
    1_000,
    10_000,
    50_000,
    100_000,
    250_000,
    500_000,
    1_000_000,
    2_000_000,
    3_000_000,
];
const LARGE_SIZES = [10_000_000, 100_000_000];
const EXTREME_SIZES = [1_000_000_000];
const DEFAULT_XLSX_SIZES = [100, 1_000, 10_000, 25_000, 50_000, 100_000];

const HEADER_COLUMNS = [
    "customerId",
    "idNumber",
    "firstName",
    "middleName",
    "lastName",
    "surname",
    "email",
    "alternateEmail",
    "phoneNumber",
    "alternatePhone",
    "addressLine1",
    "addressLine2",
    "city",
    "state",
    "postalCode",
    "countryCode",
    "gender",
    "kycVerified",
    "customerTier",
    "amount",
    "taxAmount",
    "discountRate",
    "creditScore",
    "dateOfBirth",
    "joiningDate",
    "lastLoginDate",
    "accountStatus",
    "preferredLanguage",
    "notes"
];
const HEADER = HEADER_COLUMNS.join(",");

const FIRST_NAMES = ["Aarav", "Vivaan", "Diya", "Anaya", "Rohan", "Ishita", "Kabir", "Mira"];
const LAST_NAMES = ["Sharma", "Patel", "Reddy", "Gupta", "Khan", "Nair", "Verma", "Das"];
const CITIES = ["MUMBAI", "DELHI", "BENGALURU", "CHENNAI"];
const STATES = ["MAHARASHTRA", "DELHI", "KARNATAKA", "TAMIL_NADU"];
const COUNTRIES = ["IN", "US", "AE"];
const STATUS = ["ACTIVE", "INACTIVE", "PENDING"];
const GENDERS = ["MALE", "FEMALE", "OTHER"];
const TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"];
const LANGS = ["EN", "HI", "TA"];
const CSV_PROGRESS_EVERY_ROWS = 1_000_000;
const XLSX_PROGRESS_EVERY_ROWS = 2_000;
const MAX_XLSX_ROWS = 100_000;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

type Preset = "default" | "large" | "extreme" | "all";
type OutputFormat = "csv" | "xlsx" | "both";

type CliOptions = {
    sizes: number[];
    overwrite: boolean;
    outputDir: string;
    format: OutputFormat;
};

type ZipEntry = {
    name: string;
    data: Buffer;
    compress?: boolean;
};

const CRC32_TABLE = createCrc32Table();

function ensureOutputDir(outputDir: string) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
}

function rowToValues(i: number): string[] {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const middleName = i % 5 === 0 ? "" : FIRST_NAMES[(i + 2) % FIRST_NAMES.length];
    const lastName = LAST_NAMES[i % LAST_NAMES.length];
    const surname = i % 7 === 0 ? "" : LAST_NAMES[(i + 3) % LAST_NAMES.length];
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`;
    const alternateEmail = i % 6 === 0 ? "" : `${firstName.toLowerCase()}${i}@altmail.com`;
    const phone = `9${String((100000000 + i) % 1000000000).padStart(9, "0")}`;
    const alternatePhone = i % 4 === 0 ? "" : `8${String((200000000 + i) % 1000000000).padStart(9, "0")}`;
    const address = `House-${(i % 250) + 1} Street-${(i % 90) + 1} Sector-${(i % 20) + 1}`;
    const address2 = i % 3 === 0 ? "" : `Landmark-${(i % 75) + 1}`;
    const city = CITIES[i % CITIES.length];
    const state = STATES[i % STATES.length];
    const postalCode = String(400000 + (i % 90000)).padStart(6, "0");
    const country = COUNTRIES[i % COUNTRIES.length];
    const gender = GENDERS[i % GENDERS.length];
    const kycVerified = i % 2 === 0 ? "YES" : "NO";
    const customerTier = TIERS[i % TIERS.length];
    const amount = (100 + (i % 500) + 0.25).toFixed(2);
    const taxAmount = (amountAsNumber(amount) * 0.18).toFixed(2);
    const discountRate = ((i % 25) / 100).toFixed(2);
    const creditScore = String(600 + (i % 251));
    const dob = new Date(1980 + (i % 30), i % 12, (i % 28) + 1).toISOString().slice(0, 10);
    const joiningDate = new Date(2010 + (i % 12), (i + 1) % 12, (i % 28) + 1).toISOString().slice(0, 10);
    const lastLoginDate = new Date(2024 + (i % 2), (i + 2) % 12, (i % 28) + 1).toISOString().slice(0, 10);
    const status = STATUS[i % STATUS.length];
    const preferredLanguage = LANGS[i % LANGS.length];
    const notes = i % 9 === 0 ? "" : `Customer note ${i}`;
    const idNumber = String(1000000000 + i);

    return [
        String(i),
        idNumber,
        firstName,
        middleName,
        lastName,
        surname,
        email,
        alternateEmail,
        phone,
        alternatePhone,
        address,
        address2,
        city,
        state,
        postalCode,
        country,
        gender,
        kycVerified,
        customerTier,
        amount,
        taxAmount,
        discountRate,
        creditScore,
        dob,
        joiningDate,
        lastLoginDate,
        status,
        preferredLanguage,
        notes
    ];
}

function rowToCsv(i: number): string {
    return rowToValues(i).join(",");
}

function amountAsNumber(amount: string) {
    return Number.parseFloat(amount);
}

function parsePreset(preset: Preset): number[] {
    if (preset === "default") return [...DEFAULT_SIZES];
    if (preset === "large") return [...LARGE_SIZES];
    if (preset === "extreme") return [...EXTREME_SIZES];
    return [...DEFAULT_SIZES, ...LARGE_SIZES, ...EXTREME_SIZES];
}

function parseSizesArg(raw: string): number[] {
    const values = raw
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    return [...new Set(values)];
}

function parseArgs(argv: string[]): CliOptions {
    let preset: Preset = "default";
    let explicitSizes: number[] | null = null;
    let overwrite = false;
    let outputDir = OUTPUT_DIR;
    let format: OutputFormat = "csv";

    for (const arg of argv) {
        if (arg.startsWith("--preset=")) {
            const value = arg.slice("--preset=".length) as Preset;
            if (value === "default" || value === "large" || value === "extreme" || value === "all") {
                preset = value;
                continue;
            }
            throw new Error(`Unknown preset: ${value}. Allowed: default, large, extreme, all`);
        }

        if (arg.startsWith("--sizes=")) {
            explicitSizes = parseSizesArg(arg.slice("--sizes=".length));
            continue;
        }

        if (arg.startsWith("--format=")) {
            const value = arg.slice("--format=".length) as OutputFormat;
            if (value === "csv" || value === "xlsx" || value === "both") {
                format = value;
                continue;
            }
            throw new Error(`Unknown format: ${value}. Allowed: csv, xlsx, both`);
        }

        if (arg === "--overwrite") {
            overwrite = true;
            continue;
        }

        if (arg.startsWith("--output-dir=")) {
            outputDir = path.resolve(arg.slice("--output-dir=".length));
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    const sizes = explicitSizes?.length
        ? explicitSizes
        : format === "xlsx"
            ? [...DEFAULT_XLSX_SIZES]
            : parsePreset(preset);

    if (!sizes.length) {
        throw new Error("No sizes to generate. Pass --sizes=... or use a preset.");
    }

    return {
        sizes,
        overwrite,
        outputDir,
        format
    };
}

async function writeCsv(outputDir: string, fileName: string, rowCount: number, overwrite: boolean) {
    const filePath = path.join(outputDir, fileName);
    if (fs.existsSync(filePath) && !overwrite) {
        console.log(`⏭️  ${fileName} exists, skipping (use --overwrite to regenerate)`);
        return;
    }

    const startedAt = Date.now();
    const stream = fs.createWriteStream(filePath, { encoding: "utf8" });

    stream.write(`${HEADER}\r\n`);

    for (let i = 1; i <= rowCount; i += 1) {
        const ok = stream.write(`${rowToCsv(i)}\r\n`);
        if (!ok) {
            await once(stream, "drain");
        }
        if (i % CSV_PROGRESS_EVERY_ROWS === 0) {
            console.log(`... ${fileName}: ${i}/${rowCount} rows`);
        }
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
        stream.on("error", rejectPromise);
        stream.end(() => resolvePromise());
    });

    const tookMs = Date.now() - startedAt;
    console.log(`✅ ${fileName} created (${rowCount} rows, ${(tookMs / 1000).toFixed(1)}s)`);
}

async function writeXlsx(outputDir: string, fileName: string, rowCount: number, overwrite: boolean) {
    if (rowCount > MAX_XLSX_ROWS) {
        console.log(`⚠️  ${fileName} skipped: XLSX generation supports up to ${MAX_XLSX_ROWS} rows in this example generator`);
        return;
    }

    const filePath = path.join(outputDir, fileName);
    if (fs.existsSync(filePath) && !overwrite) {
        console.log(`⏭️  ${fileName} exists, skipping (use --overwrite to regenerate)`);
        return;
    }

    const startedAt = Date.now();
    const workbook = buildXlsxWorkbook(rowCount, fileName);
    await fs.promises.writeFile(filePath, workbook);

    const tookMs = Date.now() - startedAt;
    console.log(`✅ ${fileName} created (${rowCount} rows, ${(tookMs / 1000).toFixed(1)}s)`);
}

function buildXlsxWorkbook(rowCount: number, fileName: string): Buffer {
    const worksheetXml = buildWorksheetXml(rowCount, fileName);

    const entries: ZipEntry[] = [
        {
            name: "[Content_Types].xml",
            data: toBuffer(contentTypesXml())
        },
        {
            name: "_rels/.rels",
            data: toBuffer(rootRelsXml())
        },
        {
            name: "xl/workbook.xml",
            data: toBuffer(workbookXml())
        },
        {
            name: "xl/_rels/workbook.xml.rels",
            data: toBuffer(workbookRelsXml())
        },
        {
            name: "xl/worksheets/sheet1.xml",
            data: toBuffer(worksheetXml)
        },
    ];

    return createZip(entries);
}

function buildWorksheetXml(rowCount: number, fileName: string): string {
    const parts: string[] = [];
    const columnNames = HEADER_COLUMNS.map((_, i) => excelColumnName(i));

    parts.push(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>"
    );

    appendWorksheetRow(parts, 1, HEADER_COLUMNS, columnNames);

    for (let i = 1; i <= rowCount; i += 1) {
        appendWorksheetRow(parts, i + 1, rowToValues(i), columnNames);
        if (i % XLSX_PROGRESS_EVERY_ROWS === 0) {
            console.log(`... ${fileName}: ${i}/${rowCount} rows (xlsx)`);
        }
    }

    parts.push("</sheetData></worksheet>");
    return parts.join("");
}

function appendWorksheetRow(parts: string[], rowNumber: number, values: string[], columnNames: string[]) {
    parts.push(`<row r="${rowNumber}">`);

    for (let i = 0; i < values.length; i += 1) {
        const cellRef = `${columnNames[i]}${rowNumber}`;
        const value = escapeXml(values[i] ?? "");
        parts.push(`<c r="${cellRef}" t="inlineStr"><is><t>${value}</t></is></c>`);
    }

    parts.push("</row>");
}

function contentTypesXml() {
    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
        "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
        "</Types>"
    ].join("");
}

function rootRelsXml() {
    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>",
        "</Relationships>"
    ].join("");
}

function workbookXml() {
    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
        "<sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets>",
        "</workbook>"
    ].join("");
}

function workbookRelsXml() {
    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
        "</Relationships>"
    ].join("");
}

function createZip(entries: ZipEntry[]): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const fileName = Buffer.from(entry.name, "utf8");
        const sourceData = entry.data;
        const shouldCompress = entry.compress ?? true;
        const compressedData = shouldCompress ? deflateRawSync(sourceData) : sourceData;
        const method = shouldCompress ? 8 : 0;
        const crc = crc32(sourceData);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 6);
        localHeader.writeUInt16LE(method, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(compressedData.length, 18);
        localHeader.writeUInt32LE(sourceData.length, 22);
        localHeader.writeUInt16LE(fileName.length, 26);
        localHeader.writeUInt16LE(0, 28);

        localParts.push(localHeader, fileName, compressedData);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0, 8);
        centralHeader.writeUInt16LE(method, 10);
        centralHeader.writeUInt16LE(0, 12);
        centralHeader.writeUInt16LE(0, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(compressedData.length, 20);
        centralHeader.writeUInt32LE(sourceData.length, 24);
        centralHeader.writeUInt16LE(fileName.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);

        centralParts.push(centralHeader, fileName);

        offset += localHeader.length + fileName.length + compressedData.length;
    }

    const centralStart = offset;
    const centralBuffer = Buffer.concat(centralParts);
    const localBuffer = Buffer.concat(localParts);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

function createCrc32Table(): Uint32Array {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let j = 0; j < 8; j += 1) {
            if ((value & 1) === 1) {
                value = 0xedb88320 ^ (value >>> 1);
            } else {
                value >>>= 1;
            }
        }
        table[i] = value >>> 0;
    }
    return table;
}

function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) {
        crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function excelColumnName(index: number): string {
    let value = index + 1;
    let out = "";

    while (value > 0) {
        const rem = (value - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        value = Math.floor((value - 1) / 26);
    }

    return out;
}

function toBuffer(text: string): Buffer {
    return Buffer.from(text, "utf8");
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

async function run() {
    const options = parseArgs(process.argv.slice(2));
    ensureOutputDir(options.outputDir);
    console.log(`Output dir: ${options.outputDir}`);
    console.log(`Rows set: ${options.sizes.join(", ")}`);
    console.log(`Format: ${options.format}`);
    console.log(`Overwrite: ${options.overwrite ? "yes" : "no"}`);

    for (const size of options.sizes) {
        if (options.format === "csv" || options.format === "both") {
            await writeCsv(options.outputDir, `demo_${size}.csv`, size, options.overwrite);
        }
        if (options.format === "xlsx" || options.format === "both") {
            await writeXlsx(options.outputDir, `demo_${size}.xlsx`, size, options.overwrite);
        }
    }
}

run().catch((err) => {
    console.error("❌ File generation failed:", err);
    process.exit(1);
});
