// crates/validator/src/lib.rs
mod schema;
mod errors;

use errors::{ColKind, ErrorCode, PackedError};
use schema::{ColumnModifiers, ColumnType, DateFormat, Progress, Schema};

use csv_core::{ReadRecordResult, Reader, ReaderBuilder, Terminator};
use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use std::collections::{HashMap, HashSet, VecDeque};
use std::str;
use wasm_bindgen::prelude::*;
#[cfg(feature = "pattern")]
use regex::Regex;

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
    // Fast header mapping: schema column name -> schema index
    schema_name_to_index: HashMap<String, usize>,

    // For JS: input (CSV) header names in input order (only when has_headers=true)
    input_header_names: Vec<String>,

    // Row counter (data rows only, 1-based)
    data_row: u32,

    // Errors collected (drained to JS)
    errors: VecDeque<PackedError>,
    max_errors: u32,

    // Normalized output (optional, drained to JS)
    emit_normalized: bool,
    normalized: Vec<u8>,
    normalized_buf_limit: usize,

    // Per-record reusable starts buffer: starts[i] is start offset for field i
    starts: Vec<usize>,

    // Optional allowed-value set per schema column (for O(1) membership checks)
    allowed_sets: Vec<Option<HashSet<String>>>,

    // Optional uniqueness set per schema column (enabled when column.unique=true)
    unique_sets: Vec<Option<HashSet<String>>>,

    // Composite uniqueness groups (row-level key across multiple columns).
    unique_group_indices: Vec<Vec<usize>>,
    unique_group_sets: Vec<HashSet<String>>,

    // Precompiled regex patterns by schema column index (only in full/pattern build)
    #[cfg(feature = "pattern")]
    patterns: Vec<Option<Regex>>,

    #[cfg(feature = "pattern")]
    regex_replace_rules: Vec<Option<(Regex, String)>>,

    // Pre-allocated per-row canonical value buffer: reused each row instead of reallocating.
    // Indexed by schema column. Cleared via fill(None) at the start of each data row.
    row_values: Vec<Option<String>>,

    // Precomputed lowercase null-token values per schema column.
    // Built once at engine construction; avoids to_lowercase() on every field call.
    null_values_lower: Vec<Vec<String>>,

    // Scratch buffer for building composite-uniqueness keys without allocating a Vec<&str>.
    composite_key_buf: String,

    // Precomputed flag per schema column: true when apply_modifiers is a no-op (identity).
    // Skips the entire modifier pipeline for columns with only the default trim setting.
    modifier_is_identity: Vec<bool>,
}

#[wasm_bindgen]
impl ValidatorEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(
        schema_json: &str,
        max_errors: u32,
        emit_normalized: bool,
    ) -> Result<ValidatorEngine, JsValue> {
        #[cfg(feature = "dev")]
        console_error_panic_hook::set_once();

        let schema: Schema = serde_json::from_str(schema_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid schema JSON: {e}")))?;

        #[cfg(feature = "pattern")]
        let mut patterns = Vec::with_capacity(schema.columns.len());
        #[cfg(feature = "pattern")]
        let mut regex_replace_rules = Vec::with_capacity(schema.columns.len());
        for (i, c) in schema.columns.iter().enumerate() {
            if let Some(p) = c.pattern.as_ref() {
                if p.len() > 256 {
                    return Err(JsValue::from_str(&format!(
                        "Pattern too long in schema column {} ({}). Max 256 chars.",
                        i, c.name
                    )));
                }
                #[cfg(feature = "pattern")]
                {
                    let re = Regex::new(p).map_err(|e| {
                        JsValue::from_str(&format!("Invalid regex in schema column {} ({}): {e}", i, c.name))
                    })?;
                    patterns.push(Some(re));
                }
                #[cfg(not(feature = "pattern"))]
                {
                    return Err(JsValue::from_str(&format!(
                        "Pattern validation requested in column {} ({}), but this build disables pattern feature for maximum performance.",
                        i, c.name
                    )));
                }
            } else {
                #[cfg(feature = "pattern")]
                patterns.push(None);
            }

            if let Some(replace_pattern) = c.modifiers.regex_replace_pattern.as_ref() {
                #[cfg(feature = "pattern")]
                {
                    let re = Regex::new(replace_pattern).map_err(|e| {
                        JsValue::from_str(&format!(
                            "Invalid regexReplacePattern in schema column {} ({}): {e}",
                            i,
                            c.name
                        ))
                    })?;
                    let replacement = c.modifiers.regex_replace_with.clone().unwrap_or_default();
                    regex_replace_rules.push(Some((re, replacement)));
                }
                #[cfg(not(feature = "pattern"))]
                {
                    let _ = replace_pattern;
                    return Err(JsValue::from_str(&format!(
                        "regexReplacePattern requested in column {} ({}), but this build disables pattern feature.",
                        i, c.name
                    )));
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
            .collect::<HashMap<_, _>>();
        let allowed_sets = schema
            .columns
            .iter()
            .map(|c| {
                if c.allowed.is_empty() {
                    None
                } else {
                    Some(c.allowed.iter().cloned().collect::<HashSet<_>>())
                }
            })
            .collect::<Vec<_>>();
        let unique_sets = schema
            .columns
            .iter()
            .map(|c| {
                if c.unique {
                    Some(HashSet::<String>::new())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let mut unique_group_indices = Vec::with_capacity(schema.unique_groups.len());
        for (gi, group) in schema.unique_groups.iter().enumerate() {
            if group.columns.is_empty() {
                return Err(JsValue::from_str(&format!(
                    "uniqueGroups[{gi}] must include at least one column."
                )));
            }

            let mut resolved = Vec::with_capacity(group.columns.len());
            for col_name in &group.columns {
                let Some(idx) = schema_name_to_index.get(col_name).copied() else {
                    return Err(JsValue::from_str(&format!(
                        "uniqueGroups[{gi}] references unknown column \"{col_name}\""
                    )));
                };
                resolved.push(idx);
            }

            unique_group_indices.push(resolved);
        }
        let unique_group_sets = (0..unique_group_indices.len())
            .map(|_| HashSet::<String>::new())
            .collect::<Vec<_>>();

        // Pre-allocate per-row value scratch buffer.
        let row_values = vec![None::<String>; schema.columns.len()];

        // Precompute lowercased null token values per column to avoid per-call lowercasing.
        let null_values_lower = schema
            .columns
            .iter()
            .map(|c| {
                if c.modifiers.null_values_case_insensitive {
                    c.modifiers.null_values.iter().map(|v| v.to_lowercase()).collect()
                } else {
                    Vec::new()
                }
            })
            .collect::<Vec<Vec<String>>>();

        // Precompute identity flag to skip apply_modifiers for columns with no active modifiers.
        let modifier_is_identity = schema
            .columns
            .iter()
            .map(|c| is_identity_modifiers(&c.modifiers))
            .collect::<Vec<_>>();

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
            schema_name_to_index,
            input_header_names: Vec::new(),
            data_row: 0,
            errors: VecDeque::new(),
            max_errors,
            emit_normalized,
            // Only pre-allocate normalized buffer when normalization is actually enabled.
            normalized: if emit_normalized { Vec::with_capacity(256 * 1024) } else { Vec::new() },
            normalized_buf_limit: 2 * 1024 * 1024, // drain frequently
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
            null_values_lower,
            composite_key_buf: String::new(),
            modifier_is_identity,
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

        serde_wasm_bindgen::to_value(&prog).unwrap_or(JsValue::NULL)
    }

    /// Drain up to `max` packed errors.
    /// Each error is 2 u32 words: [row, (kind<<31) | (col<<8) | code].
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

    /// Returns the number of errors currently queued without draining them.
    pub fn errors_count(&self) -> u32 {
        self.errors.len() as u32
    }

    /// Schema column names in schema order, as JSON array.
    pub fn schema_columns_json(&self) -> String {
        serde_json::to_string(&self.schema_col_names).unwrap()
    }

    /// Input (CSV) header column names in input order, as JSON array.
    /// Empty array if schema.has_headers=false or header not parsed yet.
    pub fn input_columns_json(&self) -> String {
        serde_json::to_string(&self.input_header_names).unwrap()
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
            8 => "MinLengthNotMet",
            9 => "InvalidEmail",
            10 => "PatternMismatch",
            11 => "PrecisionExceeded",
            12 => "ColumnCountMismatch",
            13 => "DuplicateValue",
            14 => "DuplicateCombination",
            _ => "Unknown",
        }
        .to_string()
    }
}

impl ValidatorEngine {
    fn parse_slice(&mut self, mut input: &[u8]) {
        while !input.is_empty() {
            let (res, nin, nout, nends) =
                self.rdr.read_record(input, &mut self.out, &mut self.ends);
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
                ReadRecordResult::End => return,
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
        // Clear the pre-allocated scratch buffer instead of allocating a fresh Vec every row.
        self.row_values.iter_mut().for_each(|v| *v = None);

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
                    if schema_idx < self.row_values.len() {
                        self.row_values[schema_idx] = Some(canonical);
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
                        self.push_err(
                            self.data_row,
                            schema_idx as u32,
                            ErrorCode::MissingRequired,
                            ColKind::Schema,
                        );
                        if self.hit_error_limit() {
                            return;
                        }
                    }
                }
            }
        }

        // Use mem::take so we can pass &row_vals to check_composite_uniques which
        // needs &mut self for its HashSet inserts. No allocation: just moves the
        // Vec pointer out and back.
        {
            let row_vals = std::mem::take(&mut self.row_values);
            self.check_composite_uniques(&row_vals);
            self.row_values = row_vals;
        }
        if self.hit_error_limit() {
            return;
        }

        // Emit normalized row using already-computed canonical values — avoids
        // calling prepare_field_value a second time for every field.
        if self.emit_normalized && self.normalized.len() < self.normalized_buf_limit {
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

        // Store input header names for JS/UI
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
            if let Some(schema_idx) = self.schema_name_to_index.get(nm).copied() {
                self.input_to_schema[input_i] = Some(schema_idx);
                self.schema_to_input[schema_idx] = Some(input_i);
            }
        }

        // Ensure required columns exist
        for schema_idx in 0..self.schema.columns.len() {
            let required = self.schema.columns[schema_idx].required;
            if required && self.schema_to_input.get(schema_idx).copied().flatten().is_none() {
                self.push_err(
                    0,
                    schema_idx as u32,
                    ErrorCode::MissingRequiredColumn,
                    ColKind::Schema,
                );
            }
        }
    }

    fn validate_field(&mut self, schema_idx: usize, raw: &[u8]) -> Option<String> {
        let col = &self.schema.columns[schema_idx];
        let prepared = match self.prepare_field_value(schema_idx, raw, &col.modifiers) {
            Ok(v) => v,
            Err(_) => {
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
            if col.required && !col.nullable {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::MissingRequired,
                    ColKind::Schema,
                );
            }
            return None;
        }

        if let Some(min_len) = col.min_len {
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

        if let Some(max_len) = col.max_len {
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
            if !allowed.contains(prepared.as_str()) {
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
            if !re.is_match(prepared.as_str()) {
                self.push_err(
                    self.data_row,
                    schema_idx as u32,
                    ErrorCode::PatternMismatch,
                    ColKind::Schema,
                );
                return None;
            }
        }

        let canonical = match col.col_type {
            ColumnType::String => prepared.clone(),
            ColumnType::Int => {
                if !is_valid_int(prepared.as_str()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared.clone()
            }
            ColumnType::Float => {
                if !is_valid_float(prepared.as_str()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared.clone()
            }
            ColumnType::Double => {
                if !is_valid_double(prepared.as_str()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared.clone()
            }
            ColumnType::Number => {
                if !is_valid_number(prepared.as_str()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared.clone()
            }
            ColumnType::Decimal => {
                let precision = col.precision.unwrap_or(2);
                let strict = col.strict_precision;
                match validate_normalize_decimal(prepared.as_str(), precision, strict) {
                    Ok(normalized) => normalized,
                    Err(err_code) => {
                        self.push_err(self.data_row, schema_idx as u32, err_code, ColKind::Schema);
                        return None;
                    }
                }
            }
            ColumnType::Email => {
                if !is_valid_email(prepared.as_str()) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidEmail,
                        ColKind::Schema,
                    );
                    return None;
                }
                prepared.clone()
            }
            ColumnType::Date => {
                let fmt = col.date_format.unwrap_or(DateFormat::YmdDash);
                if !is_valid_date(prepared.as_str(), fmt) {
                    self.push_err(
                        self.data_row,
                        schema_idx as u32,
                        ErrorCode::InvalidType,
                        ColKind::Schema,
                    );
                    return None;
                }
                normalize_date(prepared.as_str(), fmt).unwrap_or(prepared.clone())
            }
        };

        if col.unique {
            if let Some(unique_set) = self.unique_sets.get_mut(schema_idx).and_then(|x| x.as_mut()) {
                if !unique_set.insert(canonical.clone()) {
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

            if self.normalized.len() >= self.normalized_buf_limit {
                break;
            }
        }
    }

    fn prepare_field_value(
        &self,
        schema_idx: usize,
        raw: &[u8],
        modifiers: &ColumnModifiers
    ) -> Result<String, ()> {
        let source = if modifiers.trim { trim_ascii(raw) } else { raw };
        if source.is_empty() {
            return Ok(String::new());
        }
        let input = match str::from_utf8(source) {
            Ok(v) => v,
            Err(_) => return Err(()),
        };
        if self.modifier_is_identity[schema_idx] {
            return Ok(input.to_string());
        }
        Ok(apply_modifiers(self, schema_idx, input, modifiers))
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

            if self.unique_group_sets[gi].contains(self.composite_key_buf.as_str()) {
                self.push_err(
                    self.data_row,
                    col_for_error as u32,
                    ErrorCode::DuplicateCombination,
                    ColKind::Schema,
                );
                return;
            }
            self.unique_group_sets[gi].insert(self.composite_key_buf.clone());
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

    fn push_err(&mut self, row: u32, col: u32, code: ErrorCode, kind: ColKind) {
        if (self.errors.len() as u32) >= self.max_errors {
            return;
        }
        self.errors.push_back(PackedError { row, col, code, kind });
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

fn apply_modifiers(
    engine: &ValidatorEngine,
    schema_idx: usize,
    input: &str,
    modifiers: &ColumnModifiers
) -> String {
    let mut out = if modifiers.collapse_whitespace {
        collapse_whitespace(input)
    } else {
        input.to_string()
    };

    if modifiers.substring_start.is_some() || modifiers.substring_end.is_some() {
        out = substring_by_chars(
            out.as_str(),
            modifiers.substring_start.unwrap_or(0),
            modifiers.substring_end
        );
    }

    if let Some(from) = modifiers.replace_from.as_ref() {
        if !from.is_empty() {
            out = out.replace(from, modifiers.replace_to.as_deref().unwrap_or(""));
        }
    }

    out = apply_regex_replace(engine, schema_idx, out);

    if modifiers.lowercase {
        out = out.to_lowercase();
    }
    if modifiers.uppercase {
        out = out.to_uppercase();
    }
    if modifiers.title_case {
        out = to_title_case(out.as_str());
    }

    if is_null_token(out.as_str(), modifiers, &engine.null_values_lower[schema_idx]) {
        return String::new();
    }

    if (modifiers.ceil || modifiers.floor || modifiers.round || modifiers.decimal_scale.is_some())
        && !out.is_empty()
    {
        if let Some(num_out) = apply_numeric_modifiers(out.as_str(), modifiers) {
            out = num_out;
        }
    }

    if let Some(prefix) = modifiers.prefix.as_ref() {
        let mut prefixed = String::with_capacity(prefix.len() + out.len());
        prefixed.push_str(prefix);
        prefixed.push_str(&out);
        out = prefixed;
    }
    if let Some(suffix) = modifiers.suffix.as_ref() {
        out.push_str(suffix.as_str());
    }

    out
}

fn apply_numeric_modifiers(input: &str, modifiers: &ColumnModifiers) -> Option<String> {
    if input.contains(',') {
        return None;
    }

    let mut value = Decimal::from_str_exact(input).ok()?;

    if modifiers.ceil {
        value = value.ceil();
    } else if modifiers.floor {
        value = value.floor();
    } else if modifiers.round {
        value = value.round();
    }

    if let Some(scale) = modifiers.decimal_scale {
        let rounded = value.round_dp_with_strategy(scale, RoundingStrategy::MidpointAwayFromZero);
        let mut fixed = rounded;
        fixed.rescale(scale);
        return Some(fixed.to_string());
    }

    Some(value.to_string())
}

fn apply_regex_replace(_engine: &ValidatorEngine, _schema_idx: usize, value: String) -> String {
    #[cfg(feature = "pattern")]
    {
        if let Some((re, replacement)) = _engine
            .regex_replace_rules
            .get(_schema_idx)
            .and_then(|r| r.as_ref())
        {
            return re.replace_all(value.as_str(), replacement.as_str()).to_string();
        }
    }
    value
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for token in input.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(token);
    }
    out
}

fn substring_by_chars(input: &str, start: usize, end: Option<usize>) -> String {
    let char_count = input.chars().count();
    if start >= char_count {
        return String::new();
    }
    let end_idx = end.unwrap_or(char_count).min(char_count);
    if end_idx <= start {
        return String::new();
    }
    input.chars().skip(start).take(end_idx - start).collect()
}

fn to_title_case(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (i, token) in input.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut chars = token.chars();
        if let Some(first) = chars.next() {
            for c in first.to_uppercase() {
                out.push(c);
            }
            let rest = chars.as_str().to_lowercase();
            out.push_str(rest.as_str());
        }
    }
    out
}

fn is_null_token(input: &str, modifiers: &ColumnModifiers, lower_cache: &[String]) -> bool {
    if modifiers.null_values.is_empty() {
        return false;
    }
    if modifiers.null_values_case_insensitive {
        let candidate = input.to_lowercase();
        return lower_cache.iter().any(|v| candidate == *v);
    }
    modifiers.null_values.iter().any(|v| input == v)
}

fn is_identity_modifiers(modifiers: &ColumnModifiers) -> bool {
    if modifiers.collapse_whitespace { return false; }
    if modifiers.substring_start.is_some() || modifiers.substring_end.is_some() { return false; }
    if modifiers.replace_from.as_ref().map_or(false, |s| !s.is_empty()) { return false; }
    if modifiers.lowercase || modifiers.uppercase || modifiers.title_case { return false; }
    if !modifiers.null_values.is_empty() { return false; }
    if modifiers.ceil || modifiers.floor || modifiers.round || modifiers.decimal_scale.is_some() { return false; }
    if modifiers.prefix.is_some() || modifiers.suffix.is_some() { return false; }
    #[cfg(feature = "pattern")]
    if modifiers.regex_replace_pattern.is_some() { return false; }
    true
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

fn is_valid_float(s: &str) -> bool {
    match s.parse::<f32>() {
        Ok(v) => v.is_finite(),
        Err(_) => false,
    }
}

fn is_valid_double(s: &str) -> bool {
    match s.parse::<f64>() {
        Ok(v) => v.is_finite(),
        Err(_) => false,
    }
}

fn is_valid_number(s: &str) -> bool {
    is_valid_int(s) || is_valid_double(s)
}

/// Validate and normalize a decimal string in a single parse pass.
/// Returns the normalized string on success, or an error code on failure.
fn validate_normalize_decimal(s: &str, precision: u32, strict: bool) -> Result<String, ErrorCode> {
    if s.contains(',') {
        return Err(ErrorCode::InvalidType);
    }
    let d = match Decimal::from_str_exact(s) {
        Ok(v) => v,
        Err(_) => return Err(ErrorCode::InvalidType),
    };
    if d.scale() > precision {
        return Err(ErrorCode::InvalidType);
    }
    if strict && d.scale() != precision {
        return Err(ErrorCode::PrecisionExceeded);
    }
    let rounded = d.round_dp_with_strategy(precision, RoundingStrategy::MidpointAwayFromZero);
    let mut fixed = rounded;
    fixed.rescale(precision);
    Ok(fixed.to_string())
}

fn is_valid_email(s: &str) -> bool {
    let at = match s.find('@') {
        Some(i) => i,
        None => return false,
    };
    if at == 0 || at + 1 >= s.len() {
        return false;
    }

    let local = &s[..at];
    let domain = &s[at + 1..];
    if local.is_empty() || domain.is_empty() {
        return false;
    }
    if !domain.contains('.') {
        return false;
    }
    if domain.starts_with('.') || domain.ends_with('.') {
        return false;
    }

    true
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

        let mut engine = ValidatorEngine::new(&schema_json, 1000, false).expect("engine init");
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

        let mut engine = ValidatorEngine::new(&schema_json, 1000, true).expect("engine init");
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

        let mut engine = ValidatorEngine::new(&schema_json, 1000, true).expect("engine init");
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

        let mut engine = ValidatorEngine::new(&schema_json, 1000, true).expect("engine init");
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

        let mut engine = ValidatorEngine::new(&schema_json, 1000, false).expect("engine init");
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

        let mut engine = ValidatorEngine::new(&schema_json, 1000, false).expect("engine init");
        let csv = b"customerId,email\n1,A@EXAMPLE.COM\n1,a@example.com\n";
        engine.parse_slice(csv);
        engine.flush_end();

        let codes = take_error_codes(&mut engine);
        assert_eq!(count_code(&codes, ErrorCode::DuplicateCombination as u8), 1);
    }

    fn take_error_codes(engine: &mut ValidatorEngine) -> Vec<u8> {
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
