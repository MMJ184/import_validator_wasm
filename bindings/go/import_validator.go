// Copyright (c) 2025-2026 Maulik Mangukiya. All rights reserved. See LICENSE.

// Package importvalidator provides Go bindings for the ImportValidator native library.
//
// Build requirements:
//   - Native library built with: ./scripts/build-native.sh
//     (produces libimport_validator.dylib / libimport_validator.so / import_validator.dll)
//   - CGO_ENABLED=1 (default)
//
// Set the library and include paths before building your Go program:
//
//	export LIBRARY_PATH=/path/to/crates/validator/target/release
//	export DYLD_LIBRARY_PATH=$LIBRARY_PATH   # macOS
//	export LD_LIBRARY_PATH=$LIBRARY_PATH     # Linux
//
// Example:
//
//	import iv "github.com/mmj/import-validator/bindings/go"
//
//	engine, err := iv.NewEngine(schemaJSON, 10000, false)
//	if err != nil { log.Fatal(err) }
//	defer engine.Close()
//
//	if _, err := engine.PushChunk(csvBytes, true); err != nil { ... }
//	errors := engine.TakeErrors(10000)
package importvalidator

/*
#cgo LDFLAGS: -limport_validator
#include "../include/import_validator.h"
#include <stdlib.h>
*/
import "C"
import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"unsafe"
)

// Version is the version of these Go bindings.
const Version = "0.2.0"

const errBufLen = 1024

// ValidationError is a single decoded validation error.
type ValidationError struct {
	Row        uint32  `json:"row"`        // 1-based data row number (0 = header row)
	Col        uint32  `json:"col"`        // 0-based column index
	Kind       string  `json:"kind"`       // "schema" or "input"
	Code       uint8   `json:"code"`       // numeric error code
	CodeName   string  `json:"codeName"`   // e.g. "InvalidType"
	ColumnName *string `json:"columnName"` // resolved column name (nil if out of range)
	Message    string  `json:"message"`    // human-readable message
}

func (e ValidationError) String() string {
	return fmt.Sprintf("row=%d col=%d [%s] %s (%d)", e.Row, e.Col, e.Kind, e.CodeName, e.Code)
}

// ChunkProgress holds per-chunk row and error counts.
type ChunkProgress struct {
	RowsProcessed uint32
	ErrorsAdded   uint32
	Done          bool
}

// ValidationResult holds the outcome of a full validate* call.
type ValidationResult struct {
	Errors        []ValidationError
	SchemaColumns []string
	InputColumns  []string
	Normalized    []byte // populated when emitNormalized=true
	Valid         bool
	// ErrorsSuppressed counts errors found but not recorded because maxErrors
	// was already reached. Every row is always read and validated, so
	// len(Errors) + ErrorsSuppressed is the exact number of problems in the file.
	ErrorsSuppressed uint64
}

// Engine is a streaming CSV/XLSX validation engine.
//
// An engine validates exactly ONE stream — either CSV bytes via PushChunk, or
// XLSX via PushSharedStringsChunk/PushSheetChunk (or the one-shot
// ValidateXlsxBytes). Create a new engine per file.
//
// Always call Close() or use defer engine.Close().
type Engine struct {
	handle C.IvEngine
}

// NewEngine creates a new validation engine from a JSON schema string.
//
//	schemaJSON     — JSON matching the schema contract (docs/validation-config.schema.json).
//	maxErrors      — stop RECORDING errors after this many. Every row is still
//	                 read, counted and validated; extra errors are tallied in
//	                 ErrorsSuppressed.
//	emitNormalized — set true to collect normalised CSV bytes.
func NewEngine(schemaJSON string, maxErrors uint32, emitNormalized bool) (*Engine, error) {
	schema := C.CString(schemaJSON)
	defer C.free(unsafe.Pointer(schema))

	errBuf := make([]byte, errBufLen)
	emitNorm := C.uint8_t(0)
	if emitNormalized {
		emitNorm = 1
	}

	handle := C.iv_engine_new(
		schema,
		C.uint32_t(maxErrors),
		emitNorm,
		(*C.char)(unsafe.Pointer(&errBuf[0])),
		C.uint32_t(uint32(len(errBuf))),
	)
	if handle == nil {
		return nil, fmt.Errorf("iv_engine_new: %s", errBufMessage(errBuf))
	}
	return &Engine{handle: handle}, nil
}

// EngineVersion returns the native engine version string (from iv_version).
func EngineVersion() string {
	// Static storage — must NOT be freed.
	return C.GoString(C.iv_version())
}

// Close destroys the engine and releases its native memory.
func (e *Engine) Close() {
	if e.handle != nil {
		C.iv_engine_destroy(e.handle)
		e.handle = nil
	}
}

// ── Processing: CSV ──────────────────────────────────────────────────────────

// PushChunk feeds a CSV chunk to the engine.
// Set final=true on the last chunk to flush the CSV parser.
func (e *Engine) PushChunk(chunk []byte, final bool) (ChunkProgress, error) {
	var prog C.IvProgress
	finalByte := C.uint8_t(0)
	if final {
		finalByte = 1
	}

	var dataPtr *C.uint8_t
	if len(chunk) > 0 {
		dataPtr = (*C.uint8_t)(unsafe.Pointer(&chunk[0]))
	}

	ret := C.iv_engine_push_chunk(
		e.handle,
		dataPtr,
		C.uint32_t(uint32(len(chunk))),
		finalByte,
		&prog,
	)
	if ret != 0 {
		return ChunkProgress{}, fmt.Errorf("iv_engine_push_chunk returned %d", int32(ret))
	}
	return progressFromC(&prog), nil
}

// ── Processing: XLSX ─────────────────────────────────────────────────────────

// PushSharedStringsChunk feeds a chunk of decompressed xl/sharedStrings.xml to
// the engine. Must complete (final=true) BEFORE the first PushSheetChunk call.
func (e *Engine) PushSharedStringsChunk(chunk []byte, final bool) error {
	errBuf := make([]byte, errBufLen)
	finalByte := C.uint8_t(0)
	if final {
		finalByte = 1
	}

	var dataPtr *C.uint8_t
	if len(chunk) > 0 {
		dataPtr = (*C.uint8_t)(unsafe.Pointer(&chunk[0]))
	}

	ret := C.iv_engine_push_shared_strings_chunk(
		e.handle,
		dataPtr,
		C.uint32_t(uint32(len(chunk))),
		finalByte,
		(*C.char)(unsafe.Pointer(&errBuf[0])),
		C.uint32_t(uint32(len(errBuf))),
	)
	if ret != 0 {
		return fmt.Errorf("iv_engine_push_shared_strings_chunk: %s", nativeCallError(int32(ret), errBuf))
	}
	return nil
}

// PushSheetChunk feeds a chunk of decompressed worksheet XML
// (xl/worksheets/sheetN.xml). Rows validate exactly like CSV rows.
// Set final=true on the last chunk.
func (e *Engine) PushSheetChunk(chunk []byte, final bool) (ChunkProgress, error) {
	var prog C.IvProgress
	errBuf := make([]byte, errBufLen)
	finalByte := C.uint8_t(0)
	if final {
		finalByte = 1
	}

	var dataPtr *C.uint8_t
	if len(chunk) > 0 {
		dataPtr = (*C.uint8_t)(unsafe.Pointer(&chunk[0]))
	}

	ret := C.iv_engine_push_sheet_chunk(
		e.handle,
		dataPtr,
		C.uint32_t(uint32(len(chunk))),
		finalByte,
		&prog,
		(*C.char)(unsafe.Pointer(&errBuf[0])),
		C.uint32_t(uint32(len(errBuf))),
	)
	if ret != 0 {
		return ChunkProgress{}, fmt.Errorf("iv_engine_push_sheet_chunk: %s", nativeCallError(int32(ret), errBuf))
	}
	return progressFromC(&prog), nil
}

// ValidateXlsxBytes validates a complete .xlsx workbook from a byte buffer.
// The engine parses the ZIP container, streams shared strings, then streams
// the first worksheet.
func (e *Engine) ValidateXlsxBytes(xlsx []byte) (ChunkProgress, error) {
	var prog C.IvProgress
	errBuf := make([]byte, errBufLen)

	var dataPtr *C.uint8_t
	if len(xlsx) > 0 {
		dataPtr = (*C.uint8_t)(unsafe.Pointer(&xlsx[0]))
	}

	ret := C.iv_engine_validate_xlsx_bytes(
		e.handle,
		dataPtr,
		C.uint32_t(uint32(len(xlsx))),
		&prog,
		(*C.char)(unsafe.Pointer(&errBuf[0])),
		C.uint32_t(uint32(len(errBuf))),
	)
	if ret != 0 {
		return ChunkProgress{}, fmt.Errorf("iv_engine_validate_xlsx_bytes: %s", nativeCallError(int32(ret), errBuf))
	}
	return progressFromC(&prog), nil
}

// ── Error draining ───────────────────────────────────────────────────────────

// ErrorsCount returns how many errors are queued without draining.
func (e *Engine) ErrorsCount() uint32 {
	return uint32(C.iv_engine_errors_count(e.handle))
}

// ErrorsSuppressed returns how many errors were found but not queued because
// the queue was already at maxErrors. maxErrors caps how many errors are
// recorded, never which rows are read or validated, so drained errors plus
// this is the exact number of problems in the file.
func (e *Engine) ErrorsSuppressed() uint64 {
	return uint64(C.iv_engine_errors_suppressed(e.handle))
}

// TakeErrors drains up to maxPairs errors and returns decoded ValidationErrors.
func (e *Engine) TakeErrors(maxPairs uint32) []ValidationError {
	if maxPairs == 0 {
		return nil
	}
	buf := make([]C.uint32_t, maxPairs*2)
	pairs := uint32(C.iv_engine_take_errors_packed(e.handle, &buf[0], C.uint32_t(maxPairs)))
	out := make([]ValidationError, 0, pairs)
	if pairs == 0 {
		return out
	}
	// Resolve column names once per drain call, not per error.
	schemaCols := e.SchemaColumns()
	inputCols := e.InputColumns()
	for i := uint32(0); i < pairs; i++ {
		word0 := uint32(buf[i*2])
		word1 := uint32(buf[i*2+1])
		code := uint8(word1 & 0xFF)
		col := (word1 >> 8) & 0x7FFFFF
		kind := "schema"
		cols := schemaCols
		if (word1>>31)&1 == 1 {
			kind = "input"
			cols = inputCols
		}
		var columnName *string
		if int(col) < len(cols) {
			name := cols[col]
			columnName = &name
		}
		codeName := ErrorCodeName(code)
		out = append(out, ValidationError{
			Row:        word0,
			Col:        col,
			Kind:       kind,
			Code:       code,
			CodeName:   codeName,
			ColumnName: columnName,
			Message:    errorMessage(word0, codeName, columnName),
		})
	}
	return out
}

// ── Metadata ─────────────────────────────────────────────────────────────────

// SchemaColumns returns schema column names in schema order.
func (e *Engine) SchemaColumns() []string {
	cstr := C.iv_engine_schema_columns_json(e.handle)
	return takeJSONStringSlice(cstr)
}

// InputColumns returns input (CSV/XLSX header) column names in input order.
func (e *Engine) InputColumns() []string {
	cstr := C.iv_engine_input_columns_json(e.handle)
	return takeJSONStringSlice(cstr)
}

// RowsProcessed returns the total data rows processed so far (header excluded).
func (e *Engine) RowsProcessed() uint32 {
	return uint32(C.iv_engine_rows_processed(e.handle))
}

// TakeNormalized drains accumulated normalised CSV bytes.
func (e *Engine) TakeNormalized() []byte {
	var outLen C.uint32_t
	ptr := C.iv_engine_take_normalized(e.handle, &outLen)
	if ptr == nil || outLen == 0 {
		return nil
	}
	length := uint32(outLen)
	data := C.GoBytes(unsafe.Pointer(ptr), C.int(length))
	C.iv_free_bytes(ptr, outLen)
	return data
}

// ── Convenience functions ────────────────────────────────────────────────────

// ValidateFile validates a CSV file at the given path.
// chunkSize=0 uses a default of 256 KiB.
func ValidateFile(filePath, schemaJSON string, maxErrors uint32, emitNormalized bool, chunkSize int) (*ValidationResult, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ValidateReader(f, schemaJSON, maxErrors, emitNormalized, chunkSize)
}

// ValidateBytes validates an in-memory CSV byte slice.
func ValidateBytes(csvBytes []byte, schemaJSON string, maxErrors uint32, emitNormalized bool) (*ValidationResult, error) {
	engine, err := NewEngine(schemaJSON, maxErrors, emitNormalized)
	if err != nil {
		return nil, err
	}
	defer engine.Close()

	const chunkSize = 256 * 1024
	var normParts [][]byte
	for off := 0; off < len(csvBytes); {
		end := off + chunkSize
		if end > len(csvBytes) {
			end = len(csvBytes)
		}
		final := end >= len(csvBytes)
		if _, err := engine.PushChunk(csvBytes[off:end], final); err != nil {
			return nil, err
		}
		normParts = drainNormalized(engine, emitNormalized, normParts)
		off = end
	}
	if len(csvBytes) == 0 {
		if _, err := engine.PushChunk(nil, true); err != nil {
			return nil, err
		}
	}
	return collectResult(engine, maxErrors, emitNormalized, normParts), nil
}

// ValidateReader validates CSV from any io.Reader.
// chunkSize=0 uses a default of 256 KiB.
func ValidateReader(r io.Reader, schemaJSON string, maxErrors uint32, emitNormalized bool, chunkSize int) (*ValidationResult, error) {
	engine, err := NewEngine(schemaJSON, maxErrors, emitNormalized)
	if err != nil {
		return nil, err
	}
	defer engine.Close()

	if chunkSize <= 0 {
		chunkSize = 256 * 1024
	}
	buf := make([]byte, chunkSize)
	var normParts [][]byte
	for {
		n, readErr := r.Read(buf)
		final := readErr == io.EOF
		if n > 0 {
			if _, pushErr := engine.PushChunk(buf[:n], final); pushErr != nil {
				return nil, pushErr
			}
		} else if final {
			if _, pushErr := engine.PushChunk(nil, true); pushErr != nil {
				return nil, pushErr
			}
		}
		normParts = drainNormalized(engine, emitNormalized, normParts)
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, readErr
		}
	}
	return collectResult(engine, maxErrors, emitNormalized, normParts), nil
}

// ValidateXlsxBytes validates a complete in-memory .xlsx workbook.
func ValidateXlsxBytes(xlsxBytes []byte, schemaJSON string, maxErrors uint32, emitNormalized bool) (*ValidationResult, error) {
	engine, err := NewEngine(schemaJSON, maxErrors, emitNormalized)
	if err != nil {
		return nil, err
	}
	defer engine.Close()

	if _, err := engine.ValidateXlsxBytes(xlsxBytes); err != nil {
		return nil, err
	}
	return collectResult(engine, maxErrors, emitNormalized, nil), nil
}

// ValidateXlsxFile validates an .xlsx file at the given path.
func ValidateXlsxFile(filePath, schemaJSON string, maxErrors uint32, emitNormalized bool) (*ValidationResult, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	return ValidateXlsxBytes(data, schemaJSON, maxErrors, emitNormalized)
}

// ErrorCodeName returns the stable string name for a numeric error code.
func ErrorCodeName(code uint8) string {
	ptr := C.iv_error_code_to_string(C.uint8_t(code))
	if ptr == nil {
		return "Unknown"
	}
	s := C.GoString((*C.char)(unsafe.Pointer(ptr)))
	C.iv_free_string((*C.char)(unsafe.Pointer(ptr)))
	return s
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func progressFromC(prog *C.IvProgress) ChunkProgress {
	return ChunkProgress{
		RowsProcessed: uint32(prog.rows_processed),
		ErrorsAdded:   uint32(prog.errors_added),
		Done:          prog.done != 0,
	}
}

// collectResult assembles the final result. normParts holds normalised bytes
// already drained during streaming; anything the final flush emitted is picked
// up here.
func collectResult(engine *Engine, maxErrors uint32, emitNormalized bool, normParts [][]byte) *ValidationResult {
	errors := drainAllErrors(engine, maxErrors)
	normParts = drainNormalized(engine, emitNormalized, normParts)
	suppressed := engine.ErrorsSuppressed()
	return &ValidationResult{
		Errors:        errors,
		SchemaColumns: engine.SchemaColumns(),
		InputColumns:  engine.InputColumns(),
		Normalized:    joinNormalized(normParts),
		// Suppressed errors still make a file invalid: with maxErrors == 0
		// nothing is drained, and reporting Valid here would be plainly wrong.
		Valid:            len(errors) == 0 && suppressed == 0,
		ErrorsSuppressed: suppressed,
	}
}

// drainNormalized appends the normalised bytes accumulated so far to parts.
// Draining after every chunk keeps the engine's native buffer small: it never
// holds the whole normalised output, which halves peak memory and avoids one
// large copy out of native memory at the end.
func drainNormalized(engine *Engine, emitNormalized bool, parts [][]byte) [][]byte {
	if !emitNormalized {
		return parts
	}
	if part := engine.TakeNormalized(); len(part) > 0 {
		parts = append(parts, part)
	}
	return parts
}

// joinNormalized concatenates per-chunk normalised buffers into one slice.
func joinNormalized(parts [][]byte) []byte {
	switch len(parts) {
	case 0:
		return nil
	case 1:
		return parts[0]
	}
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	out := make([]byte, 0, total)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// drainAllErrors drains the error queue in bounded batches until it is empty,
// so a large maxErrors does not force one oversized scratch buffer.
// Errors are deliberately NOT drained per chunk. The engine always reads,
// counts and validates every row — maxErrors only caps how many errors it
// records — so draining mid-stream would free queue slots and let this binding
// return more than maxErrors errors for one file. Draining only at the end
// keeps maxErrors an effective per-file total; every error past it is counted
// in ErrorsSuppressed rather than lost silently.
func drainAllErrors(engine *Engine, maxErrors uint32) []ValidationError {
	if maxErrors == 0 {
		return nil
	}
	batch := uint32(4096)
	if maxErrors < batch {
		batch = maxErrors
	}
	out := make([]ValidationError, 0, batch)
	for engine.ErrorsCount() > 0 {
		got := engine.TakeErrors(batch)
		if len(got) == 0 {
			break
		}
		out = append(out, got...)
	}
	return out
}

// errBufMessage extracts the NUL-terminated message from a C error buffer.
func errBufMessage(errBuf []byte) string {
	end := 0
	for end < len(errBuf) && errBuf[end] != 0 {
		end++
	}
	return string(errBuf[:end])
}

// nativeCallError renders the err_buf message for a non-zero return code.
func nativeCallError(ret int32, errBuf []byte) string {
	if msg := errBufMessage(errBuf); msg != "" {
		return msg
	}
	if ret == -1 {
		return "nil engine handle or missing input"
	}
	return fmt.Sprintf("native call failed (code %d)", ret)
}

// errorMessage renders the human-readable message for a decoded error.
// Wording matches the TypeScript SDK (packages/core decodePackedErrors).
func errorMessage(row uint32, codeName string, columnName *string) string {
	where := "Header"
	if row != 0 {
		where = fmt.Sprintf("Row %d", row)
	}
	colPart := ""
	if columnName != nil && *columnName != "" {
		colPart = `, column "` + *columnName + `"`
	}

	switch codeName {
	case "MissingRequiredColumn":
		return where + colPart + ": missing required column"
	case "ExtraColumn":
		return where + colPart + ": extra column not allowed"
	case "ColumnCountMismatch":
		return where + ": column count does not match configured totalColumns"
	case "MissingRequired":
		return where + colPart + ": value is required"
	case "InvalidType":
		return where + colPart + ": invalid type"
	case "MaxLengthExceeded":
		return where + colPart + ": exceeds max length"
	case "MinLengthNotMet":
		return where + colPart + ": below minimum length"
	case "NotAllowed":
		return where + colPart + ": value not allowed"
	case "InvalidEmail":
		return where + colPart + ": invalid email format"
	case "PatternMismatch":
		return where + colPart + ": does not match required pattern"
	case "PrecisionExceeded":
		return where + colPart + ": decimal precision exceeded"
	case "InvalidUtf8":
		return where + colPart + ": invalid text encoding"
	case "DuplicateValue":
		return where + colPart + ": duplicate value not allowed"
	case "DuplicateCombination":
		return where + colPart + ": duplicate combination not allowed"
	default:
		return where + colPart + ": validation error"
	}
}

func takeJSONStringSlice(cstr *C.char) []string {
	if cstr == nil {
		return nil
	}
	s := C.GoString(cstr)
	C.iv_free_string(cstr)
	var out []string
	_ = json.Unmarshal([]byte(s), &out)
	return out
}
