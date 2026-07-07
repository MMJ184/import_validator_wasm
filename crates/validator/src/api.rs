//! Public Rust API.
//!
//! Use this when depending on the crate directly from Rust — no wasm-bindgen
//! types, no unsafe, typed errors with resolved column names.
//!
//! ```no_run
//! use import_validator::{Validator, ValidatorOptions};
//!
//! let schema = r#"{"hasHeaders":true,"columns":[
//!     {"name":"id","type":"int","required":true,"unique":true},
//!     {"name":"email","type":"email","required":true}
//! ]}"#;
//!
//! let mut v = Validator::new(schema, ValidatorOptions::default()).unwrap();
//! v.push_chunk(b"id,email\n1,a@example.com\n").unwrap();
//! let summary = v.finish().unwrap();
//! for err in v.take_errors(1000) {
//!     eprintln!("{err}");
//! }
//! println!("rows: {}", summary.rows_processed);
//! ```

use crate::engine::ValidatorCore;
use crate::schema::Progress;
use std::fmt;

/// Options for [`Validator::new`].
#[derive(Debug, Clone)]
pub struct ValidatorOptions {
    /// Stop accumulating errors after this many (bounds memory). Default 10_000.
    pub max_errors: u32,
    /// Collect normalized CSV output (drain with [`Validator::take_normalized`]).
    pub emit_normalized: bool,
}

impl Default for ValidatorOptions {
    fn default() -> Self {
        Self {
            max_errors: 10_000,
            emit_normalized: false,
        }
    }
}

/// Which column namespace an error's `column_index` refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    /// Index into the schema's column list.
    Schema,
    /// Index into the input file's header columns.
    Input,
}

/// A decoded validation error with resolved column name.
#[derive(Debug, Clone)]
pub struct ValidationError {
    /// 1-based data row; 0 means header-level.
    pub row: u32,
    pub column_index: u32,
    pub column_kind: ColumnKind,
    /// Resolved column name, when the index maps to a known column.
    pub column_name: Option<String>,
    /// Stable numeric code (see docs/SCHEMA_REFERENCE.md).
    pub code: u8,
    /// Stable string name for `code`, e.g. "InvalidType".
    pub code_name: &'static str,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let place = if self.row == 0 {
            "header".to_string()
        } else {
            format!("row {}", self.row)
        };
        match &self.column_name {
            Some(name) => write!(f, "{place}, column \"{name}\": {}", self.code_name),
            None => write!(
                f,
                "{place}, column #{}: {}",
                self.column_index, self.code_name
            ),
        }
    }
}

/// Validation summary returned by push/finish calls.
pub type ValidationProgress = Progress;

/// Streaming CSV/XLSX validator (safe Rust wrapper around the engine core).
///
/// One validator instance handles exactly one input stream — CSV bytes via
/// [`push_chunk`](Self::push_chunk), or XLSX via
/// [`push_shared_strings_chunk`](Self::push_shared_strings_chunk) +
/// [`push_sheet_chunk`](Self::push_sheet_chunk) (or the one-shot
/// [`validate_xlsx_bytes`](Self::validate_xlsx_bytes)). Not `Sync`: use one
/// validator per concurrent job.
pub struct Validator {
    core: ValidatorCore,
}

impl Validator {
    /// Create a validator from schema JSON (contract:
    /// docs/validation-config.schema.json).
    pub fn new(schema_json: &str, options: ValidatorOptions) -> Result<Self, String> {
        ValidatorCore::new(schema_json, options.max_errors, options.emit_normalized)
            .map(|core| Validator { core })
    }

    /// Push a CSV chunk (any split points are fine, including mid-record).
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<ValidationProgress, String> {
        self.core.push_chunk(chunk, false)
    }

    /// Signal end-of-stream and flush the parser.
    pub fn finish(&mut self) -> Result<ValidationProgress, String> {
        self.core.push_chunk(&[], true)
    }

    /// Push a chunk of decompressed `xl/sharedStrings.xml`; call with
    /// `final_chunk=true` once before the first sheet chunk.
    pub fn push_shared_strings_chunk(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
    ) -> Result<(), String> {
        self.core.push_shared_strings_chunk(chunk, final_chunk)
    }

    /// Push a chunk of decompressed worksheet XML.
    pub fn push_sheet_chunk(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
    ) -> Result<ValidationProgress, String> {
        self.core.push_sheet_chunk(chunk, final_chunk)
    }

    /// One-shot: validate a complete `.xlsx` byte buffer (ZIP parsing and
    /// DEFLATE happen inside the engine). Native targets only.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn validate_xlsx_bytes(&mut self, bytes: &[u8]) -> Result<ValidationProgress, String> {
        crate::xlsx::zip::validate_xlsx_bytes(&mut self.core, bytes)
    }

    /// Drain up to `max` decoded errors (with column names resolved).
    pub fn take_errors(&mut self, max: u32) -> Vec<ValidationError> {
        let packed = self.core.take_errors_packed(max);
        let mut out = Vec::with_capacity(packed.len() / 2);
        for pair in packed.chunks_exact(2) {
            let row = pair[0];
            let word = pair[1];
            let kind = if (word >> 31) & 1 == 1 {
                ColumnKind::Input
            } else {
                ColumnKind::Schema
            };
            let column_index = (word >> 8) & 0x7f_ffff;
            let code = (word & 0xff) as u8;
            let column_name = match kind {
                ColumnKind::Schema => self
                    .core
                    .schema_columns()
                    .get(column_index as usize)
                    .cloned(),
                ColumnKind::Input => self
                    .core
                    .input_columns()
                    .get(column_index as usize)
                    .cloned(),
            };
            out.push(ValidationError {
                row,
                column_index,
                column_kind: kind,
                column_name,
                code,
                code_name: ValidatorCore::error_code_to_string(code),
            });
        }
        out
    }

    /// Errors currently queued (not yet drained).
    pub fn errors_count(&self) -> u32 {
        self.core.errors_count()
    }

    /// Total data rows processed so far.
    pub fn rows_processed(&self) -> u32 {
        self.core.rows_processed()
    }

    /// Schema column names in schema order.
    pub fn schema_columns(&self) -> &[String] {
        self.core.schema_columns()
    }

    /// Input header names (empty before the header row is parsed).
    pub fn input_columns(&self) -> &[String] {
        self.core.input_columns()
    }

    /// Drain normalized CSV bytes (only when `emit_normalized` was set).
    pub fn take_normalized(&mut self) -> Vec<u8> {
        self.core.take_normalized()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_api_validates_and_decodes_column_names() {
        let schema = r#"{"hasHeaders":true,"columns":[
            {"name":"id","type":"int","required":true,"unique":true},
            {"name":"email","type":"email","required":true}
        ]}"#;
        let mut v = Validator::new(schema, ValidatorOptions::default()).expect("schema");
        v.push_chunk(b"id,email\n1,a@example.com\n1,not-an-email\n")
            .expect("push");
        let progress = v.finish().expect("finish");
        assert!(progress.done);
        assert_eq!(v.rows_processed(), 2);

        let errors = v.take_errors(100);
        assert_eq!(errors.len(), 2);
        let names: Vec<_> = errors
            .iter()
            .filter_map(|e| e.column_name.as_deref())
            .collect();
        assert!(names.contains(&"id"));
        assert!(names.contains(&"email"));
        let codes: Vec<_> = errors.iter().map(|e| e.code_name).collect();
        assert!(codes.contains(&"DuplicateValue"));
        assert!(codes.contains(&"InvalidEmail"));
    }
}
