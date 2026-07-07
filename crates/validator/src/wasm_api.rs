//! WASM (wasm-bindgen) adapter around [`ValidatorCore`].
//!
//! JS surface consumed by `packages/core/src/engine.ts`. Method and class
//! names are a compatibility contract — the TypeScript `Engine` wrapper and
//! the wasm-pack `--out-name import_validator_wasm` glue both depend on them.

use crate::counter::RowCounterCore;
use crate::engine::{ValidatorCore, ENGINE_VERSION};
use crate::xlsx::scanner::SheetRowCounter as SheetRowCounterCore;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct ValidatorEngine {
    core: ValidatorCore,
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

        ValidatorCore::new(schema_json, max_errors, emit_normalized)
            .map(|core| ValidatorEngine { core })
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Push a CSV chunk. Call with final_chunk=true on the last call.
    /// Returns a Progress object; throws on input-mode misuse.
    pub fn push_chunk(&mut self, chunk: &[u8], final_chunk: bool) -> Result<JsValue, JsValue> {
        let progress = self
            .core
            .push_chunk(chunk, final_chunk)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(serde_wasm_bindgen::to_value(&progress).unwrap_or(JsValue::NULL))
    }

    /// Push a chunk of decompressed xl/sharedStrings.xml. Must finish
    /// (final_chunk=true) before the first push_sheet_chunk call.
    pub fn push_shared_strings_chunk(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
    ) -> Result<(), JsValue> {
        self.core
            .push_shared_strings_chunk(chunk, final_chunk)
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Push a chunk of decompressed worksheet XML (xl/worksheets/sheetN.xml).
    /// Rows validate exactly like CSV rows — same errors, same normalized
    /// output. Returns a Progress object.
    pub fn push_sheet_chunk(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
    ) -> Result<JsValue, JsValue> {
        let progress = self
            .core
            .push_sheet_chunk(chunk, final_chunk)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(serde_wasm_bindgen::to_value(&progress).unwrap_or(JsValue::NULL))
    }

    /// Drain up to `max` packed errors.
    /// Each error is 2 u32 words: [row, (kind<<31) | (col<<8) | code].
    pub fn take_errors_packed(&mut self, max: u32) -> Vec<u32> {
        self.core.take_errors_packed(max)
    }

    /// Discard up to `max` queued errors without materializing them.
    pub fn drop_errors(&mut self, max: u32) -> u32 {
        self.core.drop_errors(max)
    }

    /// Number of errors currently queued without draining them.
    pub fn errors_count(&self) -> u32 {
        self.core.errors_count()
    }

    /// Total data rows processed so far (header excluded).
    pub fn rows_processed(&self) -> u32 {
        self.core.rows_processed()
    }

    /// Schema column names in schema order, as JSON array.
    pub fn schema_columns_json(&self) -> String {
        self.core.schema_columns_json()
    }

    /// Input (CSV/XLSX) header column names in input order, as JSON array.
    /// Empty array if schema.has_headers=false or header not parsed yet.
    pub fn input_columns_json(&self) -> String {
        self.core.input_columns_json()
    }

    /// Drain normalized CSV bytes accumulated so far (if enabled).
    pub fn take_normalized(&mut self) -> Vec<u8> {
        self.core.take_normalized()
    }

    /// Stable string mapping for error code (optional helper).
    pub fn error_code_to_string(code: u8) -> String {
        ValidatorCore::error_code_to_string(code).to_string()
    }
}

/// Engine crate version (also exposed natively via iv_version()).
#[wasm_bindgen]
pub fn engine_version() -> String {
    ENGINE_VERSION.to_string()
}

/// Quote-aware streaming CSV row counter for the estimate pass. Byte-exact
/// with the legacy worker-side JS estimator, at WASM speed.
#[wasm_bindgen]
pub struct RowCounter {
    core: RowCounterCore,
}

#[wasm_bindgen]
impl RowCounter {
    #[wasm_bindgen(constructor)]
    pub fn new(delimiter: u8) -> RowCounter {
        RowCounter {
            core: RowCounterCore::new(delimiter),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.core.push(chunk);
    }

    /// Returns [total_rows_lo, total_rows_hi, first_row_columns, has_columns].
    pub fn finish(&mut self) -> Vec<u32> {
        let rc = self.core.finish();
        vec![
            (rc.rows & 0xffff_ffff) as u32,
            (rc.rows >> 32) as u32,
            rc.first_row_columns.unwrap_or(0),
            rc.first_row_columns.is_some() as u32,
        ]
    }
}

/// Row counter for worksheet XML — the estimate fallback when the sheet has
/// no usable <dimension> element. Feed decompressed sheet XML chunks.
#[wasm_bindgen]
pub struct XlsxRowCounter {
    core: SheetRowCounterCore,
}

#[wasm_bindgen]
impl XlsxRowCounter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> XlsxRowCounter {
        XlsxRowCounter {
            core: SheetRowCounterCore::default(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.core.push(chunk);
    }

    /// Returns [total_rows_lo, total_rows_hi, columns, has_columns].
    pub fn finish(&mut self) -> Vec<u32> {
        let (rows, columns) = self.core.finish();
        vec![
            (rows & 0xffff_ffff) as u32,
            (rows >> 32) as u32,
            columns.unwrap_or(0),
            columns.is_some() as u32,
        ]
    }
}

impl Default for XlsxRowCounter {
    fn default() -> Self {
        Self::new()
    }
}
