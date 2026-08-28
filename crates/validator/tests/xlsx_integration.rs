//! XLSX end-to-end tests through the public Rust API: streaming sheet/shared
//! strings pushes at every chunk size, and the native one-shot ZIP path.

use import_validator::{Validator, ValidatorOptions};

const SCHEMA: &str = r#"{
    "hasHeaders": true,
    "columns": [
        { "name": "id", "type": "int", "required": true, "unique": true },
        { "name": "email", "type": "email", "required": true, "modifiers": { "trim": true, "lowercase": true } },
        { "name": "amount", "type": "decimal", "precision": 2 },
        { "name": "active", "type": "string" },
        { "name": "notes", "type": "string" }
    ]
}"#;

const SHARED: &[u8] = br#"<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>id</t></si>
  <si><t>email</t></si>
  <si><r><t>am</t></r><r><t>ount</t></r></si>
  <si><t>active</t></si>
  <si><t>notes</t></si>
  <si><t>A &amp; B</t></si>
</sst>"#;

// Header via shared strings; data mixes inline strings, shared strings,
// numbers, booleans, sparse cells (D skipped in row 3), namespace prefixes.
const SHEET: &[u8] = br#"<?xml version="1.0"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <x:dimension ref="A1:E4"/>
  <x:sheetData>
    <x:row r="1">
      <x:c r="A1" t="s"><x:v>0</x:v></x:c>
      <x:c r="B1" t="s"><x:v>1</x:v></x:c>
      <x:c r="C1" t="s"><x:v>2</x:v></x:c>
      <x:c r="D1" t="s"><x:v>3</x:v></x:c>
      <x:c r="E1" t="s"><x:v>4</x:v></x:c>
    </x:row>
    <x:row r="2">
      <x:c r="A2"><x:v>1</x:v></x:c>
      <x:c r="B2" t="inlineStr"><x:is><x:t>Alice@Example.com</x:t></x:is></x:c>
      <x:c r="C2"><x:v>12.34</x:v></x:c>
      <x:c r="D2" t="b"><x:v>1</x:v></x:c>
      <x:c r="E2" t="s"><x:v>5</x:v></x:c>
    </x:row>
    <x:row r="3">
      <x:c r="A3"><x:v>2</x:v></x:c>
      <x:c r="B3" t="inlineStr"><x:is><x:t>bob@example.com</x:t></x:is></x:c>
      <x:c r="C3"><x:v>7</x:v></x:c>
      <x:c r="E3" t="inlineStr"><x:is><x:t xml:space="preserve">line1&#10;line2</x:t></x:is></x:c>
    </x:row>
    <x:row r="4">
      <x:c r="A4"><x:v>not-int</x:v></x:c>
      <x:c r="B4" t="inlineStr"><x:is><x:t>broken-email</x:t></x:is></x:c>
      <x:c r="C4"><x:v>1.999</x:v></x:c>
    </x:row>
  </x:sheetData>
</x:worksheet>"#;

fn run_streaming(chunk_size: usize) -> (u32, Vec<(u32, String, &'static str)>) {
    let mut v = Validator::new(SCHEMA, ValidatorOptions::default()).expect("schema");

    for chunk in SHARED.chunks(chunk_size) {
        v.push_shared_strings_chunk(chunk, false)
            .expect("shared push");
    }
    v.push_shared_strings_chunk(&[], true)
        .expect("shared finish");

    for chunk in SHEET.chunks(chunk_size) {
        v.push_sheet_chunk(chunk, false).expect("sheet push");
    }
    v.push_sheet_chunk(&[], true).expect("sheet finish");

    let errors = v
        .take_errors(1000)
        .into_iter()
        .map(|e| (e.row, e.column_name.unwrap_or_default(), e.code_name))
        .collect();
    (v.rows_processed(), errors)
}

#[test]
fn streaming_xlsx_validates_identically_at_every_chunk_size() {
    let reference = run_streaming(1 << 20);
    assert_eq!(reference.0, 3, "3 data rows");
    // row 3 (id=2): amount "7" is a valid decimal (rescaled), active missing → ok (not required)
    // row 4: bad int, bad email, decimal scale 3 > precision 2
    let mut codes: Vec<&str> = reference.1.iter().map(|e| e.2).collect();
    codes.sort_unstable();
    assert_eq!(codes, vec!["InvalidEmail", "InvalidType", "InvalidType"]);

    for chunk_size in [1usize, 2, 3, 5, 7, 11, 17, 31, 64, 257, 1024] {
        let got = run_streaming(chunk_size);
        assert_eq!(
            got, reference,
            "chunk_size={chunk_size} must match reference"
        );
    }
}

#[test]
fn shared_string_header_and_entity_values_resolve() {
    let (_, errors) = run_streaming(64);
    // Column names resolved through shared-strings header proves the header
    // row mapped correctly.
    let cols: Vec<&str> = errors.iter().map(|e| e.1.as_str()).collect();
    assert!(cols.contains(&"id"));
    assert!(cols.contains(&"email"));
    assert!(cols.contains(&"amount"));
}

#[test]
fn normalized_output_flows_from_sheet_rows() {
    let mut v = Validator::new(
        SCHEMA,
        ValidatorOptions {
            max_errors: 100,
            emit_normalized: true,
        },
    )
    .expect("schema");
    v.push_shared_strings_chunk(SHARED, true).expect("shared");
    v.push_sheet_chunk(SHEET, true).expect("sheet");
    let normalized = String::from_utf8(v.take_normalized()).expect("utf8");
    let lines: Vec<&str> = normalized.lines().collect();
    // 4 data rows; row 3's notes field embeds a quoted newline, so the raw
    // line count is 5 (rows with validation errors emit empty fields).
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0], "1,alice@example.com,12.34,TRUE,A & B");
    // sparse row: active (D) empty; notes has a quoted embedded newline
    assert!(lines[1].starts_with("2,bob@example.com,7.00,,\"line1"));
    assert_eq!(lines[2], "line2\""); // continuation of the quoted field
    assert_eq!(lines[3], ",,,,"); // fully-invalid row → all fields empty
}

// ── Native one-shot ZIP path ────────────────────────────────────────────────

/// Minimal ZIP writer (stored + deflate entries) for test fixtures.
fn build_zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    let mut offsets = Vec::new();

    for (name, data, deflate) in entries {
        let (payload, method): (Vec<u8>, u16) = if *deflate {
            (miniz_oxide::deflate::compress_to_vec(data, 6), 8)
        } else {
            (data.to_vec(), 0)
        };
        let crc = crc32(data);
        offsets.push(out.len() as u32);

        out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&0u16.to_le_bytes()); // date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&payload);
    }

    for (i, (name, data, deflate)) in entries.iter().enumerate() {
        let (payload_len, method): (u32, u16) = if *deflate {
            (
                miniz_oxide::deflate::compress_to_vec(data, 6).len() as u32,
                8,
            )
        } else {
            (data.len() as u32, 0)
        };
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // time
        central.extend_from_slice(&0u16.to_le_bytes()); // date
        central.extend_from_slice(&crc32(data).to_le_bytes());
        central.extend_from_slice(&payload_len.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offsets[i].to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }

    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    let central_size = out.len() as u32 - central_offset;

    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len

    out
}

fn crc32(data: &[u8]) -> u32 {
    // Table-less CRC-32 (IEEE), fine for small test fixtures.
    let mut crc = 0xffff_ffffu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[test]
fn one_shot_zip_validation_matches_streaming() {
    let reference = run_streaming(1 << 20);

    for deflate in [false, true] {
        let zip = build_zip(&[
            ("[Content_Types].xml", b"<Types/>".as_slice(), deflate),
            ("xl/workbook.xml", b"<workbook/>".as_slice(), deflate),
            ("xl/sharedStrings.xml", SHARED, deflate),
            ("xl/worksheets/sheet1.xml", SHEET, deflate),
        ]);

        let mut v = Validator::new(SCHEMA, ValidatorOptions::default()).expect("schema");
        let progress = v.validate_xlsx_bytes(&zip).expect("one-shot xlsx");
        assert!(progress.done);
        assert_eq!(v.rows_processed(), reference.0, "deflate={deflate}");

        let errors: Vec<(u32, String, &'static str)> = v
            .take_errors(1000)
            .into_iter()
            .map(|e| (e.row, e.column_name.unwrap_or_default(), e.code_name))
            .collect();
        assert_eq!(errors, reference.1, "deflate={deflate}");
    }
}

#[test]
fn one_shot_zip_rejects_missing_worksheet() {
    let zip = build_zip(&[("xl/workbook.xml", b"<workbook/>".as_slice(), false)]);
    let mut v = Validator::new(SCHEMA, ValidatorOptions::default()).expect("schema");
    let err = v.validate_xlsx_bytes(&zip).unwrap_err();
    assert!(err.contains("no worksheet"), "got: {err}");
}

#[test]
fn sheet_row_counter_counts_rows_and_columns() {
    use import_validator::xlsx::scanner::SheetRowCounter;
    for chunk_size in [1usize, 3, 17, 4096] {
        let mut c = SheetRowCounter::default();
        for chunk in SHEET.chunks(chunk_size) {
            c.push(chunk);
        }
        let (rows, cols) = c.finish();
        assert_eq!(rows, 4, "chunk={chunk_size}");
        assert_eq!(cols, Some(5), "chunk={chunk_size}");
    }
}

#[test]
fn xlsx_error_limit_caps_recording_without_skipping_rows() {
    // The sheet scanner used to abandon the rest of a chunk once the engine's
    // error queue filled — and it returned without carrying the remaining
    // bytes, so that data was dropped outright. Rows validated must now be
    // identical at every chunk size, whatever max_errors is.
    let reference_rows = run_streaming(1 << 20).0;

    for max_errors in [1u32, 2, 10_000] {
        for chunk_size in [1usize, 2, 3, 7, 17, 64, 257, 1024, 1 << 20] {
            let mut v = Validator::new(
                SCHEMA,
                ValidatorOptions {
                    max_errors,
                    ..ValidatorOptions::default()
                },
            )
            .expect("schema");

            for chunk in SHARED.chunks(chunk_size) {
                v.push_shared_strings_chunk(chunk, false)
                    .expect("shared push");
            }
            v.push_shared_strings_chunk(&[], true)
                .expect("shared finish");
            for chunk in SHEET.chunks(chunk_size) {
                v.push_sheet_chunk(chunk, false).expect("sheet push");
            }
            v.push_sheet_chunk(&[], true).expect("sheet finish");

            assert_eq!(
                v.rows_processed(),
                reference_rows,
                "max_errors={max_errors} chunk_size={chunk_size}: every row must be read"
            );

            let kept = v.take_errors(10_000).len() as u64;
            assert_eq!(
                kept + v.errors_suppressed(),
                3,
                "max_errors={max_errors} chunk_size={chunk_size}: kept + suppressed must be exact"
            );
        }
    }
}
