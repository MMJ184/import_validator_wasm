//! C-ABI bindings for native (non-WASM) targets: Python, C#, Go, etc.
//! This module is excluded entirely from WASM builds via the cfg gate in lib.rs.
//!
//! Thread-safety contract: an engine handle is NOT thread-safe. Use one
//! engine per concurrent validation; different engines may run on different
//! threads simultaneously.

use crate::engine::{ValidatorCore, ENGINE_VERSION};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

/// Progress snapshot returned by push/validate calls via out-parameter.
/// Layout matches the C struct in bindings/include/import_validator.h.
#[repr(C)]
pub struct IvProgress {
    pub rows_processed: u32,
    pub errors_added: u32,
    /// 1 when this was the final chunk (parser flushed), 0 otherwise.
    pub done: u8,
    pub _pad: [u8; 3],
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/// Create a new validator engine.
///
/// `schema_json`      NUL-terminated UTF-8 JSON matching the schema contract.
/// `max_errors`       Stop accumulating errors after this many (prevents unbounded memory).
/// `emit_normalized`  1 to collect normalized CSV output, 0 to disable.
/// `err_buf`          Caller-allocated buffer for an error message on failure (may be NULL).
/// `err_buf_len`      Byte capacity of err_buf (including NUL terminator).
///
/// Returns an opaque engine handle on success, NULL on failure.
/// Destroy with iv_engine_destroy when done.
///
/// # Safety
/// `schema_json` must be a valid NUL-terminated string (or NULL). `err_buf`, when non-NULL, must be writable for `err_buf_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_new(
    schema_json: *const c_char,
    max_errors: u32,
    emit_normalized: u8,
    err_buf: *mut c_char,
    err_buf_len: u32,
) -> *mut ValidatorCore {
    if schema_json.is_null() {
        write_err(err_buf, err_buf_len, "schema_json is null");
        return ptr::null_mut();
    }
    let schema_str = match CStr::from_ptr(schema_json).to_str() {
        Ok(s) => s,
        Err(e) => {
            write_err(err_buf, err_buf_len, &e.to_string());
            return ptr::null_mut();
        }
    };
    match ValidatorCore::new(schema_str, max_errors, emit_normalized != 0) {
        Ok(engine) => Box::into_raw(Box::new(engine)),
        Err(msg) => {
            write_err(err_buf, err_buf_len, &msg);
            ptr::null_mut()
        }
    }
}

/// Destroy an engine and release all its memory.
/// Passing NULL is a no-op.
///
/// # Safety
/// `handle` must be NULL or a live pointer returned by `iv_engine_new` that has not been destroyed; it must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_destroy(handle: *mut ValidatorCore) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Engine version string (static; do NOT free).
///
/// # Safety
/// Always safe; the returned pointer is static and must NOT be freed.
#[no_mangle]
pub unsafe extern "C" fn iv_version() -> *const c_char {
    // NUL-terminated static storage, built once.
    static VERSION_CSTR: std::sync::OnceLock<CString> = std::sync::OnceLock::new();
    VERSION_CSTR
        .get_or_init(|| CString::new(ENGINE_VERSION).expect("version is valid C string"))
        .as_ptr()
}

// ── Processing: CSV ──────────────────────────────────────────────────────────

/// Push a CSV chunk into the engine.
///
/// `chunk_ptr`     Pointer to chunk bytes. May be NULL when chunk_len == 0.
/// `chunk_len`     Number of bytes in the chunk.
/// `final_chunk`   Non-zero to signal end-of-stream and flush the CSV parser.
/// `out_progress`  Filled with row/error progress for this chunk. May be NULL.
///
/// Returns 0 on success, -1 if handle is NULL, -2 on input-mode misuse
/// (engine already consumed XLSX input).
///
/// # Safety
/// `handle` must be NULL or a live engine pointer. `chunk_ptr`, when non-NULL, must be readable for `chunk_len` bytes. `out_progress`, when non-NULL, must be writable.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_push_chunk(
    handle: *mut ValidatorCore,
    chunk_ptr: *const u8,
    chunk_len: u32,
    final_chunk: u8,
    out_progress: *mut IvProgress,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let engine = &mut *handle;
    let chunk: &[u8] = if chunk_len > 0 && !chunk_ptr.is_null() {
        std::slice::from_raw_parts(chunk_ptr, chunk_len as usize)
    } else {
        &[]
    };
    match engine.push_chunk(chunk, final_chunk != 0) {
        Ok(progress) => {
            write_progress(
                out_progress,
                progress.rows_processed,
                progress.errors_added,
                final_chunk,
            );
            0
        }
        Err(_) => -2,
    }
}

// ── Processing: XLSX ─────────────────────────────────────────────────────────

/// Push a chunk of decompressed xl/sharedStrings.xml. Must finish
/// (final_chunk=1) before the first iv_engine_push_sheet_chunk call.
/// Returns 0 on success, -1 if handle is NULL, -2 on failure (message in err_buf).
///
/// # Safety
/// Same pointer rules as `iv_engine_push_chunk`; `err_buf`, when non-NULL, must be writable for `err_buf_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_push_shared_strings_chunk(
    handle: *mut ValidatorCore,
    chunk_ptr: *const u8,
    chunk_len: u32,
    final_chunk: u8,
    err_buf: *mut c_char,
    err_buf_len: u32,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let engine = &mut *handle;
    let chunk: &[u8] = if chunk_len > 0 && !chunk_ptr.is_null() {
        std::slice::from_raw_parts(chunk_ptr, chunk_len as usize)
    } else {
        &[]
    };
    match engine.push_shared_strings_chunk(chunk, final_chunk != 0) {
        Ok(()) => 0,
        Err(msg) => {
            write_err(err_buf, err_buf_len, &msg);
            -2
        }
    }
}

/// Push a chunk of decompressed worksheet XML (xl/worksheets/sheetN.xml).
/// Rows validate exactly like CSV rows.
/// Returns 0 on success, -1 if handle is NULL, -2 on failure (message in err_buf).
///
/// # Safety
/// Same pointer rules as `iv_engine_push_chunk`; `err_buf`, when non-NULL, must be writable for `err_buf_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_push_sheet_chunk(
    handle: *mut ValidatorCore,
    chunk_ptr: *const u8,
    chunk_len: u32,
    final_chunk: u8,
    out_progress: *mut IvProgress,
    err_buf: *mut c_char,
    err_buf_len: u32,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let engine = &mut *handle;
    let chunk: &[u8] = if chunk_len > 0 && !chunk_ptr.is_null() {
        std::slice::from_raw_parts(chunk_ptr, chunk_len as usize)
    } else {
        &[]
    };
    match engine.push_sheet_chunk(chunk, final_chunk != 0) {
        Ok(progress) => {
            write_progress(
                out_progress,
                progress.rows_processed,
                progress.errors_added,
                final_chunk,
            );
            0
        }
        Err(msg) => {
            write_err(err_buf, err_buf_len, &msg);
            -2
        }
    }
}

/// One-shot: validate a complete .xlsx file from a byte buffer. The engine
/// parses the ZIP container, streams shared strings, then streams the first
/// worksheet — memory stays proportional to shared strings, not sheet size.
/// Returns 0 on success, -1 if handle/bytes NULL, -2 on failure (message in err_buf).
///
/// # Safety
/// `bytes_ptr` must be readable for `bytes_len` bytes. `out_progress`/`err_buf`, when non-NULL, must be writable (err_buf for `err_buf_len` bytes).
#[no_mangle]
pub unsafe extern "C" fn iv_engine_validate_xlsx_bytes(
    handle: *mut ValidatorCore,
    bytes_ptr: *const u8,
    bytes_len: u32,
    out_progress: *mut IvProgress,
    err_buf: *mut c_char,
    err_buf_len: u32,
) -> i32 {
    if handle.is_null() || bytes_ptr.is_null() {
        return -1;
    }
    let engine = &mut *handle;
    let bytes = std::slice::from_raw_parts(bytes_ptr, bytes_len as usize);
    match crate::xlsx::zip::validate_xlsx_bytes(engine, bytes) {
        Ok(progress) => {
            write_progress(
                out_progress,
                progress.rows_processed,
                progress.errors_added,
                1,
            );
            0
        }
        Err(msg) => {
            write_err(err_buf, err_buf_len, &msg);
            -2
        }
    }
}

// ── Error draining ───────────────────────────────────────────────────────────

/// Returns the number of errors currently queued (without draining).
///
/// # Safety
/// `handle` must be NULL or a live engine pointer.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_errors_count(handle: *const ValidatorCore) -> u32 {
    if handle.is_null() {
        return 0;
    }
    (*handle).errors_count()
}

/// Drain up to `max_pairs` errors into `out_buf`.
///
/// Each error occupies two consecutive u32 slots:
///   out_buf[i*2 + 0] = row  (1-based data row number; 0 = header)
///   out_buf[i*2 + 1] = pack = (kind_bit:1)(col:23)(code:8)
///     kind_bit: 1 = input-column index, 0 = schema-column index
///
/// `out_buf` must be large enough for (max_pairs * 2) u32 values.
/// Returns the number of error pairs actually written.
///
/// # Safety
/// `out_buf` must be writable for `max_pairs * 2` u32 values; `handle` must be NULL or a live engine pointer.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_take_errors_packed(
    handle: *mut ValidatorCore,
    out_buf: *mut u32,
    max_pairs: u32,
) -> u32 {
    if handle.is_null() || out_buf.is_null() || max_pairs == 0 {
        return 0;
    }
    let engine = &mut *handle;
    let packed = engine.take_errors_packed(max_pairs);
    let pairs = (packed.len() / 2) as u32;
    let slot = std::slice::from_raw_parts_mut(out_buf, packed.len());
    slot.copy_from_slice(&packed);
    pairs
}

// ── Metadata ─────────────────────────────────────────────────────────────────

/// Returns schema column names as a JSON array string (e.g. ["name","email"]).
/// Caller must free the returned string with iv_free_string.
/// Returns NULL if handle is NULL.
///
/// # Safety
/// `handle` must be NULL or a live engine pointer; free the result with `iv_free_string`.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_schema_columns_json(
    handle: *const ValidatorCore,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    to_c_string((*handle).schema_columns_json())
}

/// Returns input (CSV/XLSX header) column names as a JSON array string.
/// Empty array if has_headers=false or the header has not been parsed yet.
/// Caller must free the returned string with iv_free_string.
///
/// # Safety
/// `handle` must be NULL or a live engine pointer; free the result with `iv_free_string`.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_input_columns_json(handle: *const ValidatorCore) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    to_c_string((*handle).input_columns_json())
}

/// Total data rows processed so far (header excluded).
///
/// # Safety
/// `handle` must be NULL or a live engine pointer.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_rows_processed(handle: *const ValidatorCore) -> u32 {
    if handle.is_null() {
        return 0;
    }
    (*handle).rows_processed()
}

/// Maps an error code byte to its stable string name (e.g. code 2 → "InvalidType").
/// Caller must free the returned string with iv_free_string.
///
/// # Safety
/// Always safe to call; free the result with `iv_free_string`.
#[no_mangle]
pub unsafe extern "C" fn iv_error_code_to_string(code: u8) -> *mut c_char {
    to_c_string(ValidatorCore::error_code_to_string(code).to_string())
}

// ── Normalized output ────────────────────────────────────────────────────────

/// Drain normalized CSV bytes accumulated so far (if emit_normalized was enabled).
///
/// Sets `*out_len` to the number of bytes.
/// Returns a heap-allocated pointer to the bytes, or NULL if none are available.
/// Caller must free the returned pointer with iv_free_bytes(ptr, *out_len).
///
/// # Safety
/// `handle` must be NULL or a live engine pointer; `out_len`, when non-NULL, must be writable. Free the result with `iv_free_bytes`.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_take_normalized(
    handle: *mut ValidatorCore,
    out_len: *mut u32,
) -> *mut u8 {
    if handle.is_null() || out_len.is_null() {
        return ptr::null_mut();
    }
    let bytes = (*handle).take_normalized();
    if bytes.is_empty() {
        *out_len = 0;
        return ptr::null_mut();
    }
    let len = bytes.len();
    *out_len = len as u32;
    // into_boxed_slice shrinks to len == capacity, so the thin pointer covers exactly len bytes.
    let boxed: Box<[u8]> = bytes.into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

// ── Memory management ────────────────────────────────────────────────────────

/// Free a string returned by any iv_* function (except iv_version).
/// Passing NULL is a no-op.
///
/// # Safety
/// `ptr` must be NULL or a pointer previously returned by an `iv_*` string function, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn iv_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// Free bytes returned by iv_engine_take_normalized.
/// `ptr` and `len` must match the values returned by that call.
/// Passing NULL is a no-op.
///
/// # Safety
/// `ptr`/`len` must be NULL/0 or exactly the pair returned by `iv_engine_take_normalized`, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn iv_free_bytes(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            ptr,
            len as usize,
        )));
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

unsafe fn write_progress(out: *mut IvProgress, rows: u32, errors: u32, final_chunk: u8) {
    if out.is_null() {
        return;
    }
    (*out).rows_processed = rows;
    (*out).errors_added = errors;
    (*out).done = if final_chunk != 0 { 1 } else { 0 };
    (*out)._pad = [0u8; 3];
}

unsafe fn write_err(buf: *mut c_char, buf_len: u32, msg: &str) {
    if buf.is_null() || buf_len == 0 {
        return;
    }
    let bytes = msg.as_bytes();
    let n = bytes.len().min(buf_len as usize - 1);
    ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, n);
    *buf.add(n) = 0;
}

fn to_c_string(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_csv_roundtrip_smoke() {
        let schema = CString::new(
            r#"{"hasHeaders":true,"columns":[{"name":"id","type":"int","required":true}]}"#,
        )
        .unwrap();
        let mut err_buf = [0 as c_char; 256];
        unsafe {
            let engine = iv_engine_new(schema.as_ptr(), 100, 0, err_buf.as_mut_ptr(), 256);
            assert!(!engine.is_null());

            let csv = b"id\n1\nnope\n";
            let mut progress = IvProgress {
                rows_processed: 0,
                errors_added: 0,
                done: 0,
                _pad: [0; 3],
            };
            let rc = iv_engine_push_chunk(engine, csv.as_ptr(), csv.len() as u32, 1, &mut progress);
            assert_eq!(rc, 0);
            assert_eq!(progress.rows_processed, 2);
            assert_eq!(progress.errors_added, 1);
            assert_eq!(iv_engine_errors_count(engine), 1);

            let mut out = [0u32; 4];
            let pairs = iv_engine_take_errors_packed(engine, out.as_mut_ptr(), 2);
            assert_eq!(pairs, 1);
            assert_eq!(out[0], 2); // row 2
            assert_eq!(out[1] & 0xff, 2); // InvalidType

            iv_engine_destroy(engine);
        }
    }

    #[test]
    fn ffi_version_is_stable_static() {
        unsafe {
            let v1 = iv_version();
            let v2 = iv_version();
            assert_eq!(v1, v2);
            assert!(!CStr::from_ptr(v1).to_str().unwrap().is_empty());
        }
    }
}
