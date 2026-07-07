//! # import-validator
//!
//! High-performance streaming CSV/XLSX validation engine.
//!
//! One core ([`engine::ValidatorCore`]), three adapters:
//!
//! | Adapter    | Target                  | Consumers                        |
//! |------------|-------------------------|----------------------------------|
//! | [`api`]    | any (public Rust API)   | Rust applications                |
//! | `wasm_api` | wasm32 (wasm-bindgen)   | Browser worker, Node WASM        |
//! | `ffi`      | native (C ABI)          | Python, C#, Go, any C-FFI caller |
//!
//! Module map:
//! - [`engine`] — streaming core: CSV record loop, header mapping, field
//!   validation, uniqueness, normalized output
//! - [`schema`] — schema JSON contract types (serde)
//! - [`errors`] — error codes and packed error representation
//! - [`typecheck`] — type validators + canonicalizers (zero-alloc fast paths)
//! - [`modifiers`] — pre-validation value transforms
//! - [`fingerprint`] — 128-bit content fingerprints for uniqueness tracking
//! - [`counter`] — quote-aware CSV row counter (estimate pass)
//! - [`xlsx`] — streaming worksheet XML scanner, shared strings, native ZIP
//!
//! Feature flags: `pattern` (regex validation/replace; bigger binary),
//! `dev` (WASM panic hook).

pub mod api;
pub mod counter;
pub mod engine;
pub mod errors;
pub mod fingerprint;
pub mod modifiers;
pub mod schema;
pub mod typecheck;
pub mod xlsx;

#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;

#[cfg(target_arch = "wasm32")]
pub mod wasm_api;

pub use api::{ColumnKind, ValidationError, Validator, ValidatorOptions};
pub use engine::{ValidatorCore, ENGINE_VERSION};
pub use schema::Progress;
