//! Validate a CSV file from the command line, streaming it through the
//! engine in 1 MB chunks so memory stays flat regardless of file size.
//!
//! Usage:
//!   cargo run --release --example validate_csv -- <file.csv> [schema.json]
//!
//! When no schema path is given, a small built-in demo schema is used:
//! `id` (unique int), `email` (email), `amount` (decimal, 2 digits).
//!
//! Exit codes: 0 = valid, 1 = validation errors found, 2 = usage/setup error.

use import_validator::{Validator, ValidatorOptions};
use std::env;
use std::fs::File;
use std::io::Read;
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

const CHUNK_SIZE: usize = 1024 * 1024; // 1 MB

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(csv_path) = args.next() else {
        eprintln!("usage: validate_csv <file.csv> [schema.json]");
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

    let mut file = match File::open(&csv_path) {
        Ok(f) => f,
        Err(err) => {
            eprintln!("cannot open {csv_path}: {err}");
            return ExitCode::from(2);
        }
    };

    // Stream the file: any chunk boundary is fine, including mid-record —
    // the engine carries parser state across pushes.
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut total_errors: u64 = 0;
    loop {
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(err) => {
                eprintln!("read error on {csv_path}: {err}");
                return ExitCode::from(2);
            }
        };
        if n == 0 {
            break;
        }
        if let Err(err) = validator.push_chunk(&buf[..n]) {
            eprintln!("validation aborted: {err}");
            return ExitCode::from(2);
        }
        // Drain errors as we stream so the internal queue stays small.
        total_errors += drain_and_print(&mut validator);
    }

    // Signal end-of-stream so the final (possibly unterminated) record flushes.
    if let Err(err) = validator.finish() {
        eprintln!("validation aborted: {err}");
        return ExitCode::from(2);
    }
    total_errors += drain_and_print(&mut validator);

    println!("---");
    println!("file:           {csv_path}");
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

/// Drain every queued error and print it via its `Display` impl
/// (e.g. `row 3, column "email": InvalidEmail`). Returns how many were drained.
fn drain_and_print(validator: &mut Validator) -> u64 {
    let mut drained: u64 = 0;
    loop {
        let batch = validator.take_errors(1024);
        if batch.is_empty() {
            return drained;
        }
        for err in &batch {
            println!("{err}");
        }
        drained += batch.len() as u64;
    }
}
