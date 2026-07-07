//! Native one-shot XLSX validation: ZIP container parsing + streaming
//! DEFLATE (miniz_oxide), feeding the shared XLSX scanner.
//!
//! Only compiled for non-WASM targets — the browser uses its native
//! `DecompressionStream` and the TypeScript ZIP reader instead, keeping this
//! code (and miniz_oxide) out of the WASM binary.
//!
//! Guardrails are identical to the browser pipeline: entry-count cap,
//! per-entry and total decompressed-size caps, compression-ratio cap, and no
//! ZIP64.

use crate::engine::ValidatorCore;
use crate::schema::Progress;
use miniz_oxide::inflate::stream::{inflate, InflateState};
use miniz_oxide::{DataFormat, MZFlush, MZStatus};
use std::collections::HashMap;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const EOCD_MIN_BYTES: usize = 22;
const LOCAL_MIN_BYTES: usize = 30;
const CENTRAL_MIN_BYTES: usize = 46;

const MAX_ZIP_ENTRIES: usize = 20_000;
const MAX_ENTRY_UNCOMPRESSED: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED: u64 = 768 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 1_000;
const MAX_SHEET_XML_BYTES: u64 = 192 * 1024 * 1024;
const MAX_SHARED_STRINGS_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone)]
struct ZipEntry {
    compression_method: u16,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
}

/// Validate a complete `.xlsx` byte buffer against an initialized engine.
/// Shared strings (when present) stream first, then the first worksheet.
pub fn validate_xlsx_bytes(core: &mut ValidatorCore, bytes: &[u8]) -> Result<Progress, String> {
    let entries = parse_entries(bytes)?;

    let sheet_name = pick_first_worksheet(&entries)
        .ok_or_else(|| "Invalid XLSX: no worksheet XML found in xl/worksheets/".to_string())?;
    let sheet = entries.get(&sheet_name).expect("sheet entry present");
    if sheet.uncompressed_size > MAX_SHEET_XML_BYTES {
        return Err(format!(
            "XLSX worksheet XML is too large ({} bytes). Limit is {} bytes. Split the workbook or convert to CSV for high-volume validation.",
            sheet.uncompressed_size, MAX_SHEET_XML_BYTES
        ));
    }

    let before_rows = core.rows_processed();

    if let Some(shared) = entries.get("xl/sharedStrings.xml") {
        if shared.uncompressed_size > MAX_SHARED_STRINGS_BYTES {
            return Err(format!(
                "XLSX shared strings XML is too large ({} bytes). Limit is {} bytes. Use fewer unique string values per workbook or split the Excel file.",
                shared.uncompressed_size, MAX_SHARED_STRINGS_BYTES
            ));
        }
        stream_entry(bytes, shared, "xl/sharedStrings.xml", &mut |chunk| {
            core.push_shared_strings_chunk(chunk, false)
        })?;
        core.push_shared_strings_chunk(&[], true)?;
    }

    let sheet = sheet.clone();
    stream_entry(bytes, &sheet, &sheet_name, &mut |chunk| {
        core.push_sheet_chunk(chunk, false).map(|_| ())
    })?;
    core.push_sheet_chunk(&[], true)?;

    Ok(Progress {
        rows_processed: core.rows_processed() - before_rows,
        errors_added: core.errors_count(),
        done: true,
    })
}

fn parse_entries(bytes: &[u8]) -> Result<HashMap<String, ZipEntry>, String> {
    let eocd = find_eocd(bytes)?;
    let total_entries = read_u16(bytes, eocd + 10)? as usize;
    let central_size = read_u32(bytes, eocd + 12)? as u64;
    let central_offset = read_u32(bytes, eocd + 16)? as u64;

    if total_entries == 0xffff || central_size == 0xffff_ffff || central_offset == 0xffff_ffff {
        return Err("ZIP64 XLSX is not supported in this build.".to_string());
    }
    if total_entries > MAX_ZIP_ENTRIES {
        return Err(format!(
            "XLSX ZIP has too many entries ({total_entries}); limit is {MAX_ZIP_ENTRIES}."
        ));
    }
    if central_offset + central_size > bytes.len() as u64 {
        return Err("Invalid XLSX ZIP: central directory exceeds file bounds.".to_string());
    }

    let mut entries = HashMap::with_capacity(total_entries.min(4096));
    let mut cursor = central_offset as usize;
    let mut total_uncompressed: u64 = 0;

    for _ in 0..total_entries {
        if read_u32(bytes, cursor)? != CENTRAL_SIGNATURE {
            return Err("Invalid XLSX ZIP: central directory signature mismatch.".to_string());
        }
        if cursor + CENTRAL_MIN_BYTES > bytes.len() {
            return Err("Invalid XLSX ZIP: truncated central directory record.".to_string());
        }

        let compression_method = read_u16(bytes, cursor + 10)?;
        let compressed_size = read_u32(bytes, cursor + 20)? as u64;
        let uncompressed_size = read_u32(bytes, cursor + 24)? as u64;
        let name_len = read_u16(bytes, cursor + 28)? as usize;
        let extra_len = read_u16(bytes, cursor + 30)? as usize;
        let comment_len = read_u16(bytes, cursor + 32)? as usize;
        let local_header_offset = read_u32(bytes, cursor + 42)? as u64;

        if compressed_size == 0xffff_ffff
            || uncompressed_size == 0xffff_ffff
            || local_header_offset == 0xffff_ffff
        {
            return Err("ZIP64 XLSX is not supported in this build.".to_string());
        }

        let name_start = cursor + 46;
        let name_end = name_start + name_len;
        if name_end > bytes.len() {
            return Err("Invalid XLSX ZIP: truncated central directory record.".to_string());
        }
        let name = String::from_utf8_lossy(&bytes[name_start..name_end]).into_owned();

        if uncompressed_size > MAX_ENTRY_UNCOMPRESSED {
            return Err(format!(
                "XLSX ZIP entry \"{name}\" exceeds safe size limit ({MAX_ENTRY_UNCOMPRESSED} bytes)."
            ));
        }
        if compressed_size > 0 {
            if uncompressed_size / compressed_size > MAX_COMPRESSION_RATIO {
                return Err(format!(
                    "XLSX ZIP entry \"{name}\" exceeds max compression ratio ({MAX_COMPRESSION_RATIO}x)."
                ));
            }
        } else if uncompressed_size > 0 {
            return Err(format!(
                "Invalid XLSX ZIP entry \"{name}\": zero compressed size with non-zero payload."
            ));
        }

        total_uncompressed += uncompressed_size;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
            return Err(format!(
                "XLSX ZIP decompressed size exceeds safe limit ({MAX_TOTAL_UNCOMPRESSED} bytes)."
            ));
        }
        if local_header_offset >= bytes.len() as u64 {
            return Err(format!(
                "Invalid XLSX ZIP: local header offset out of bounds for \"{name}\"."
            ));
        }

        entries.insert(
            name,
            ZipEntry {
                compression_method,
                compressed_size,
                uncompressed_size,
                local_header_offset,
            },
        );

        cursor = name_end + extra_len + comment_len;
    }

    Ok(entries)
}

fn pick_first_worksheet(entries: &HashMap<String, ZipEntry>) -> Option<String> {
    let mut sheets: Vec<&String> = entries
        .keys()
        .filter(|n| n.starts_with("xl/worksheets/") && n.ends_with(".xml"))
        .collect();
    sheets.sort_by_key(|n| sheet_order(n));
    sheets.first().map(|s| (*s).clone())
}

fn sheet_order(name: &str) -> (u64, &str) {
    // "…sheet<digits>.xml" sorts numerically; anything else after.
    let base = name.strip_suffix(".xml").unwrap_or(name);
    let digits: String = base
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() || !base[..base.len() - digits.len()].ends_with("sheet") {
        return (u64::MAX, name);
    }
    let n: u64 = digits
        .chars()
        .rev()
        .collect::<String>()
        .parse()
        .unwrap_or(u64::MAX);
    (n, name)
}

/// Stream one entry's decompressed bytes into `sink` in ~64 KB chunks.
fn stream_entry(
    bytes: &[u8],
    entry: &ZipEntry,
    name: &str,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let lho = entry.local_header_offset as usize;
    if lho + LOCAL_MIN_BYTES > bytes.len() || read_u32(bytes, lho)? != LOCAL_SIGNATURE {
        return Err(format!(
            "Invalid XLSX ZIP: local header signature mismatch for \"{name}\"."
        ));
    }
    let name_len = read_u16(bytes, lho + 26)? as usize;
    let extra_len = read_u16(bytes, lho + 28)? as usize;
    let data_start = lho + LOCAL_MIN_BYTES + name_len + extra_len;
    let data_end = data_start + entry.compressed_size as usize;
    if data_end > bytes.len() {
        return Err(format!(
            "Invalid XLSX ZIP: compressed payload out of bounds for \"{name}\"."
        ));
    }
    let compressed = &bytes[data_start..data_end];

    let mut emitted: u64 = 0;
    match entry.compression_method {
        0 => {
            // stored
            emitted = compressed.len() as u64;
            for chunk in compressed.chunks(64 * 1024) {
                sink(chunk)?;
            }
        }
        8 => {
            let mut state = InflateState::new_boxed(DataFormat::Raw);
            let mut out = vec![0u8; 64 * 1024];
            let mut in_pos = 0usize;
            loop {
                let flush = if in_pos >= compressed.len() {
                    MZFlush::Finish
                } else {
                    MZFlush::None
                };
                let res = inflate(&mut state, &compressed[in_pos..], &mut out, flush);
                in_pos += res.bytes_consumed;
                emitted += res.bytes_written as u64;
                if emitted > entry.uncompressed_size {
                    return Err(format!(
                        "Invalid XLSX ZIP: uncompressed size mismatch for \"{name}\" (expected {}, got more).",
                        entry.uncompressed_size
                    ));
                }
                if res.bytes_written > 0 {
                    sink(&out[..res.bytes_written])?;
                }
                match res.status {
                    Ok(MZStatus::StreamEnd) => break,
                    Ok(_) => {
                        if res.bytes_consumed == 0 && res.bytes_written == 0 {
                            if in_pos >= compressed.len() {
                                break;
                            }
                            return Err(format!(
                                "Invalid XLSX ZIP: DEFLATE stream stalled for \"{name}\"."
                            ));
                        }
                    }
                    Err(_) => {
                        return Err(format!(
                            "Invalid XLSX ZIP: DEFLATE decompression failed for \"{name}\"."
                        ));
                    }
                }
            }
        }
        other => {
            return Err(format!(
                "Unsupported ZIP compression method {other} for entry \"{name}\"."
            ));
        }
    }

    if emitted != entry.uncompressed_size {
        return Err(format!(
            "Invalid XLSX ZIP: uncompressed size mismatch for \"{name}\" (expected {}, got {emitted}).",
            entry.uncompressed_size
        ));
    }
    Ok(())
}

fn find_eocd(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < EOCD_MIN_BYTES {
        return Err("Invalid XLSX ZIP: file too small.".to_string());
    }
    let search_start = bytes.len().saturating_sub(EOCD_MIN_BYTES + 0xffff);
    let mut i = bytes.len() - EOCD_MIN_BYTES;
    loop {
        if read_u32(bytes, i)? == EOCD_SIGNATURE {
            return Ok(i);
        }
        if i == search_start {
            return Err("Invalid XLSX ZIP: end of central directory not found.".to_string());
        }
        i -= 1;
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    bytes
        .get(offset..offset + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or_else(|| "Invalid XLSX ZIP: out-of-bounds read.".to_string())
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    bytes
        .get(offset..offset + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| "Invalid XLSX ZIP: out-of-bounds read.".to_string())
}
