// C-ABI bindings for native (non-WASM) targets: Python, C#, Go, etc.
// This module is excluded entirely from WASM builds via the cfg gate in lib.rs.

use super::ValidatorEngine;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

/// Progress snapshot returned by iv_engine_push_chunk via out-parameter.
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

/// Create a new ValidatorEngine.
///
/// `schema_json`      NUL-terminated UTF-8 JSON matching the schema contract.
/// `max_errors`       Stop accumulating errors after this many (prevents unbounded memory).
/// `emit_normalized`  1 to collect normalized CSV output, 0 to disable.
/// `err_buf`          Caller-allocated buffer for an error message on failure (may be NULL).
/// `err_buf_len`      Byte capacity of err_buf (including NUL terminator).
///
/// Returns an opaque engine handle on success, NULL on failure.
/// Destroy with iv_engine_destroy when done.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_new(
    schema_json: *const c_char,
    max_errors: u32,
    emit_normalized: u8,
    err_buf: *mut c_char,
    err_buf_len: u32,
) -> *mut ValidatorEngine {
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
    match ValidatorEngine::new(schema_str, max_errors, emit_normalized != 0) {
        Ok(engine) => Box::into_raw(Box::new(engine)),
        Err(jsval) => {
            let msg = jsval
                .as_string()
                .unwrap_or_else(|| "engine initialization failed".to_string());
            write_err(err_buf, err_buf_len, &msg);
            ptr::null_mut()
        }
    }
}

/// Destroy an engine and release all its memory.
/// Passing NULL is a no-op.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_destroy(handle: *mut ValidatorEngine) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

// ── Processing ───────────────────────────────────────────────────────────────

/// Push a CSV chunk into the engine.
///
/// `chunk_ptr`     Pointer to chunk bytes. May be NULL when chunk_len == 0.
/// `chunk_len`     Number of bytes in the chunk.
/// `final_chunk`   Non-zero to signal end-of-stream and flush the CSV parser.
/// `out_progress`  Filled with row/error progress for this chunk. May be NULL.
///
/// Returns 0 on success, -1 if handle is NULL.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_push_chunk(
    handle: *mut ValidatorEngine,
    chunk_ptr: *const u8,
    chunk_len: u32,
    final_chunk: u8,
    out_progress: *mut IvProgress,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let engine = &mut *handle;
    let before_errs = engine.errors.len() as u32;
    let before_rows = engine.data_row;

    if chunk_len > 0 && !chunk_ptr.is_null() {
        let chunk = std::slice::from_raw_parts(chunk_ptr, chunk_len as usize);
        engine.parse_slice(chunk);
    }
    if final_chunk != 0 {
        engine.flush_end();
    }

    if !out_progress.is_null() {
        (*out_progress).rows_processed = engine.data_row.saturating_sub(before_rows);
        (*out_progress).errors_added = (engine.errors.len() as u32).saturating_sub(before_errs);
        (*out_progress).done = if final_chunk != 0 { 1 } else { 0 };
        (*out_progress)._pad = [0u8; 3];
    }
    0
}

// ── Error draining ───────────────────────────────────────────────────────────

/// Returns the number of errors currently queued (without draining).
#[no_mangle]
pub unsafe extern "C" fn iv_engine_errors_count(handle: *const ValidatorEngine) -> u32 {
    if handle.is_null() {
        return 0;
    }
    (*handle).errors_count()
}

/// Drain up to `max_pairs` errors into `out_buf`.
///
/// Each error occupies two consecutive u32 slots:
///   out_buf[i*2 + 0] = row  (1-based data row number)
///   out_buf[i*2 + 1] = pack = (kind_bit:1)(col:23)(code:8)
///     kind_bit: 1 = input-column index, 0 = schema-column index
///
/// `out_buf` must be large enough for (max_pairs * 2) u32 values.
/// Returns the number of error pairs actually written.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_take_errors_packed(
    handle: *mut ValidatorEngine,
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
#[no_mangle]
pub unsafe extern "C" fn iv_engine_schema_columns_json(
    handle: *const ValidatorEngine,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    to_c_string((*handle).schema_columns_json())
}

/// Returns input (CSV header) column names as a JSON array string.
/// Empty array if has_headers=false or the header has not been parsed yet.
/// Caller must free the returned string with iv_free_string.
#[no_mangle]
pub unsafe extern "C" fn iv_engine_input_columns_json(
    handle: *const ValidatorEngine,
) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    to_c_string((*handle).input_columns_json())
}

/// Maps an error code byte to its stable string name (e.g. code 2 → "InvalidType").
/// Caller must free the returned string with iv_free_string.
#[no_mangle]
pub unsafe extern "C" fn iv_error_code_to_string(code: u8) -> *mut c_char {
    to_c_string(ValidatorEngine::error_code_to_string(code))
}

// ── Normalized output ────────────────────────────────────────────────────────

/// Drain normalized CSV bytes accumulated so far (if emit_normalized was enabled).
///
/// Sets `*out_len` to the number of bytes.
/// Returns a heap-allocated pointer to the bytes, or NULL if none are available.
/// Caller must free the returned pointer with iv_free_bytes(ptr, *out_len).
#[no_mangle]
pub unsafe extern "C" fn iv_engine_take_normalized(
    handle: *mut ValidatorEngine,
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

/// Free a string returned by any iv_* function.
/// Passing NULL is a no-op.
#[no_mangle]
pub unsafe extern "C" fn iv_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// Free bytes returned by iv_engine_take_normalized.
/// `ptr` and `len` must match the values returned by that call.
/// Passing NULL is a no-op.
#[no_mangle]
pub unsafe extern "C" fn iv_free_bytes(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::slice::from_raw_parts_mut(ptr, len as usize)));
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

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
