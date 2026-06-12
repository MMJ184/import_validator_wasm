// Package importvalidator provides Go bindings for the ImportValidator native library.
//
// Build requirements:
//   - Native library built with: ./scripts/build-native.sh
//   - CGO_ENABLED=1 (default)
//
// Set the library and include paths before building your Go program:
//
//   export LIBRARY_PATH=/path/to/crates/validator/target/release
//   export DYLD_LIBRARY_PATH=$LIBRARY_PATH   # macOS
//   export LD_LIBRARY_PATH=$LIBRARY_PATH     # Linux
//
// Example:
//
//   import iv "github.com/yourorg/import-validator/bindings/go"
//
//   engine, err := iv.NewEngine(schemaJSON, 10000, false)
//   if err != nil { log.Fatal(err) }
//   defer engine.Close()
//
//   if err := engine.PushChunk(csvBytes, true); err != nil { ... }
//   errors := engine.TakeErrors(10000)
package importvalidator

/*
#cgo LDFLAGS: -limport_validator_wasm
#include "../../include/import_validator.h"
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

// ValidationError is a single decoded validation error.
type ValidationError struct {
	Row      uint32 `json:"row"`
	Col      uint32 `json:"col"`
	Kind     string `json:"kind"`     // "schema" or "input"
	Code     uint8  `json:"code"`     // numeric error code
	CodeName string `json:"codeName"` // e.g. "InvalidType"
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
}

// Engine is a streaming CSV validation engine.
// Always call Close() or use defer engine.Close().
type Engine struct {
	handle C.IvEngine
}

// NewEngine creates a new validation engine from a JSON schema string.
//
//	schemaJSON     — JSON matching the schema contract (docs/validation-config.schema.json).
//	maxErrors      — stop collecting errors after this many.
//	emitNormalized — set true to collect normalised CSV bytes.
func NewEngine(schemaJSON string, maxErrors uint32, emitNormalized bool) (*Engine, error) {
	schema := C.CString(schemaJSON)
	defer C.free(unsafe.Pointer(schema))

	errBuf := make([]byte, 512)
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
		// find NUL terminator
		end := 0
		for end < len(errBuf) && errBuf[end] != 0 {
			end++
		}
		return nil, fmt.Errorf("iv_engine_new: %s", string(errBuf[:end]))
	}
	return &Engine{handle: handle}, nil
}

// Close destroys the engine and releases its native memory.
func (e *Engine) Close() {
	if e.handle != nil {
		C.iv_engine_destroy(e.handle)
		e.handle = nil
	}
}

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
		return ChunkProgress{}, fmt.Errorf("iv_engine_push_chunk returned %d", ret)
	}
	return ChunkProgress{
		RowsProcessed: uint32(prog.rows_processed),
		ErrorsAdded:   uint32(prog.errors_added),
		Done:          prog.done != 0,
	}, nil
}

// ErrorsCount returns how many errors are queued without draining.
func (e *Engine) ErrorsCount() uint32 {
	return uint32(C.iv_engine_errors_count(e.handle))
}

// TakeErrors drains up to maxPairs errors and returns decoded ValidationErrors.
func (e *Engine) TakeErrors(maxPairs uint32) []ValidationError {
	if maxPairs == 0 {
		return nil
	}
	buf := make([]C.uint32_t, maxPairs*2)
	pairs := uint32(C.iv_engine_take_errors_packed(e.handle, &buf[0], C.uint32_t(maxPairs)))
	out := make([]ValidationError, 0, pairs)
	for i := uint32(0); i < pairs; i++ {
		word0 := uint32(buf[i*2])
		word1 := uint32(buf[i*2+1])
		code := uint8(word1 & 0xFF)
		col := (word1 >> 8) & 0x7FFFFF
		kind := "schema"
		if (word1>>31)&1 == 1 {
			kind = "input"
		}
		out = append(out, ValidationError{
			Row:      word0,
			Col:      col,
			Kind:     kind,
			Code:     code,
			CodeName: ErrorCodeName(code),
		})
	}
	return out
}

// SchemaColumns returns schema column names in schema order.
func (e *Engine) SchemaColumns() []string {
	cstr := C.iv_engine_schema_columns_json(e.handle)
	return takeJSONStringSlice(cstr)
}

// InputColumns returns input CSV header column names.
func (e *Engine) InputColumns() []string {
	cstr := C.iv_engine_input_columns_json(e.handle)
	return takeJSONStringSlice(cstr)
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
	for off := 0; off < len(csvBytes); {
		end := off + chunkSize
		if end > len(csvBytes) {
			end = len(csvBytes)
		}
		final := end >= len(csvBytes)
		if _, err := engine.PushChunk(csvBytes[off:end], final); err != nil {
			return nil, err
		}
		off = end
	}
	if len(csvBytes) == 0 {
		if _, err := engine.PushChunk(nil, true); err != nil {
			return nil, err
		}
	}
	return collectResult(engine, emitNormalized), nil
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
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, readErr
		}
	}
	return collectResult(engine, emitNormalized), nil
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

func collectResult(engine *Engine, emitNormalized bool) *ValidationResult {
	errors := engine.TakeErrors(100_000)
	var norm []byte
	if emitNormalized {
		norm = engine.TakeNormalized()
	}
	return &ValidationResult{
		Errors:        errors,
		SchemaColumns: engine.SchemaColumns(),
		InputColumns:  engine.InputColumns(),
		Normalized:    norm,
		Valid:         len(errors) == 0,
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
