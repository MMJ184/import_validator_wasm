/**
 * import_validator.h — C header for the native ImportValidator library.
 *
 * Link against:
 *   macOS:   libimport_validator.dylib
 *   Linux:   libimport_validator.so
 *   Windows: import_validator.dll
 *
 * Build the native library:
 *   ./scripts/build-native.sh            (or: cd crates/validator && cargo build --release)
 *
 * Thread-safety: an IvEngine handle is NOT thread-safe. Use one engine per
 * concurrent validation; different engines may run on different threads.
 *
 * Input modes: an engine validates exactly ONE stream — either CSV bytes via
 * iv_engine_push_chunk, or XLSX via the shared-strings/sheet push functions
 * (or the one-shot iv_engine_validate_xlsx_bytes). Modes cannot be mixed on
 * the same engine; create a new engine per file.
 */
#ifndef IMPORT_VALIDATOR_H
#define IMPORT_VALIDATOR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Opaque engine handle. Always destroy with iv_engine_destroy. */
typedef void* IvEngine;

/**
 * Progress snapshot filled by push/validate calls.
 * rows_processed and errors_added are relative to the current call.
 * done is 1 when final_chunk was non-zero (parser has been flushed).
 */
typedef struct {
    uint32_t rows_processed;
    uint32_t errors_added;
    uint8_t  done;
    uint8_t  _pad[3];
} IvProgress;

/* ── Lifecycle ────────────────────────────────────────────────────────────── */

/**
 * Create a new engine.
 *
 * schema_json      NUL-terminated UTF-8 JSON (see docs/validation-config.schema.json).
 * max_errors       Stop accumulating errors after this many.
 * emit_normalized  1 to collect normalized CSV output, 0 to disable.
 * err_buf          Optional caller-allocated buffer for error text on failure.
 * err_buf_len      Byte size of err_buf (including NUL).
 *
 * Returns an opaque handle on success, NULL on failure.
 */
IvEngine iv_engine_new(
    const char* schema_json,
    uint32_t    max_errors,
    uint8_t     emit_normalized,
    char*       err_buf,
    uint32_t    err_buf_len
);

/** Destroy an engine and release all memory. Passing NULL is a no-op. */
void iv_engine_destroy(IvEngine handle);

/** Engine version string (static storage — do NOT free). */
const char* iv_version(void);

/* ── Processing: CSV ─────────────────────────────────────────────────────── */

/**
 * Push a CSV chunk into the engine.
 *
 * chunk_ptr     Pointer to chunk bytes (may be NULL when chunk_len == 0).
 * chunk_len     Number of bytes.
 * final_chunk   Non-zero to signal end-of-stream and flush the parser.
 * out_progress  Optional; filled with per-chunk row/error counts.
 *
 * Returns 0 on success, -1 if handle is NULL, -2 on input-mode misuse
 * (engine already consumed XLSX input).
 */
int32_t iv_engine_push_chunk(
    IvEngine          handle,
    const uint8_t*    chunk_ptr,
    uint32_t          chunk_len,
    uint8_t           final_chunk,
    IvProgress*       out_progress
);

/* ── Processing: Excel (XLSX) ────────────────────────────────────────────── */

/**
 * One-shot: validate a complete .xlsx workbook from a byte buffer. The
 * engine parses the ZIP container, streams shared strings, then streams the
 * first worksheet — peak memory tracks shared strings, not sheet size.
 *
 * Returns 0 on success, -1 if handle/bytes are NULL, -2 on failure with a
 * message written to err_buf.
 */
int32_t iv_engine_validate_xlsx_bytes(
    IvEngine       handle,
    const uint8_t* bytes_ptr,
    uint32_t       bytes_len,
    IvProgress*    out_progress,
    char*          err_buf,
    uint32_t       err_buf_len
);

/**
 * Streaming alternative when the caller does its own ZIP/DEFLATE handling:
 * push decompressed xl/sharedStrings.xml chunks (must complete with
 * final_chunk=1 BEFORE the first sheet chunk), then decompressed worksheet
 * XML chunks. Rows validate identically to CSV rows.
 *
 * Return 0 on success, -1 if handle is NULL, -2 on failure (message in err_buf).
 */
int32_t iv_engine_push_shared_strings_chunk(
    IvEngine       handle,
    const uint8_t* chunk_ptr,
    uint32_t       chunk_len,
    uint8_t        final_chunk,
    char*          err_buf,
    uint32_t       err_buf_len
);

int32_t iv_engine_push_sheet_chunk(
    IvEngine       handle,
    const uint8_t* chunk_ptr,
    uint32_t       chunk_len,
    uint8_t        final_chunk,
    IvProgress*    out_progress,
    char*          err_buf,
    uint32_t       err_buf_len
);

/* ── Error draining ──────────────────────────────────────────────────────── */

/** Number of errors queued without draining. */
uint32_t iv_engine_errors_count(IvEngine handle);

/**
 * Number of errors found but not queued because the queue was at max_errors.
 *
 * max_errors caps how many errors are kept, never which rows are read or
 * validated, so drained errors plus this is the exact number of problems in
 * the file. Use it to report "showing N of TOTAL".
 */
uint64_t iv_engine_errors_suppressed(IvEngine handle);

/**
 * Drain up to max_pairs errors into out_buf.
 *
 * Each error = two consecutive uint32_t values:
 *   [0] row  — 1-based data row number (0 = header row)
 *   [1] pack — bit layout: (kind:1)(col:23)(code:8)
 *              kind 0 = schema-column index, 1 = input-column index
 *
 * out_buf must hold at least (max_pairs * 2) uint32_t values.
 * Returns the number of pairs actually written.
 */
uint32_t iv_engine_take_errors_packed(
    IvEngine  handle,
    uint32_t* out_buf,
    uint32_t  max_pairs
);

/* ── Metadata ────────────────────────────────────────────────────────────── */

/** Schema column names as JSON array. Free with iv_free_string. */
char* iv_engine_schema_columns_json(IvEngine handle);

/** Input (CSV/XLSX header) column names as JSON array. Free with iv_free_string. */
char* iv_engine_input_columns_json(IvEngine handle);

/** Total data rows processed so far (header excluded). */
uint32_t iv_engine_rows_processed(IvEngine handle);

/** Stable name for an error code byte (e.g. 2 → "InvalidType"). Free with iv_free_string. */
char* iv_error_code_to_string(uint8_t code);

/* ── Normalized output ───────────────────────────────────────────────────── */

/**
 * Drain normalized CSV bytes accumulated so far (only when emit_normalized=1).
 *
 * Sets *out_len to the byte count.
 * Returns a heap pointer, or NULL if nothing is available.
 * Free with iv_free_bytes(ptr, *out_len).
 */
uint8_t* iv_engine_take_normalized(IvEngine handle, uint32_t* out_len);

/* ── Memory management ───────────────────────────────────────────────────── */

/** Free a string returned by any iv_* function (except iv_version). NULL is a no-op. */
void iv_free_string(char* ptr);

/** Free bytes returned by iv_engine_take_normalized. NULL is a no-op. */
void iv_free_bytes(uint8_t* ptr, uint32_t len);

#ifdef __cplusplus
}
#endif

#endif /* IMPORT_VALIDATOR_H */
