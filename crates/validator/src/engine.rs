//! Streaming validation core.
//!
//! `ValidatorCore` is plain Rust — no wasm-bindgen, no C types — and is
//! wrapped by three thin adapters: `wasm_api` (browser/Node WASM), `ffi`
//! (C ABI for Python/C#/Go), and `api` (public Rust API).
//!
//! Input modes: CSV bytes via [`ValidatorCore::push_chunk`], or XLSX via
//! [`ValidatorCore::push_shared_strings_chunk`] +
//! [`ValidatorCore::push_sheet_chunk`] (decompressed worksheet XML). A single
//! engine instance validates exactly one stream; modes cannot be mixed.

use crate::counter::RowCounterCore;
use crate::errors::{ColKind, ErrorCode, PackedError};
use crate::fingerprint::{fingerprint128, FpBuildHasher};
use crate::modifiers::{apply_modifiers, is_identity_modifiers, RegexReplaceRule};
use crate::schema::{ColumnType, DateFormat, Progress, Schema};
use crate::typecheck::{
    is_valid_double, is_valid_email, is_valid_float, is_valid_int, is_valid_number, trim_ascii,
    validate_normalize_date, validate_normalize_decimal,
};
use crate::xlsx::scanner::SheetScanner;
use crate::xlsx::shared::{SharedStrings, SharedStringsBuilder};

use csv_core::{ReadRecordResult, Reader, ReaderBuilder, Terminator};
use rustc_hash::{FxBuildHasher, FxHashMap};
use std::borrow::Cow;
use std::collections::{HashSet, VecDeque};
use std::str;

#[cfg(feature = "pattern")]
use regex::Regex;

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputMode {
    Undecided,
    Csv,
    Xlsx,
}

pub struct ValidatorCore {
    schema: Schema,
    rdr: Reader,

    // Reused output buffers for csv-core
    out: Vec<u8>,
    ends: Vec<usize>,
    // Bytes/field-ends already written into out/ends for a record that is
    // still incomplete (spans chunk boundaries). csv-core resumes mid-record;
    // we must append after these offsets, not restart at 0, or every row that
    // straddles a chunk boundary gets corrupted.
    partial_out: usize,
    partial_ends: usize,

    // Header state
    header_parsed: bool,

    // Mapping:
    // input_to_schema[input_col] -> Some(schema_col) or None
    input_to_schema: Vec<Option<usize>>,
    // schema_to_input[schema_col] -> Some(input_col) or None
    schema_to_input: Vec<Option<usize>>,

    // Column names in schema order (for hosts/UIs)
    schema_col_names: Vec<String>,
    // Fast header mapping: schema column name -> schema index
    schema_name_to_index: FxHashMap<String, usize>,
    // Lowercased variant, present only when schema.caseInsensitiveHeaders=true
    schema_name_to_index_ci: Option<FxHashMap<String, usize>>,

    // Input (CSV/XLSX) header names in input order (only when has_headers=true)
    input_header_names: Vec<String>,

    // Row counter (data rows only, 1-based)
    data_row: u32,

    // Errors collected (drained by the host)
    errors: VecDeque<PackedError>,
    max_errors: u32,
    // Errors found while the queue was full. Validation is never skipped, so
    // this is an exact count of what was dropped, not an estimate.
    errors_suppressed: u64,

    // Normalized output (optional, drained by the host)
    emit_normalized: bool,
    normalized: Vec<u8>,
    // Upper bound on the capacity kept across drains. Not a cap on content:
    // one chunk may produce more than this, and no row is ever dropped to fit.
    normalized_keep_capacity: usize,

    // Per-record reusable starts buffer: starts[i] is start offset for field i
    starts: Vec<usize>,

    // Optional allowed-value set per schema column (O(1) membership checks)
    allowed_sets: Vec<Option<HashSet<String, FxBuildHasher>>>,

    // Optional uniqueness set per schema column (column.unique=true).
    // Stores 128-bit fingerprints, not values — see crate::fingerprint.
    unique_sets: Vec<Option<HashSet<u128, FpBuildHasher>>>,

    // Composite uniqueness groups (row-level key across multiple columns).
    unique_group_indices: Vec<Vec<usize>>,
    unique_group_sets: Vec<HashSet<u128, FpBuildHasher>>,

    // Precompiled regex patterns by schema column index (pattern build only)
    #[cfg(feature = "pattern")]
    patterns: Vec<Option<Regex>>,

    #[cfg(feature = "pattern")]
    regex_replace_rules: Vec<Option<RegexReplaceRule>>,

    // Canonical values for the current row, kept ONLY for columns where
    // col_needs_value[i] is true (normalized output or composite-unique
    // membership). Everything else validates borrow-only with zero
    // allocations. Indexed by schema column.
    row_values: Vec<Option<String>>,
    // col_needs_value[i]: emit_normalized || column participates in a
    // uniqueGroup. (Plain `unique` fingerprints immediately; no storage.)
    col_needs_value: Vec<bool>,
    // True when any column needs storage — skips per-row clearing entirely
    // for the common validate-only configuration.
    any_needs_value: bool,

    // Precomputed lowercase null-token values per schema column.
    null_values_lower: Vec<Vec<String>>,

    // Scratch buffer for composite-uniqueness keys.
    composite_key_buf: String,

    // Precomputed flag: apply_modifiers is a no-op (identity) for column i.
    modifier_is_identity: Vec<bool>,

    // Input routing: CSV push vs XLSX push. One stream per engine.
    input_mode: InputMode,
    sheet_scanner: Option<SheetScanner>,
    shared_builder: Option<SharedStringsBuilder>,
    pub(crate) shared_strings: SharedStrings,
}

impl ValidatorCore {
    pub fn new(
        schema_json: &str,
        max_errors: u32,
        emit_normalized: bool,
    ) -> Result<ValidatorCore, String> {
        let schema: Schema =
            serde_json::from_str(schema_json).map_err(|e| format!("Invalid schema JSON: {e}"))?;

        #[cfg(feature = "pattern")]
        let mut patterns = Vec::with_capacity(schema.columns.len());
        #[cfg(feature = "pattern")]
        let mut regex_replace_rules = Vec::with_capacity(schema.columns.len());
        for (i, c) in schema.columns.iter().enumerate() {
            if let Some(p) = c.pattern.as_ref() {
                if p.len() > 256 {
                    return Err(format!(
                        "Pattern too long in schema column {} ({}). Max 256 chars.",
                        i, c.name
                    ));
                }
                #[cfg(feature = "pattern")]
                {
                    let re = Regex::new(p).map_err(|e| {
                        format!("Invalid regex in schema column {} ({}): {e}", i, c.name)
                    })?;
                    patterns.push(Some(re));
                }
                #[cfg(not(feature = "pattern"))]
                {
                    return Err(format!(
                        "Pattern validation requested in column {} ({}), but this build disables pattern feature for maximum performance.",
                        i, c.name
                    ));
                }
            } else {
                #[cfg(feature = "pattern")]
                patterns.push(None);
            }

            if let Some(replace_pattern) = c.modifiers.regex_replace_pattern.as_ref() {
                #[cfg(feature = "pattern")]
                {
                    let re = Regex::new(replace_pattern).map_err(|e| {
                        format!(
                            "Invalid regexReplacePattern in schema column {} ({}): {e}",
                            i, c.name
                        )
                    })?;
                    let replacement = c.modifiers.regex_replace_with.clone().unwrap_or_default();
                    regex_replace_rules.push(Some((re, replacement)));
                }
                #[cfg(not(feature = "pattern"))]
                {
                    let _ = replace_pattern;
                    return Err(format!(
                        "regexReplacePattern requested in column {} ({}), but this build disables pattern feature.",
                        i, c.name
                    ));
                }
            } else {
                #[cfg(feature = "pattern")]
                regex_replace_rules.push(None);
            }
        }

        let mut rb = ReaderBuilder::new();
        rb.delimiter(schema.delimiter);
        rb.terminator(Terminator::Any(b'\n'));
        let rdr = rb.build();

        let schema_col_names = schema
            .columns
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>();
        let schema_name_to_index = schema
            .columns
            .iter()
            .enumerate()
            .map(|(i, c)| (c.name.clone(), i))
            .collect::<FxHashMap<_, _>>();
        let allowed_sets = schema
            .columns
            .iter()
            .map(|c| {
                if c.allowed.is_empty() {
                    None
                } else {
                    Some(
                        c.allowed
                            .iter()
                            .cloned()
                            .collect::<HashSet<_, FxBuildHasher>>(),
                    )
                }
            })
            .collect::<Vec<_>>();
        let schema_name_to_index_ci = if schema.case_insensitive_headers {
            let mut map = FxHashMap::with_capacity_and_hasher(schema.columns.len(), FxBuildHasher);
            for (i, c) in schema.columns.iter().enumerate() {
                if map.insert(c.name.to_lowercase(), i).is_some() {
                    return Err(format!(
                        "caseInsensitiveHeaders=true, but schema column names collide ignoring case: \"{}\"",
                        c.name
                    ));
                }
            }
            Some(map)
        } else {
            None
        };
        let unique_sets = schema
            .columns
            .iter()
            .map(|c| {
                if c.unique {
                    Some(HashSet::<u128, FpBuildHasher>::default())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let mut unique_group_indices = Vec::with_capacity(schema.unique_groups.len());
        for (gi, group) in schema.unique_groups.iter().enumerate() {
            if group.columns.is_empty() {
                return Err(format!(
                    "uniqueGroups[{gi}] must include at least one column."
                ));
            }

            let mut resolved = Vec::with_capacity(group.columns.len());
            for col_name in &group.columns {
                let Some(idx) = schema_name_to_index.get(col_name).copied() else {
                    return Err(format!(
                        "uniqueGroups[{gi}] references unknown column \"{col_name}\""
                    ));
                };
                resolved.push(idx);
            }

            unique_group_indices.push(resolved);
        }
        let unique_group_sets = (0..unique_group_indices.len())
            .map(|_| HashSet::<u128, FpBuildHasher>::default())
            .collect::<Vec<_>>();

        // Which columns must keep their canonical value per row?
        let mut col_needs_value = vec![emit_normalized; schema.columns.len()];
        for group in &unique_group_indices {
            for &idx in group {
                col_needs_value[idx] = true;
            }
        }
        let any_needs_value = col_needs_value.iter().any(|&b| b);

        let row_values = vec![None::<String>; schema.columns.len()];

        // Precompute lowercased null token values per column.
        let null_values_lower = schema
            .columns
            .iter()
            .map(|c| {
                if c.modifiers.null_values_case_insensitive {
                    c.modifiers
                        .null_values
                        .iter()
                        .map(|v| v.to_lowercase())
                        .collect()
                } else {
                    Vec::new()
                }
            })
            .collect::<Vec<Vec<String>>>();

        // Precompute identity flag to skip apply_modifiers for plain columns.
        let modifier_is_identity = schema
            .columns
            .iter()
            .map(|c| is_identity_modifiers(&c.modifiers))
            .collect::<Vec<_>>();

        // If no headers, header is considered "parsed"; schema_to_input is identity
        let header_parsed = !schema.has_headers;
        let schema_to_input = if schema.has_headers {
            Vec::new()
        } else {
            (0..schema.columns.len()).map(Some).collect::<Vec<_>>()
        };

        Ok(ValidatorCore {
            schema,
            rdr,
            out: vec![0u8; 64 * 1024],
            ends: vec![0usize; 256],
            partial_out: 0,
            partial_ends: 0,
            header_parsed,
            input_to_schema: Vec::new(),
            schema_to_input,
            schema_col_names,
            schema_name_to_index,
            schema_name_to_index_ci,
            input_header_names: Vec::new(),
            data_row: 0,
            errors: VecDeque::new(),
            max_errors,
            errors_suppressed: 0,
            emit_normalized,
            // Only pre-allocate normalized buffer when normalization is on.
            normalized: if emit_normalized {
                Vec::with_capacity(256 * 1024)
            } else {
                Vec::new()
            },
            normalized_keep_capacity: 2 * 1024 * 1024,
            starts: Vec::with_capacity(256),
            allowed_sets,
            unique_sets,
            unique_group_indices,
            unique_group_sets,
            #[cfg(feature = "pattern")]
            patterns,
            #[cfg(feature = "pattern")]
            regex_replace_rules,
            row_values,
            col_needs_value,
            any_needs_value,
            null_values_lower,
            composite_key_buf: String::new(),
            modifier_is_identity,
            input_mode: InputMode::Undecided,
            sheet_scanner: None,
            shared_builder: None,
            shared_strings: SharedStrings::default(),
        })
    }

    // ── Input: CSV ──────────────────────────────────────────────────────────

    /// Push a CSV chunk. Call with `final_chunk=true` on the last call.
    pub fn push_chunk(&mut self, chunk: &[u8], final_chunk: bool) -> Result<Progress, String> {
        self.enter_mode(InputMode::Csv)?;

        // Count errors FOUND, not just queued: once the queue is full the
        // queue-length delta reads 0 while the file is still producing errors.
        let before_errs = self.errors_found();
        let before_rows = self.data_row;

        if !chunk.is_empty() {
            self.parse_slice(chunk);
        }

        if final_chunk {
            self.flush_end();
        }

        Ok(Progress {
            rows_processed: self.data_row - before_rows,
            errors_added: self.errors_found().saturating_sub(before_errs),
            done: final_chunk,
        })
    }

    // ── Input: XLSX (decompressed worksheet XML) ────────────────────────────

    /// Push a chunk of decompressed `xl/sharedStrings.xml`. Must complete
    /// (final_chunk=true) before the first `push_sheet_chunk` call.
    pub fn push_shared_strings_chunk(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
    ) -> Result<(), String> {
        self.enter_mode(InputMode::Xlsx)?;
        if self.sheet_scanner.is_some() {
            return Err("shared strings must be pushed before sheet data".to_string());
        }
        let builder = self
            .shared_builder
            .get_or_insert_with(SharedStringsBuilder::default);
        builder.push(chunk)?;
        if final_chunk {
            let builder = self.shared_builder.take().expect("builder present");
            self.shared_strings = builder.finish()?;
        }
        Ok(())
    }

    /// Push a chunk of decompressed worksheet XML (`xl/worksheets/sheetN.xml`).
    /// Rows feed the same validation pipeline as CSV — no CSV round-trip.
    pub fn push_sheet_chunk(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
    ) -> Result<Progress, String> {
        self.enter_mode(InputMode::Xlsx)?;
        if self.shared_builder.is_some() {
            return Err(
                "finish shared strings (final_chunk=true) before pushing sheet data".to_string(),
            );
        }

        // Count errors FOUND, not just queued: once the queue is full the
        // queue-length delta reads 0 while the file is still producing errors.
        let before_errs = self.errors_found();
        let before_rows = self.data_row;

        let mut scanner = self.sheet_scanner.take().unwrap_or_default();
        let result = scanner.push(chunk, final_chunk, self);
        self.sheet_scanner = Some(scanner);
        result?;

        Ok(Progress {
            rows_processed: self.data_row - before_rows,
            errors_added: self.errors_found().saturating_sub(before_errs),
            done: final_chunk,
        })
    }

    fn enter_mode(&mut self, mode: InputMode) -> Result<(), String> {
        if self.input_mode == InputMode::Undecided {
            self.input_mode = mode;
            return Ok(());
        }
        if self.input_mode != mode {
            return Err(
                "engine already consumed a different input format; create a new engine per file"
                    .to_string(),
            );
        }
        Ok(())
    }

    // ── Output draining ─────────────────────────────────────────────────────

    /// Drain up to `max` packed errors.
    /// Each error is 2 u32 words: `[row, (kind<<31) | (col<<8) | code]`.
    pub fn take_errors_packed(&mut self, max: u32) -> Vec<u32> {
        let n = (max as usize).min(self.errors.len());
        let mut out = Vec::with_capacity(n * 2);
        for _ in 0..n {
            if let Some(e) = self.errors.pop_front() {
                let [w0, w1] = e.to_words();
                out.push(w0);
                out.push(w1);
            }
        }
        out
    }

    /// Discard up to `max` queued errors without materializing them.
    pub fn drop_errors(&mut self, max: u32) -> u32 {
        let n = (max as usize).min(self.errors.len());
        self.errors.drain(..n);
        n as u32
    }

    /// Number of errors currently queued without draining them.
    pub fn errors_count(&self) -> u32 {
        self.errors.len() as u32
    }

    /// Total data rows processed so far (header excluded).
    pub fn rows_processed(&self) -> u32 {
        self.data_row
    }

    /// Schema column names in schema order, as JSON array.
    pub fn schema_columns_json(&self) -> String {
        serde_json::to_string(&self.schema_col_names).unwrap()
    }

    /// Input header column names in input order, as JSON array.
    /// Empty array if has_headers=false or header not parsed yet.
    pub fn input_columns_json(&self) -> String {
        serde_json::to_string(&self.input_header_names).unwrap()
    }

    pub fn schema_columns(&self) -> &[String] {
        &self.schema_col_names
    }

    pub fn input_columns(&self) -> &[String] {
        &self.input_header_names
    }

    /// Drain normalized CSV bytes accumulated so far (if enabled).
    pub fn take_normalized(&mut self) -> Vec<u8> {
        if self.normalized.is_empty() {
            return Vec::new();
        }
        // Hand the filled buffer to the caller but keep a right-sized empty one
        // so the next chunk does not re-grow from zero capacity.
        let keep = self
            .normalized
            .capacity()
            .min(self.normalized_keep_capacity);
        std::mem::replace(&mut self.normalized, Vec::with_capacity(keep))
    }

    /// Stable string mapping for error code.
    pub fn error_code_to_string(code: u8) -> &'static str {
        match code {
            1 => "MissingRequired",
            2 => "InvalidType",
            3 => "MaxLengthExceeded",
            4 => "NotAllowed",
            5 => "InvalidUtf8",
            6 => "MissingRequiredColumn",
            7 => "ExtraColumn",
            8 => "MinLengthNotMet",
            9 => "InvalidEmail",
            10 => "PatternMismatch",
            11 => "PrecisionExceeded",
            12 => "ColumnCountMismatch",
            13 => "DuplicateValue",
            14 => "DuplicateCombination",
            _ => "Unknown",
        }
    }

    pub fn delimiter(&self) -> u8 {
        self.schema.delimiter
    }

    /// A quote-aware row counter matching this engine's delimiter.
    pub fn row_counter(&self) -> RowCounterCore {
        RowCounterCore::new(self.schema.delimiter)
    }

    // ── CSV parsing internals ───────────────────────────────────────────────

    pub(crate) fn parse_slice(&mut self, mut input: &[u8]) {
        loop {
            // Resume after any partial record from previous chunks: csv-core
            // keeps parser state, so we must keep appending to out/ends.
            let (res, nin, nout, nends) = self.rdr.read_record(
                input,
                &mut self.out[self.partial_out..],
                &mut self.ends[self.partial_ends..],
            );
            input = &input[nin..];
            self.partial_out += nout;
            self.partial_ends += nends;

            match res {
                ReadRecordResult::Record => {
                    let out_len = self.partial_out;
                    let ends_len = self.partial_ends;
                    self.partial_out = 0;
                    self.partial_ends = 0;

                    // Avoid borrowing self.out/self.ends across &mut self call:
                    let out_buf = std::mem::take(&mut self.out);
                    let ends_buf = std::mem::take(&mut self.ends);

                    self.handle_record(&out_buf[..out_len], &ends_buf[..ends_len]);

                    self.out = out_buf;
                    self.ends = ends_buf;

                    if input.is_empty() {
                        return;
                    }
                }
                ReadRecordResult::InputEmpty => {
                    // Need more bytes; partial_out/partial_ends carry the
                    // incomplete record into the next chunk.
                    return;
                }
                ReadRecordResult::OutputFull => {
                    let n = self.out.len().max(64) * 2;
                    self.out.resize(n, 0);
                }
                ReadRecordResult::OutputEndsFull => {
                    let n = self.ends.len().max(16) * 2;
                    self.ends.resize(n, 0);
                }
                ReadRecordResult::End => return,
            }
        }
    }

    pub(crate) fn flush_end(&mut self) {
        loop {
            let (res, _nin, nout, nends) = self.rdr.read_record(
                &[],
                &mut self.out[self.partial_out..],
                &mut self.ends[self.partial_ends..],
            );
            self.partial_out += nout;
            self.partial_ends += nends;

            match res {
                ReadRecordResult::Record => {
                    let out_len = self.partial_out;
                    let ends_len = self.partial_ends;
                    self.partial_out = 0;
                    self.partial_ends = 0;

                    let out_buf = std::mem::take(&mut self.out);
                    let ends_buf = std::mem::take(&mut self.ends);

                    self.handle_record(&out_buf[..out_len], &ends_buf[..ends_len]);

                    self.out = out_buf;
                    self.ends = ends_buf;
                }
                ReadRecordResult::OutputFull => {
                    let n = self.out.len().max(64) * 2;
                    self.out.resize(n, 0);
                }
                ReadRecordResult::OutputEndsFull => {
                    let n = self.ends.len().max(16) * 2;
                    self.ends.resize(n, 0);
                }
                ReadRecordResult::InputEmpty => continue,
                ReadRecordResult::End => break,
            }
        }
    }

    // ── Record validation (shared by CSV and XLSX inputs) ───────────────────

    /// Validate one record. `record` holds the concatenated field bytes;
    /// `ends[i]` is the exclusive end offset of field i.
    pub(crate) fn handle_record(&mut self, record: &[u8], ends: &[usize]) {
        if self.schema.has_headers && !self.header_parsed {
            self.parse_header(record, ends);
            self.header_parsed = true;
            return;
        }

        // Data row
        self.data_row = self.data_row.saturating_add(1);

        if let Some(total) = self.schema.total_columns {
            if ends.len() != total {
                self.push_err(
                    self.data_row,
                    0,
                    ErrorCode::ColumnCountMismatch,
                    ColKind::Input,
                );
            }
        }

        self.starts.clear();
        self.starts.reserve(ends.len());
        if self.any_needs_value {
            // Clear the value scratch buffer (only used when something
            // consumes canonical values — normalized output or uniqueGroups).
            self.row_values.iter_mut().for_each(|v| *v = None);
        }

        let mut start = 0usize;

        for (input_col, &end) in ends.iter().enumerate() {
            self.starts.push(start);
            let Some(field) = record.get(start..end) else {
                self.push_err(
                    self.data_row,
                    input_col as u32,
                    ErrorCode::InvalidType,
                    ColKind::Input,
                );
                return;
            };
            start = end;

            let schema_idx_opt = if self.schema.has_headers {
                self.input_to_schema.get(input_col).copied().flatten()
            } else if input_col < self.schema.columns.len() {
                Some(input_col)
            } else {
                None
            };

            if let Some(schema_idx) = schema_idx_opt {
                if let Some(canonical) = self.validate_field(schema_idx, field) {
                    if self.col_needs_value[schema_idx] && schema_idx < self.row_values.len() {
                        self.row_values[schema_idx] = Some(canonical.into_owned());
                    }
                }
            } else if self.schema.fail_on_extra_columns {
                // input column index in `col`, mark as input-kind
                self.push_err(
                    self.data_row,
                    input_col as u32,
                    ErrorCode::ExtraColumn,
                    ColKind::Input,
                );
            }
        }

        // Missing required fields if row shorter than schema (no headers case)
        if !self.schema.has_headers {
            let cols_len = self.schema.columns.len();
            if ends.len() < cols_len {
                for schema_idx in ends.len()..cols_len {
                    if self.schema.columns[schema_idx].required {
                        self.push_err(
                            self.data_row,
                            schema_idx as u32,
                            ErrorCode::MissingRequired,
                            ColKind::Schema,
                        );
                    }
                }
            }
        }

        // Use mem::take so we can pass &row_vals to check_composite_uniques
        // which needs &mut self for its HashSet inserts. No allocation: just
        // moves the Vec pointer out and back.
        if !self.unique_group_indices.is_empty() {
            let row_vals = std::mem::take(&mut self.row_values);
            self.check_composite_uniques(&row_vals);
            self.row_values = row_vals;
        }

        // Emit normalized row using already-computed canonical values. Never
        // skipped and never size-gated, so the normalized row count always
        // tracks `rows_processed`: the host drains once per chunk, and one
        // chunk may legitimately produce more bytes than the retained capacity.
        if self.emit_normalized {
            let row_vals = std::mem::take(&mut self.row_values);
            self.write_normalized_row(&row_vals);
            self.row_values = row_vals;
        }
    }

    fn parse_header(&mut self, record: &[u8], ends: &[usize]) {
        let mut start = 0usize;
        let mut input_names: Vec<String> = Vec::with_capacity(ends.len());

        for (i, &end) in ends.iter().enumerate() {
            let Some(mut field) = record.get(start..end) else {
                self.push_err(0, i as u32, ErrorCode::InvalidType, ColKind::Input);
                return;
            };
            start = end;

            // Strip UTF-8 BOM on first header field if present
            if i == 0 && field.starts_with(&[0xEF, 0xBB, 0xBF]) {
                field = &field[3..];
            }

            let name = match str::from_utf8(trim_ascii(field)) {
                Ok(s) => s.to_string(),
                Err(_) => {
                    // header-level: invalid utf8 (no useful col index, keep schema-kind)
                    self.push_err(0, 0, ErrorCode::InvalidUtf8, ColKind::Schema);
                    continue;
                }
            };
            input_names.push(name);
        }

        // Store input header names for hosts/UIs
        self.input_header_names = input_names.clone();

        if let Some(total) = self.schema.total_columns {
            if input_names.len() != total {
                self.push_err(0, 0, ErrorCode::ColumnCountMismatch, ColKind::Input);
            }
        }

        // Build mappings
        self.input_to_schema = vec![None; input_names.len()];
        self.schema_to_input = vec![None; self.schema.columns.len()];

        for (input_i, nm) in input_names.iter().enumerate() {
            let schema_idx = match &self.schema_name_to_index_ci {
                Some(ci) => ci.get(nm.to_lowercase().as_str()).copied(),
                None => self.schema_name_to_index.get(nm).copied(),
            };
            if let Some(schema_idx) = schema_idx {
                self.input_to_schema[input_i] = Some(schema_idx);
                self.schema_to_input[schema_idx] = Some(input_i);
            }
        }

        // Ensure required columns exist
        for schema_idx in 0..self.schema.columns.len() {
            let required = self.schema.columns[schema_idx].required;
            if required
                && self
                    .schema_to_input
                    .get(schema_idx)
                    .copied()
                    .flatten()
                    .is_none()
            {
                self.push_err(
                    0,
                    schema_idx as u32,
                    ErrorCode::MissingRequiredColumn,
                    ColKind::Schema,
                );
            }
        }
    }

    /// Validate a single field. Returns the canonical value as a `Cow`:
    /// borrowed straight from the record buffer on the fast path (no
    /// modifiers, value already canonical), owned only when a rewrite
    /// happened. Errors are queued internally; `None` means invalid or empty.
    fn validate_field<'a>(&mut self, schema_idx: usize, raw: &'a [u8]) -> Option<Cow<'a, str>> {
        let col = &self.schema.columns[schema_idx];
        let required = col.required;
        let nullable = col.nullable;
        let min_len = col.min_len;
        let max_len = col.max_len;
        let col_type = col.col_type;
        let precision = col.precision;
        let strict_precision = col.strict_precision;
        let date_format = col.date_format;
        let unique = col.unique;

        let prepared: Cow<'a, str> = match self.prepare_field_value(schema_idx, raw) {
            Ok(v) => v,
            Err(()) => {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::InvalidUtf8,
                    ColKind::Schema,
                );
                return None;
            }
        };

        if prepared.is_empty() {
            if required && !nullable {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::MissingRequired,
                    ColKind::Schema,
                );
            }
            return None;
        }

        if let Some(min_len) = min_len {
            if prepared.len() < min_len {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::MinLengthNotMet,
                    ColKind::Schema,
                );
                return None;
            }
        }

        if let Some(max_len) = max_len {
            if prepared.len() > max_len {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::MaxLengthExceeded,
                    ColKind::Schema,
                );
                return None;
            }
        }

        if let Some(allowed) = self.allowed_sets.get(schema_idx).and_then(|x| x.as_ref()) {
            if !allowed.contains(prepared.as_ref()) {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::NotAllowed,
                    ColKind::Schema,
                );
                return None;
            }
        }

        #[cfg(feature = "pattern")]
        if let Some(re) = self.patterns[schema_idx].as_ref() {
            if !re.is_match(prepared.as_ref()) {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::PatternMismatch,
                    ColKind::Schema,
                );
                return None;
            }
        }

        let canonical: Cow<'a, str> = match col_type {
            ColumnType::String => prepared,
            ColumnType::Int => {
                if !is_valid_int(prepared.as_ref()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared
            }
            ColumnType::Float => {
                if !is_valid_float(prepared.as_ref()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared
            }
            ColumnType::Double => {
                if !is_valid_double(prepared.as_ref()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared
            }
            ColumnType::Number => {
                if !is_valid_number(prepared.as_ref()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared
            }
            ColumnType::Decimal => {
                let precision = precision.unwrap_or(2);
                match validate_normalize_decimal(prepared.as_ref(), precision, strict_precision) {
                    Ok(None) => prepared,
                    Ok(Some(rewritten)) => Cow::Owned(rewritten),
                    Err(err_code) => {
                        self.push_err(self.data_row, schema_idx as u32, err_code, ColKind::Schema);
                        return None;
                    }
                }
            }
            ColumnType::Email => {
                if !is_valid_email(prepared.as_ref()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidEmail,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared
            }
            ColumnType::Date => {
                let fmt = date_format.unwrap_or(DateFormat::YmdDash);
                match validate_normalize_date(prepared.as_ref(), fmt) {
                    None => {
                        self.push_err(
                            self.data_row,
                            schema_idx as u32,
                            ErrorCode::InvalidType,
                            ColKind::Schema,
                        );
                        return None;
                    }
                    Some(None) => prepared,
                    Some(Some(rewritten)) => Cow::Owned(rewritten),
                }
            }
        };

        if unique {
            if let Some(unique_set) = self
                .unique_sets
                .get_mut(schema_idx)
                .and_then(|x| x.as_mut())
            {
                if !unique_set.insert(fingerprint128(canonical.as_ref())) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::DuplicateValue,
                        ColKind::Schema,
                    );
                    return None;
                }
            }
        }

        Some(canonical)
    }

    fn prepare_field_value<'a>(
        &self,
        schema_idx: usize,
        raw: &'a [u8],
    ) -> Result<Cow<'a, str>, ()> {
        let modifiers = &self.schema.columns[schema_idx].modifiers;
        let source = if modifiers.trim { trim_ascii(raw) } else { raw };
        if source.is_empty() {
            return Ok(Cow::Borrowed(""));
        }
        let input = match str::from_utf8(source) {
            Ok(v) => v,
            Err(_) => return Err(()),
        };
        if self.modifier_is_identity[schema_idx] {
            return Ok(Cow::Borrowed(input));
        }

        #[cfg(feature = "pattern")]
        let rule: Option<&RegexReplaceRule> = self
            .regex_replace_rules
            .get(schema_idx)
            .and_then(|r| r.as_ref());
        #[cfg(not(feature = "pattern"))]
        let rule: Option<&RegexReplaceRule> = None;

        Ok(Cow::Owned(apply_modifiers(
            input,
            modifiers,
            &self.null_values_lower[schema_idx],
            rule,
        )))
    }

    fn check_composite_uniques(&mut self, row_values: &[Option<String>]) {
        if self.unique_group_indices.is_empty() {
            return;
        }

        for gi in 0..self.unique_group_indices.len() {
            let indices = &self.unique_group_indices[gi];
            let col_for_error = indices[0];

            self.composite_key_buf.clear();
            let mut valid = true;

            for (idx_pos, schema_idx) in indices.iter().copied().enumerate() {
                let Some(value) = row_values.get(schema_idx).and_then(|v| v.as_ref()) else {
                    valid = false;
                    break;
                };
                if value.is_empty() {
                    valid = false;
                    break;
                }
                if idx_pos > 0 {
                    self.composite_key_buf.push('\u{1f}');
                }
                self.composite_key_buf.push_str(value);
            }

            if !valid {
                continue;
            }

            let key = fingerprint128(self.composite_key_buf.as_str());
            if !self.unique_group_sets[gi].insert(key) {
                self.push_err(
                    self.data_row,
                    col_for_error as u32,
                    ErrorCode::DuplicateCombination,
                    ColKind::Schema,
                );
                return;
            }
        }
    }

    fn write_normalized_row(&mut self, row_vals: &[Option<String>]) {
        let cols_len = self.schema.columns.len();

        for schema_i in 0..cols_len {
            let s = row_vals
                .get(schema_i)
                .and_then(|v| v.as_deref())
                .unwrap_or("");

            self.write_csv_field(s.as_bytes());

            if schema_i + 1 < cols_len {
                self.normalized.push(self.schema.delimiter);
            } else {
                self.normalized.push(b'\n');
            }
        }
    }

    fn write_csv_field(&mut self, bytes: &[u8]) {
        let delim = self.schema.delimiter;
        let needs_quote = memchr::memchr3(delim, b'"', b'\n', bytes).is_some()
            || memchr::memchr(b'\r', bytes).is_some();

        if !needs_quote {
            self.normalized.extend_from_slice(bytes);
            return;
        }

        self.normalized.push(b'"');
        let mut start = 0usize;
        for pos in memchr::memchr_iter(b'"', bytes) {
            // copy through the quote, then double it
            self.normalized.extend_from_slice(&bytes[start..=pos]);
            self.normalized.push(b'"');
            start = pos + 1;
        }
        self.normalized.extend_from_slice(&bytes[start..]);
        self.normalized.push(b'"');
    }

    pub(crate) fn push_err(&mut self, row: u32, col: u32, code: ErrorCode, kind: ColKind) {
        if (self.errors.len() as u32) >= self.max_errors {
            // Queue full: record the count only. Validation itself is never
            // skipped, so this stays an exact total of what the file contains,
            // letting hosts report "showing N of TOTAL".
            self.errors_suppressed = self.errors_suppressed.saturating_add(1);
            return;
        }
        self.errors.push_back(PackedError {
            row,
            col,
            code,
            kind,
        });
    }

    /// Errors found so far, whether or not they fit in the queue. Saturates at
    /// u32 so a `Progress` delta stays meaningful on absurd inputs.
    fn errors_found(&self) -> u32 {
        (self.errors.len() as u64)
            .saturating_add(self.errors_suppressed)
            .min(u32::MAX as u64) as u32
    }

    /// Errors found but not recorded because the queue was at `max_errors`.
    ///
    /// `max_errors` caps how many errors are *kept*; it never changes which
    /// rows are read, counted, or validated. So `errors_suppressed` plus every
    /// error drained is the exact number of problems in the file.
    pub fn errors_suppressed(&self) -> u64 {
        self.errors_suppressed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_duplicate_after_modifier_normalization() {
        let schema_json = json!({
            "hasHeaders": true,
            "columns": [
                {
                    "name": "email",
                    "type": "email",
                    "required": true,
                    "unique": true,
                    "modifiers": {
                        "trim": true,
                        "lowercase": true
                    }
                }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        let csv = b"email\n Alice@Example.com \nalice@example.com\n";
        engine.parse_slice(csv);
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert_eq!(count_code(&codes, ErrorCode::DuplicateValue as u8), 1);
    }

    #[test]
    fn normalizes_with_prefix_suffix_and_decimal_scale() {
        let schema_json = json!({
            "hasHeaders": false,
            "columns": [
                {
                    "name": "name",
                    "type": "string",
                    "modifiers": {
                        "trim": true,
                        "collapseWhitespace": true,
                        "prefix": "Ms. ",
                        "suffix": " (VIP)"
                    }
                },
                {
                    "name": "amount",
                    "type": "decimal",
                    "precision": 2,
                    "strictPrecision": false,
                    "modifiers": {
                        "decimalScale": 2
                    }
                }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, true).expect("engine init");
        engine.parse_slice(b"   Alice   Doe  ,12.345\n");
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert!(codes.is_empty());

        let normalized = String::from_utf8(engine.take_normalized()).expect("utf8 normalized");
        assert_eq!(normalized, "Ms. Alice Doe (VIP),12.35\n");
    }

    #[test]
    fn applies_ceil_before_decimal_scale() {
        let schema_json = json!({
            "hasHeaders": false,
            "columns": [
                {
                    "name": "amount",
                    "type": "decimal",
                    "precision": 2,
                    "strictPrecision": false,
                    "modifiers": {
                        "ceil": true,
                        "decimalScale": 2
                    }
                }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, true).expect("engine init");
        engine.parse_slice(b"1.01\n");
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert!(codes.is_empty());

        let normalized = String::from_utf8(engine.take_normalized()).expect("utf8 normalized");
        assert_eq!(normalized, "2.00\n");
    }

    #[test]
    fn supports_substring_replace_and_title_case_modifiers() {
        let schema_json = json!({
            "hasHeaders": false,
            "columns": [
                {
                    "name": "name",
                    "type": "string",
                    "modifiers": {
                        "trim": true,
                        "substringStart": 0,
                        "substringEnd": 10,
                        "replaceFrom": "0",
                        "replaceTo": "o",
                        "titleCase": true
                    }
                }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, true).expect("engine init");
        engine.parse_slice(b"  j0hn   d0e   \n");
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert!(codes.is_empty());

        let normalized = String::from_utf8(engine.take_normalized()).expect("utf8 normalized");
        assert_eq!(normalized, "John Doe\n");
    }

    #[test]
    fn null_tokens_are_treated_as_empty() {
        let schema_json = json!({
            "hasHeaders": false,
            "columns": [
                {
                    "name": "middleName",
                    "type": "string",
                    "required": true,
                    "nullable": false,
                    "modifiers": {
                        "nullValues": ["N/A", "NULL", "-"],
                        "nullValuesCaseInsensitive": true
                    }
                }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        engine.parse_slice(b"n/a\n");
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert_eq!(count_code(&codes, ErrorCode::MissingRequired as u8), 1);
    }

    #[test]
    fn detects_duplicate_composite_key() {
        let schema_json = json!({
            "hasHeaders": true,
            "uniqueGroups": [
                {
                    "name": "customer_email_key",
                    "columns": ["customerId", "email"]
                }
            ],
            "columns": [
                { "name": "customerId", "type": "int", "required": true },
                {
                    "name": "email",
                    "type": "email",
                    "required": true,
                    "modifiers": { "trim": true, "lowercase": true }
                }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        let csv = b"customerId,email\n1,A@EXAMPLE.COM\n1,a@example.com\n";
        engine.parse_slice(csv);
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert_eq!(count_code(&codes, ErrorCode::DuplicateCombination as u8), 1);
    }

    #[test]
    fn records_spanning_chunk_boundaries_are_not_corrupted() {
        let schema_json = json!({
            "hasHeaders": true,
            "columns": [
                { "name": "id", "type": "int", "required": true, "unique": true },
                { "name": "email", "type": "email", "required": true },
                { "name": "name", "type": "string", "required": true, "minLen": 2 }
            ]
        })
        .to_string();

        let mut csv = String::from("id,email,name\n");
        for i in 1..=200 {
            csv.push_str(&format!("{i},user{i}@example.com,\"Person {i}\"\n"));
        }

        // Every chunk size must yield identical, error-free results — records
        // routinely straddle chunk boundaries at small sizes.
        for chunk_size in [1usize, 2, 3, 7, 19, 64, 1024] {
            let mut engine = ValidatorCore::new(&schema_json, 10_000, false).expect("engine init");
            for chunk in csv.as_bytes().chunks(chunk_size) {
                engine.parse_slice(chunk);
            }
            engine.flush_end();

            let codes = take_error_codes(&mut engine);
            assert!(
                codes.is_empty(),
                "chunk_size={chunk_size}: expected no errors, got {codes:?}"
            );
            assert_eq!(engine.data_row, 200, "chunk_size={chunk_size}: row count");
        }
    }

    #[test]
    fn email_validation_rejects_common_invalid_shapes() {
        use crate::typecheck::is_valid_email;
        assert!(is_valid_email("a@b.com"));
        assert!(is_valid_email("first.last+tag@sub.example.co"));
        assert!(!is_valid_email("a b@c.com"));
        assert!(!is_valid_email("a@b@c.com"));
        assert!(!is_valid_email("a@b..com"));
        assert!(!is_valid_email("a@b."));
        assert!(!is_valid_email("@b.com"));
        assert!(!is_valid_email("a@"));
        assert!(!is_valid_email("a@nodot"));
        assert!(!is_valid_email("a\t@b.com"));
        let long = format!("{}@example.com", "x".repeat(250));
        assert!(!is_valid_email(&long));
    }

    #[test]
    fn case_insensitive_headers_match_schema_columns() {
        let schema_json = json!({
            "hasHeaders": true,
            "caseInsensitiveHeaders": true,
            "columns": [
                { "name": "email", "type": "email", "required": true }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        engine.parse_slice(b"EMAIL\na@b.com\n");
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert!(codes.is_empty(), "expected no errors, got {codes:?}");
    }

    #[test]
    fn header_matching_stays_exact_by_default() {
        let schema_json = json!({
            "hasHeaders": true,
            "columns": [
                { "name": "email", "type": "email", "required": true }
            ]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        engine.parse_slice(b"EMAIL\na@b.com\n");
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert_eq!(
            count_code(&codes, ErrorCode::MissingRequiredColumn as u8),
            1
        );
    }

    #[test]
    fn case_colliding_columns_rejected_with_ci_headers() {
        let schema_json = json!({
            "hasHeaders": true,
            "caseInsensitiveHeaders": true,
            "columns": [
                { "name": "email", "type": "email" },
                { "name": "Email", "type": "string" }
            ]
        })
        .to_string();

        assert!(ValidatorCore::new(&schema_json, 1000, false).is_err());
    }

    #[test]
    fn csv_and_xlsx_input_modes_cannot_mix() {
        let schema_json = json!({
            "hasHeaders": false,
            "columns": [{ "name": "a", "type": "string" }]
        })
        .to_string();

        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        engine.push_chunk(b"x\n", false).expect("csv push");
        assert!(engine.push_sheet_chunk(b"<row/>", false).is_err());
    }

    #[test]
    fn validate_only_configuration_skips_value_storage() {
        // No normalization, no unique groups → any_needs_value is false and
        // results must be identical to the storing configuration.
        let schema_json = json!({
            "hasHeaders": true,
            "columns": [
                { "name": "id", "type": "int", "required": true, "unique": true },
                { "name": "amount", "type": "decimal", "precision": 2 }
            ]
        })
        .to_string();

        let csv = b"id,amount\n1,10.00\n2,3.5\n2,bad\n";
        let mut engine = ValidatorCore::new(&schema_json, 1000, false).expect("engine init");
        engine.parse_slice(csv);
        engine.flush_end();
        assert!(!engine.any_needs_value);

        let codes = take_error_codes(&mut engine);
        // row 3: duplicate id=2 and invalid decimal
        assert_eq!(count_code(&codes, ErrorCode::DuplicateValue as u8), 1);
        assert_eq!(count_code(&codes, ErrorCode::InvalidType as u8), 1);
        assert_eq!(engine.rows_processed(), 3);
    }

    #[test]
    fn normalized_output_keeps_every_row_intact_past_buffer_limit() {
        // Hosts drain normalized bytes once per chunk, so a single chunk can
        // legitimately produce more normalized output than the in-engine
        // buffer's soft limit. No row may be dropped or truncated.
        let schema_json = json!({
            "hasHeaders": false,
            "columns": [
                { "name": "id", "type": "int" },
                { "name": "note", "type": "string" }
            ]
        })
        .to_string();

        // Width 41 is one that made the old code stop mid-row rather than
        // between rows, so this fixture covers both the dropped-row and the
        // truncated-row halves of the bug.
        let rows = 60_000usize;
        let filler = "x".repeat(41);
        let mut input = String::new();
        for i in 0..rows {
            input.push_str(&format!("{i},{filler}\n"));
        }
        assert!(
            input.len() > 2 * 1024 * 1024,
            "fixture must exceed the limit"
        );

        let mut engine = ValidatorCore::new(&schema_json, 1000, true).expect("engine init");
        engine.parse_slice(input.as_bytes());
        engine.flush_end();

        let normalized = String::from_utf8(engine.take_normalized()).expect("utf8 normalized");
        assert!(
            normalized.ends_with('\n'),
            "normalized output must not end mid-row"
        );

        let lines: Vec<&str> = normalized.lines().collect();
        assert_eq!(lines.len(), rows, "every row must reach normalized output");
        for (i, line) in lines.iter().enumerate() {
            assert_eq!(*line, format!("{i},{filler}"), "row {i} must be complete");
        }
    }

    #[test]
    fn error_limit_caps_recording_without_skipping_rows() {
        // max_errors bounds what is KEPT. Every row must still be read,
        // counted and validated, whatever the chunking — otherwise
        // rows_processed silently under-reports on error-dense files.
        let schema_json = json!({
            "hasHeaders": true,
            "columns": [
                { "name": "id", "type": "int" },
                { "name": "email", "type": "email" }
            ]
        })
        .to_string();

        let rows = 5_000usize;
        let mut input = String::from("id,email\n");
        for i in 0..rows {
            input.push_str(&format!("{i},not-an-email\n"));
        }

        for chunk_size in [7usize, 64, 1024, input.len()] {
            let mut engine = ValidatorCore::new(&schema_json, 10, true).expect("engine init");
            for chunk in input.as_bytes().chunks(chunk_size) {
                engine.parse_slice(chunk);
            }
            engine.flush_end();

            assert_eq!(
                engine.rows_processed() as usize,
                rows,
                "every row must be counted (chunk size {chunk_size})"
            );

            let kept = engine.take_errors_packed(u32::MAX).len() / 2;
            assert_eq!(kept, 10, "recording is capped at max_errors");
            assert_eq!(
                engine.errors_suppressed() as usize,
                rows - 10,
                "suppressed count must total the rest (chunk size {chunk_size})"
            );

            // Normalized output must not lose rows once the queue fills either.
            let normalized = String::from_utf8(engine.take_normalized()).expect("utf8 normalized");
            assert_eq!(
                normalized.lines().count(),
                rows,
                "normalized output must cover every row (chunk size {chunk_size})"
            );
        }
    }

    fn take_error_codes(engine: &mut ValidatorCore) -> Vec<u8> {
        let packed = engine.take_errors_packed(10_000);
        packed
            .chunks_exact(2)
            .map(|chunk| (chunk[1] & 0xff) as u8)
            .collect()
    }

    fn count_code(codes: &[u8], code: u8) -> usize {
        codes.iter().filter(|c| **c == code).count()
    }
}
