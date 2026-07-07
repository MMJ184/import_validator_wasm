//! Streaming XLSX (SpreadsheetML) support.
//!
//! The host feeds *decompressed* worksheet / shared-strings XML bytes in
//! chunks of any size; rows flow straight into the validation core with no
//! CSV round-trip. Who inflates depends on the host:
//!
//! - Browser worker: `DecompressionStream` (native zlib) → WASM push APIs
//! - Node: `node:zlib` inflateRaw → WASM push APIs
//! - Native (Python/C#/Go/Rust): one-shot [`zip`] module (miniz_oxide)
//!
//! Semantics parity with the original TypeScript pipeline is a hard contract
//! (documented deviations: phonetic `<rPh>` runs are excluded from shared
//! strings; cell references beyond Excel's XFD/16384-column limit are
//! rejected instead of exhausting memory).

pub mod scanner;
pub mod shared;
pub(crate) mod xml;

#[cfg(not(target_arch = "wasm32"))]
pub mod zip;
