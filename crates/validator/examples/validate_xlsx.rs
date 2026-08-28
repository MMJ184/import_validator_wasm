//! Validate an Excel (.xlsx) workbook from the command line using the
//! one-shot native XLSX path: the whole file is read into memory and the
//! engine unpacks the ZIP container itself (shared strings + first
//! worksheet, DEFLATE via miniz_oxide).
//!
//! The buffer must be complete before validation starts — a ZIP central
//! directory lives at the *end* of the file, so XLSX cannot be streamed
//! byte-by-byte the way CSV can.
//!
//! Usage:
//!   cargo run --release --example validate_xlsx -- <file.xlsx> [schema.json]
//!
//! When no schema path is given, a small built-in demo schema is used:
//! `id` (unique int), `email` (email), `amount` (decimal, 2 digits).
//!
//! Exit codes: 0 = valid, 1 = validation errors found, 2 = usage/setup error.

use import_validator::{Validator, ValidatorOptions};
use std::env;
use std::process::ExitCode;

/// Schema used when no schema file is passed on the command line.
/// Full contract: docs/validation-config.schema.json.
const DEFAULT_SCHEMA: &str = r#"{
    "hasHeaders": true,
    "columns": [
        { "name": "id",     "type": "int",     "required": true, "unique": true },
        { "name": "email",  "type": "email",   "required": true },
        { "name": "amount", "type": "decimal", "precision": 2 }
    ]
}"#;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(xlsx_path) = args.next() else {
        eprintln!("usage: validate_xlsx <file.xlsx> [schema.json]");
        return ExitCode::from(2);
    };
    let schema_json = match args.next() {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("cannot read schema file {path}: {err}");
                return ExitCode::from(2);
            }
        },
        None => DEFAULT_SCHEMA.to_string(),
    };

    let mut validator = match Validator::new(&schema_json, ValidatorOptions::default()) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("invalid schema: {err}");
            return ExitCode::from(2);
        }
    };

    let bytes = match std::fs::read(&xlsx_path) {
        Ok(b) => b,
        Err(err) => {
            eprintln!("cannot read {xlsx_path}: {err}");
            return ExitCode::from(2);
        }
    };

    // One call: ZIP directory parsing, decompression, shared-string and
    // worksheet-XML scanning all happen inside the engine.
    let progress = match validator.validate_xlsx_bytes(&bytes) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("validation aborted: {err}");
            return ExitCode::from(2);
        }
    };
    debug_assert!(progress.done);

    // Drain the queued errors in batches and print via Display
    // (e.g. `row 3, column "email": InvalidEmail`).
    let mut total_errors: u64 = 0;
    loop {
        let batch = validator.take_errors(1024);
        if batch.is_empty() {
            break;
        }
        for err in &batch {
            println!("{err}");
        }
        total_errors += batch.len() as u64;
    }

    println!("---");
    println!("file:           {xlsx_path}");
    println!("schema columns: {}", validator.schema_columns().join(", "));
    println!("input columns:  {}", validator.input_columns().join(", "));
    println!("rows processed: {}", validator.rows_processed());
    // max_errors caps recording, not validation: anything that did not fit is
    // counted here rather than lost, so the verdict stays honest.
    let suppressed = validator.errors_suppressed();
    println!("errors:         {}", total_errors + suppressed);
    if suppressed > 0 {
        println!("                ({total_errors} shown, {suppressed} over max_errors)");
    }
    if total_errors + suppressed == 0 {
        println!("result:         VALID");
        ExitCode::SUCCESS
    } else {
        println!("result:         INVALID");
        ExitCode::FAILURE
    }
}
