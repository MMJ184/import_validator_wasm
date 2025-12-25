// crates/validator/src/lib.rs
mod schema;

use schema::{ColumnType, DateFormat, Progress, Schema};

use csv_core::{ReadRecordResult, Reader, ReaderBuilder, Terminator};
use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use std::str;
use wasm_bindgen::prelude::*;

#[repr(u8)]
#[derive(Clone, Copy, Debug)]
enum ErrorCode {
    MissingRequired = 1,
    InvalidType = 2,
    MaxLengthExceeded = 3,
    NotAllowed = 4,
    InvalidUtf8 = 5,
    MissingRequiredColumn = 6,
    ExtraColumn = 7,
}

#[derive(Clone, Copy, Debug)]
struct PackedError {
    row: u32,  // 1-based data row (header excluded), or 0 for header-level errors
    col: u32,  // usually schema column index; for ExtraColumn we pack input column index
    code: u8,  // ErrorCode as u8
}

impl PackedError {
    fn to_words(self) -> [u32; 2] {
        // word0 = row
        // word1 = (col << 8) | code
        [self.row, (self.col << 8) | (self.code as u32)]
    }
}

#[wasm_bindgen]
pub struct ValidatorEngine {
    schema: Schema,
    rdr: Reader,

    // Reused output buffers for csv-core
    out: Vec<u8>,
    ends: Vec<usize>,

    // Header state
    header_parsed: bool,

    // Mapping:
    // input_to_schema[input_col] -> Some(schema_col) or None
    input_to_schema: Vec<Option<usize>>,
    // schema_to_input[schema_col] -> Some(input_col) or None
    schema_to_input: Vec<Option<usize>>,

    // For JS: column names in schema order
    schema_col_names: Vec<String>,

    // Row counter (data rows only, 1-based)
    data_row: u32,

    // Errors collected (drained to JS)
    errors: Vec<PackedError>,
    max_errors: u32,

    // Normalized output (optional, drained to JS)
    emit_normalized: bool,
    normalized: Vec<u8>,
    normalized_buf_limit: usize,

    // Per-record reusable starts buffer: starts[i] is start offset for field i
    starts: Vec<usize>,
}

#[wasm_bindgen]
impl ValidatorEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(schema_json: &str, max_errors: u32, emit_normalized: bool) -> Result<ValidatorEngine, JsValue> {
        #[cfg(feature = "dev")]
        console_error_panic_hook::set_once();

        let schema: Schema = serde_json::from_str(schema_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid schema JSON: {e}")))?;

        let mut rb = ReaderBuilder::new();
        rb.delimiter(schema.delimiter);
        rb.terminator(Terminator::CRLF);
        let rdr = rb.build();

        let schema_col_names = schema.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>();

        // If no headers, we consider header already "parsed" and schema_to_input is identity
        let header_parsed = !schema.has_headers;
        let schema_to_input = if schema.has_headers {
            Vec::new()
        } else {
            (0..schema.columns.len()).map(Some).collect::<Vec<_>>()
        };

        Ok(ValidatorEngine {
            schema,
            rdr,
            out: vec![0u8; 64 * 1024],
            ends: vec![0usize; 256],
            header_parsed,
            input_to_schema: Vec::new(),
            schema_to_input,
            schema_col_names,
            data_row: 0,
            errors: Vec::new(),
            max_errors,
            emit_normalized,
            normalized: Vec::with_capacity(256 * 1024),
            normalized_buf_limit: 2 * 1024 * 1024, // drain frequently
            starts: Vec::with_capacity(256),
        })
    }

    /// Push a CSV chunk into the parser.
    /// Call with final_chunk=true on the last call (it will flush).
    pub fn push_chunk(&mut self, chunk: &[u8], final_chunk: bool) -> JsValue {
        let before_errs = self.errors.len() as u32;
        let before_rows = self.data_row;

        if !chunk.is_empty() {
            self.parse_slice(chunk);
        }

        if final_chunk {
            self.flush_end();
        }

        let prog = Progress {
            rows_processed: self.data_row - before_rows,
            errors_added: (self.errors.len() as u32).saturating_sub(before_errs),
            done: final_chunk,
        };

        JsValue::from_str(&serde_json::to_string(&prog).unwrap())
    }

    /// Drain up to `max` packed errors.
    /// Each error is 2 u32 words: [row, (col<<8)|code].
    pub fn take_errors_packed(&mut self, max: u32) -> Vec<u32> {
        let n = (max as usize).min(self.errors.len());
        let mut out = Vec::with_capacity(n * 2);
        for e in self.errors.drain(0..n) {
            let [w0, w1] = e.to_words();
            out.push(w0);
            out.push(w1);
        }
        out
    }

    /// Schema column names in schema order, as JSON array.
    pub fn schema_columns_json(&self) -> String {
        serde_json::to_string(&self.schema_col_names).unwrap()
    }

    /// Drain normalized CSV bytes accumulated so far (if enabled).
    pub fn take_normalized(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.normalized)
    }

    /// Stable string mapping for error code (optional helper).
    pub fn error_code_to_string(code: u8) -> String {
        match code {
            1 => "MissingRequired",
            2 => "InvalidType",
            3 => "MaxLengthExceeded",
            4 => "NotAllowed",
            5 => "InvalidUtf8",
            6 => "MissingRequiredColumn",
            7 => "ExtraColumn",
            _ => "Unknown",
        }
            .to_string()
    }
}

impl ValidatorEngine {
    fn parse_slice(&mut self, mut input: &[u8]) {
        while !input.is_empty() {
            let (res, nin, nout, nends) = self.rdr.read_record(input, &mut self.out, &mut self.ends);
            input = &input[nin..];

            match res {
                ReadRecordResult::Record => {
                    // Avoid borrowing self.out/self.ends across &mut self call:
                    let nout_local = nout;
                    let nends_local = nends;

                    let out_buf = std::mem::take(&mut self.out);
                    let ends_buf = std::mem::take(&mut self.ends);

                    self.handle_record(&out_buf[..nout_local], &ends_buf[..nends_local]);

                    self.out = out_buf;
                    self.ends = ends_buf;

                    if self.hit_error_limit() {
                        return;
                    }
                }
                ReadRecordResult::InputEmpty => {
                    // Need more bytes; just return and continue next chunk (reader keeps state)
                    return;
                }
                ReadRecordResult::OutputFull => {
                    self.out.resize(self.out.len() * 2, 0);
                }
                ReadRecordResult::OutputEndsFull => {
                    self.ends.resize(self.ends.len() * 2, 0);
                }
                ReadRecordResult::End => {
                    return;
                }
            }
        }
    }

    fn flush_end(&mut self) {
        loop {
            let (res, _nin, nout, nends) = self.rdr.read_record(&[], &mut self.out, &mut self.ends);

            match res {
                ReadRecordResult::Record => {
                    let nout_local = nout;
                    let nends_local = nends;

                    let out_buf = std::mem::take(&mut self.out);
                    let ends_buf = std::mem::take(&mut self.ends);

                    self.handle_record(&out_buf[..nout_local], &ends_buf[..nends_local]);

                    self.out = out_buf;
                    self.ends = ends_buf;

                    if self.hit_error_limit() {
                        return;
                    }
                }
                ReadRecordResult::OutputFull => {
                    self.out.resize(self.out.len() * 2, 0);
                }
                ReadRecordResult::OutputEndsFull => {
                    self.ends.resize(self.ends.len() * 2, 0);
                }
                ReadRecordResult::InputEmpty => continue,
                ReadRecordResult::End => break,
            }
        }
    }

    fn handle_record(&mut self, record: &[u8], ends: &[usize]) {
        if self.schema.has_headers && !self.header_parsed {
            self.parse_header(record, ends);
            self.header_parsed = true;
            return;
        }

        // Data row
        self.data_row = self.data_row.saturating_add(1);

        self.starts.clear();
        self.starts.reserve(ends.len());

        let mut start = 0usize;

        for (input_col, &end) in ends.iter().enumerate() {
            self.starts.push(start);
            let field = &record[start..end];
            start = end;

            let schema_idx_opt = if self.schema.has_headers {
                self.input_to_schema.get(input_col).copied().flatten()
            } else {
                if input_col < self.schema.columns.len() { Some(input_col) } else { None }
            };

            if let Some(schema_idx) = schema_idx_opt {
                self.validate_field(schema_idx, field);
            } else if self.schema.fail_on_extra_columns {
                // pack input column index into `col`
                self.push_err(self.data_row, input_col as u32, ErrorCode::ExtraColumn);
            }

            if self.hit_error_limit() {
                return;
            }
        }

        // Missing required fields if row shorter than schema (no headers case)
        if !self.schema.has_headers {
            let cols_len = self.schema.columns.len();
            if ends.len() < cols_len {
                for schema_idx in ends.len()..cols_len {
                    if self.schema.columns[schema_idx].required {
                        self.push_err(self.data_row, schema_idx as u32, ErrorCode::MissingRequired);
                        if self.hit_error_limit() {
                            return;
                        }
                    }
                }
            }
        }

        // Emit normalized row (optional)
        if self.emit_normalized && self.normalized.len() < self.normalized_buf_limit {
            self.write_normalized_row(record, ends);
        }
    }

    fn parse_header(&mut self, record: &[u8], ends: &[usize]) {
        let mut start = 0usize;
        let mut input_names: Vec<String> = Vec::with_capacity(ends.len());

        for (i, &end) in ends.iter().enumerate() {
            let mut field = &record[start..end];
            start = end;

            // Strip UTF-8 BOM on first header field if present
            if i == 0 && field.starts_with(&[0xEF, 0xBB, 0xBF]) {
                field = &field[3..];
            }

            let name = match str::from_utf8(trim_ascii(field)) {
                Ok(s) => s.to_string(),
                Err(_) => {
                    self.push_err(0, 0, ErrorCode::InvalidUtf8);
                    continue;
                }
            };
            input_names.push(name);
        }

        // Build mappings
        self.input_to_schema = vec![None; input_names.len()];
        self.schema_to_input = vec![None; self.schema.columns.len()];

        for (input_i, nm) in input_names.iter().enumerate() {
            if let Some(schema_idx) = self.schema.columns.iter().position(|c| c.name == *nm) {
                self.input_to_schema[input_i] = Some(schema_idx);
                self.schema_to_input[schema_idx] = Some(input_i);
            }
        }

        // Ensure required columns exist (two-phase to avoid borrow issues)
        let mut missing: Vec<usize> = Vec::new();
        for (schema_idx, col) in self.schema.columns.iter().enumerate() {
            if col.required {
                let exists = input_names.iter().any(|n| n == &col.name);
                if !exists {
                    missing.push(schema_idx);
                }
            }
        }
        for schema_idx in missing {
            self.push_err(0, schema_idx as u32, ErrorCode::MissingRequiredColumn);
        }
    }

    fn validate_field(&mut self, schema_idx: usize, raw: &[u8]) {
        let trimmed = trim_ascii(raw);

        let required = self.schema.columns[schema_idx].required;
        if required && trimmed.is_empty() {
            self.push_err(self.data_row, schema_idx as u32, ErrorCode::MissingRequired);
            return;
        }

        let max_len = self.schema.columns[schema_idx].max_len;
        if let Some(max_len) = max_len {
            if trimmed.len() > max_len {
                self.push_err(self.data_row, schema_idx as u32, ErrorCode::MaxLengthExceeded);
                return;
            }
        }

        let s = match str::from_utf8(trimmed) {
            Ok(v) => v,
            Err(_) => {
                self.push_err(self.data_row, schema_idx as u32, ErrorCode::InvalidUtf8);
                return;
            }
        };

        // Allowed values check (scoped borrow)
        let not_allowed = {
            let allowed = &self.schema.columns[schema_idx].allowed;
            !allowed.is_empty() && !allowed.iter().any(|a| a == s)
        };
        if not_allowed {
            self.push_err(self.data_row, schema_idx as u32, ErrorCode::NotAllowed);
            return;
        }

        let col_type = self.schema.columns[schema_idx].col_type;
        match col_type {
            ColumnType::String => {}
            ColumnType::Int => {
                if !is_valid_int(s) {
                    self.push_err(self.data_row, schema_idx as u32, ErrorCode::InvalidType);
                }
            }
            ColumnType::Decimal => {
                let precision = self.schema.columns[schema_idx].precision.unwrap_or(2);
                if !is_valid_decimal(s, precision) {
                    self.push_err(self.data_row, schema_idx as u32, ErrorCode::InvalidType);
                }
            }
            ColumnType::Date => {
                let fmt = self.schema.columns[schema_idx].date_format.unwrap_or(DateFormat::YmdDash);
                if !is_valid_date(s, fmt) {
                    self.push_err(self.data_row, schema_idx as u32, ErrorCode::InvalidType);
                }
            }
        }
    }

    fn write_normalized_row(&mut self, record: &[u8], ends: &[usize]) {
        let cols_len = self.schema.columns.len();

        for schema_i in 0..cols_len {
            let col = self.schema.columns[schema_i].clone();

            let input_i_opt = if self.schema.has_headers {
                self.schema_to_input.get(schema_i).copied().flatten()
            } else {
                Some(schema_i)
            };

            let field_bytes: &[u8] = if let Some(input_i) = input_i_opt {
                if input_i < ends.len() && input_i < self.starts.len() {
                    &record[self.starts[input_i]..ends[input_i]]
                } else {
                    b""
                }
            } else {
                b""
            };

            let trimmed = trim_ascii(field_bytes);
            let normalized = self.normalize_for_output(&col, trimmed);

            self.write_csv_field(&normalized);

            if schema_i + 1 < cols_len {
                self.normalized.push(self.schema.delimiter);
            } else {
                self.normalized.push(b'\n');
            }

            if self.normalized.len() >= self.normalized_buf_limit {
                break;
            }
        }
    }

    fn normalize_for_output(&self, col: &schema::ColumnSpec, trimmed: &[u8]) -> Vec<u8> {
        let s = match str::from_utf8(trimmed) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        match col.col_type {
            ColumnType::String => s.as_bytes().to_vec(),
            ColumnType::Int => s.as_bytes().to_vec(),
            ColumnType::Decimal => {
                let precision = col.precision.unwrap_or(2);
                normalize_decimal(s, precision).unwrap_or_default().into_bytes()
            }
            ColumnType::Date => {
                let fmt = col.date_format.unwrap_or(DateFormat::YmdDash);
                normalize_date(s, fmt).unwrap_or_default().into_bytes()
            }
        }
    }

    fn write_csv_field(&mut self, bytes: &[u8]) {
        let needs_quote = bytes.iter().any(|&b| {
            b == self.schema.delimiter || b == b'"' || b == b'\n' || b == b'\r'
        });

        if !needs_quote {
            self.normalized.extend_from_slice(bytes);
            return;
        }

        self.normalized.push(b'"');
        for &b in bytes {
            if b == b'"' {
                self.normalized.extend_from_slice(b"\"\"");
            } else {
                self.normalized.push(b);
            }
        }
        self.normalized.push(b'"');
    }

    fn push_err(&mut self, row: u32, col: u32, code: ErrorCode) {
        if (self.errors.len() as u32) >= self.max_errors {
            return;
        }
        self.errors.push(PackedError {
            row,
            col,
            code: code as u8,
        });
    }

    fn hit_error_limit(&self) -> bool {
        (self.errors.len() as u32) >= self.max_errors
    }
}

fn trim_ascii(mut b: &[u8]) -> &[u8] {
    while let Some((&first, rest)) = b.split_first() {
        if first.is_ascii_whitespace() {
            b = rest;
        } else {
            break;
        }
    }
    while let Some((&last, rest)) = b.split_last() {
        if last.is_ascii_whitespace() {
            b = rest;
        } else {
            break;
        }
    }
    b
}

fn is_valid_int(s: &str) -> bool {
    let bs = s.as_bytes();
    if bs.is_empty() {
        return false;
    }
    let mut i = 0usize;
    if bs[0] == b'+' || bs[0] == b'-' {
        i = 1;
    }
    if i >= bs.len() {
        return false;
    }
    bs[i..].iter().all(|c| c.is_ascii_digit())
}

fn is_valid_decimal(s: &str, precision: u32) -> bool {
    if s.contains(',') {
        return false;
    }
    let d = match Decimal::from_str_exact(s) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let rounded = d.round_dp_with_strategy(precision, RoundingStrategy::MidpointAwayFromZero);
    let mut fixed = rounded;
    fixed.rescale(precision);
    true
}

fn normalize_decimal(s: &str, precision: u32) -> Option<String> {
    if s.contains(',') {
        return None;
    }
    let d = Decimal::from_str_exact(s).ok()?;
    let rounded = d.round_dp_with_strategy(precision, RoundingStrategy::MidpointAwayFromZero);
    let mut fixed = rounded;
    fixed.rescale(precision);
    Some(fixed.to_string())
}

fn is_valid_date(s: &str, fmt: DateFormat) -> bool {
    let parsed = match fmt {
        DateFormat::YmdDash => parse_3_u32(s, b'-'),
        DateFormat::DmySlash | DateFormat::MdySlash => parse_3_u32(s, b'/'),
    };

    let (p1, p2, p3) = match parsed {
        Some(v) => v,
        None => return false,
    };

    let (y, m, d) = match fmt {
        DateFormat::YmdDash => (p1, p2, p3),
        DateFormat::DmySlash => (p3, p2, p1),
        DateFormat::MdySlash => (p3, p1, p2),
    };

    if m < 1 || m > 12 || d < 1 || d > 31 {
        return false;
    }

    time::Date::from_calendar_date(
        y as i32,
        match time::Month::try_from(m as u8) {
            Ok(mm) => mm,
            Err(_) => return false,
        },
        d as u8,
    )
        .is_ok()
}

fn normalize_date(s: &str, fmt: DateFormat) -> Option<String> {
    let (p1, p2, p3) = match fmt {
        DateFormat::YmdDash => parse_3_u32(s, b'-')?,
        DateFormat::DmySlash | DateFormat::MdySlash => parse_3_u32(s, b'/')?,
    };

    let (y, m, d) = match fmt {
        DateFormat::YmdDash => (p1, p2, p3),
        DateFormat::DmySlash => (p3, p2, p1),
        DateFormat::MdySlash => (p3, p1, p2),
    };

    if m < 1 || m > 12 || d < 1 || d > 31 {
        return None;
    }

    let date = time::Date::from_calendar_date(
        y as i32,
        time::Month::try_from(m as u8).ok()?,
        d as u8,
    )
        .ok()?;

    Some(format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    ))
}

fn parse_3_u32(s: &str, sep: u8) -> Option<(u32, u32, u32)> {
    let bs = s.as_bytes();
    let mut parts = [0u32; 3];
    let mut pi = 0usize;

    let mut acc: u32 = 0;
    let mut seen_digit = false;

    for &b in bs {
        if b == sep {
            if !seen_digit || pi >= 3 {
                return None;
            }
            parts[pi] = acc;
            pi += 1;
            acc = 0;
            seen_digit = false;
            continue;
        }

        if !b.is_ascii_digit() {
            return None;
        }
        seen_digit = true;
        acc = acc.saturating_mul(10).saturating_add((b - b'0') as u32);
    }

    if !seen_digit || pi != 2 {
        return None;
    }
    parts[2] = acc;

    Some((parts[0], parts[1], parts[2]))
}
