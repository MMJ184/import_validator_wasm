# Copyright (c) 2025-2026 Maulik Mangukiya. All rights reserved. See LICENSE.
"""
import_validator — Python bindings for the ImportValidator native library.

Requires the native cdylib built with:
    ./scripts/build-native.sh

Set the library path either explicitly:
    import import_validator as iv
    iv.load_library("/path/to/libimport_validator.dylib")

or via the environment variable IMPORT_VALIDATOR_LIB before importing.

Quick example (CSV):
    import json, import_validator as iv

    schema = json.dumps({
        "hasHeaders": True,
        "columns": [
            {"name": "id",    "type": "int",    "required": True},
            {"name": "email", "type": "email",  "required": True, "unique": True},
            {"name": "name",  "type": "string", "required": True},
        ]
    })

    engine = iv.Engine(schema, max_errors=1000)
    with open("data.csv", "rb") as f:
        while True:
            chunk = f.read(256 * 1024)
            if not chunk:
                engine.push_chunk(b"", final=True)
                break
            engine.push_chunk(chunk)

    for err in engine.take_errors():
        print(err.message)

Quick example (XLSX, one-shot):
    result = iv.validate_xlsx_file("data.xlsx", schema)
    for err in result.errors:
        print(err.message)
"""

import ctypes
import json
import os
import platform
from dataclasses import dataclass
from typing import Iterator, List, Optional, Tuple

__version__ = "0.2.0"

_ERR_BUF_LEN = 1024

# ── Library loading ──────────────────────────────────────────────────────────

_lib: Optional[ctypes.CDLL] = None


def _default_lib_name() -> str:
    system = platform.system()
    if system == "Darwin":
        return "libimport_validator.dylib"
    if system == "Linux":
        return "libimport_validator.so"
    if system == "Windows":
        return "import_validator.dll"
    raise RuntimeError(f"Unsupported platform: {system}")


def load_library(path: Optional[str] = None) -> ctypes.CDLL:
    """
    Load (or reload) the native library.

    path  Explicit path to the .dylib/.so/.dll.  When omitted the function
          tries IMPORT_VALIDATOR_LIB env-var, then looks next to this file,
          then falls back to LD_LIBRARY_PATH / system search.
    """
    global _lib
    if path is None:
        path = os.environ.get("IMPORT_VALIDATOR_LIB")
    if path is None:
        # Look for the library next to this Python file first.
        here = os.path.dirname(os.path.abspath(__file__))
        candidate = os.path.join(here, _default_lib_name())
        path = candidate if os.path.exists(candidate) else _default_lib_name()

    _lib = ctypes.CDLL(path)
    _configure_signatures(_lib)
    return _lib


def _get_lib() -> ctypes.CDLL:
    if _lib is None:
        load_library()
    return _lib  # type: ignore[return-value]


def _configure_signatures(lib: ctypes.CDLL) -> None:
    """Attach C type signatures to every function so ctypes checks them."""

    lib.iv_engine_new.argtypes = [
        ctypes.c_char_p,   # schema_json
        ctypes.c_uint32,   # max_errors
        ctypes.c_uint8,    # emit_normalized
        ctypes.c_char_p,   # err_buf (writable, use create_string_buffer)
        ctypes.c_uint32,   # err_buf_len
    ]
    lib.iv_engine_new.restype = ctypes.c_void_p

    lib.iv_engine_destroy.argtypes = [ctypes.c_void_p]
    lib.iv_engine_destroy.restype = None

    # Static storage — decoded via c_char_p, never freed.
    lib.iv_version.argtypes = []
    lib.iv_version.restype = ctypes.c_char_p

    lib.iv_engine_push_chunk.argtypes = [
        ctypes.c_void_p,   # handle
        ctypes.c_char_p,   # chunk_ptr
        ctypes.c_uint32,   # chunk_len
        ctypes.c_uint8,    # final_chunk
        ctypes.c_void_p,   # out_progress (pointer to IvProgress struct)
    ]
    lib.iv_engine_push_chunk.restype = ctypes.c_int32

    lib.iv_engine_validate_xlsx_bytes.argtypes = [
        ctypes.c_void_p,   # handle
        ctypes.c_char_p,   # bytes_ptr
        ctypes.c_uint32,   # bytes_len
        ctypes.c_void_p,   # out_progress
        ctypes.c_char_p,   # err_buf
        ctypes.c_uint32,   # err_buf_len
    ]
    lib.iv_engine_validate_xlsx_bytes.restype = ctypes.c_int32

    lib.iv_engine_push_shared_strings_chunk.argtypes = [
        ctypes.c_void_p,   # handle
        ctypes.c_char_p,   # chunk_ptr
        ctypes.c_uint32,   # chunk_len
        ctypes.c_uint8,    # final_chunk
        ctypes.c_char_p,   # err_buf
        ctypes.c_uint32,   # err_buf_len
    ]
    lib.iv_engine_push_shared_strings_chunk.restype = ctypes.c_int32

    lib.iv_engine_push_sheet_chunk.argtypes = [
        ctypes.c_void_p,   # handle
        ctypes.c_char_p,   # chunk_ptr
        ctypes.c_uint32,   # chunk_len
        ctypes.c_uint8,    # final_chunk
        ctypes.c_void_p,   # out_progress
        ctypes.c_char_p,   # err_buf
        ctypes.c_uint32,   # err_buf_len
    ]
    lib.iv_engine_push_sheet_chunk.restype = ctypes.c_int32

    lib.iv_engine_errors_count.argtypes = [ctypes.c_void_p]
    lib.iv_engine_errors_count.restype = ctypes.c_uint32

    lib.iv_engine_take_errors_packed.argtypes = [
        ctypes.c_void_p,                        # handle
        ctypes.POINTER(ctypes.c_uint32),         # out_buf
        ctypes.c_uint32,                         # max_pairs
    ]
    lib.iv_engine_take_errors_packed.restype = ctypes.c_uint32

    lib.iv_engine_schema_columns_json.argtypes = [ctypes.c_void_p]
    lib.iv_engine_schema_columns_json.restype = ctypes.c_void_p  # *mut c_char

    lib.iv_engine_input_columns_json.argtypes = [ctypes.c_void_p]
    lib.iv_engine_input_columns_json.restype = ctypes.c_void_p

    lib.iv_engine_rows_processed.argtypes = [ctypes.c_void_p]
    lib.iv_engine_rows_processed.restype = ctypes.c_uint32

    lib.iv_engine_take_normalized.argtypes = [
        ctypes.c_void_p,                   # handle
        ctypes.POINTER(ctypes.c_uint32),   # out_len
    ]
    lib.iv_engine_take_normalized.restype = ctypes.c_void_p  # *mut u8

    lib.iv_error_code_to_string.argtypes = [ctypes.c_uint8]
    lib.iv_error_code_to_string.restype = ctypes.c_void_p

    lib.iv_free_string.argtypes = [ctypes.c_void_p]
    lib.iv_free_string.restype = None

    lib.iv_free_bytes.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    lib.iv_free_bytes.restype = None


# ── C struct ─────────────────────────────────────────────────────────────────

class _IvProgress(ctypes.Structure):
    _fields_ = [
        ("rows_processed", ctypes.c_uint32),
        ("errors_added",   ctypes.c_uint32),
        ("done",           ctypes.c_uint8),
        ("_pad",           ctypes.c_uint8 * 3),
    ]


# ── Public data types ────────────────────────────────────────────────────────

@dataclass
class ChunkProgress:
    rows_processed: int
    errors_added: int
    done: bool


@dataclass
class ValidationError:
    """A single validation error decoded from the packed u32 pair."""
    row: int        # 1-based data row number (0 = header row)
    col: int        # 0-based column index
    kind: str       # "schema" or "input" (which column index space col refers to)
    code: int       # numeric error code
    code_name: str  # e.g. "InvalidType"
    column_name: Optional[str] = None  # resolved column name (None if out of range)
    message: str = ""                  # human-readable message

    def __str__(self) -> str:
        return f"row={self.row} col={self.col} [{self.kind}] {self.code_name} ({self.code})"


# ── Engine ───────────────────────────────────────────────────────────────────

class Engine:
    """
    Streaming CSV/XLSX validation engine wrapping the native library.

    An engine validates exactly ONE stream — either CSV bytes via push_chunk,
    or XLSX via push_shared_strings_chunk/push_sheet_chunk (or the one-shot
    validate_xlsx_bytes). Create a new engine per file.

    Usage:
        engine = Engine(schema_json, max_errors=1000, emit_normalized=False)
        engine.push_chunk(chunk1)
        engine.push_chunk(chunk2)
        progress = engine.push_chunk(last_chunk, final=True)
        errors = engine.take_errors()
        normalized_bytes = engine.take_normalized()
        engine.close()  # or use as context manager
    """

    def __init__(
        self,
        schema_json: str,
        max_errors: int = 10_000,
        emit_normalized: bool = False,
    ) -> None:
        lib = _get_lib()
        err_buf = ctypes.create_string_buffer(_ERR_BUF_LEN)
        handle = lib.iv_engine_new(
            schema_json.encode("utf-8"),
            ctypes.c_uint32(max_errors),
            ctypes.c_uint8(1 if emit_normalized else 0),
            err_buf,
            ctypes.c_uint32(_ERR_BUF_LEN),
        )
        if not handle:
            msg = err_buf.value.decode("utf-8", errors="replace")
            raise ValueError(f"Engine init failed: {msg}")
        self._handle = handle
        self._lib = lib
        self._closed = False

    # ── Context manager ──────────────────────────────────────────────────────

    def __enter__(self) -> "Engine":
        return self

    def __exit__(self, *_) -> None:
        self.close()

    def close(self) -> None:
        if not self._closed and self._handle:
            self._lib.iv_engine_destroy(self._handle)
            self._handle = None
            self._closed = True

    def __del__(self) -> None:
        self.close()

    # ── Processing: CSV ──────────────────────────────────────────────────────

    def push_chunk(self, chunk: bytes, *, final: bool = False) -> ChunkProgress:
        """
        Feed a CSV chunk to the engine.

        Set final=True on the last call to flush the CSV parser.
        Returns a ChunkProgress with row/error counts for this chunk.
        """
        self._check_open()
        prog = _IvProgress()
        ret = self._lib.iv_engine_push_chunk(
            self._handle,
            chunk or b"",
            ctypes.c_uint32(len(chunk)),
            ctypes.c_uint8(1 if final else 0),
            ctypes.byref(prog),
        )
        if ret != 0:
            raise RuntimeError("push_chunk returned error (NULL handle or input-mode misuse)")
        return ChunkProgress(
            rows_processed=prog.rows_processed,
            errors_added=prog.errors_added,
            done=bool(prog.done),
        )

    # ── Processing: XLSX ─────────────────────────────────────────────────────

    def push_shared_strings_chunk(self, chunk: bytes, *, final: bool = False) -> None:
        """
        Feed a chunk of decompressed xl/sharedStrings.xml to the engine.

        Must complete (final=True) BEFORE the first push_sheet_chunk call.
        Raises ValueError with the native error message on failure.
        """
        self._check_open()
        err_buf = ctypes.create_string_buffer(_ERR_BUF_LEN)
        ret = self._lib.iv_engine_push_shared_strings_chunk(
            self._handle,
            chunk or b"",
            ctypes.c_uint32(len(chunk)),
            ctypes.c_uint8(1 if final else 0),
            err_buf,
            ctypes.c_uint32(_ERR_BUF_LEN),
        )
        if ret != 0:
            raise ValueError(
                f"push_shared_strings_chunk failed: {_err_buf_message(err_buf, ret)}"
            )

    def push_sheet_chunk(self, chunk: bytes, *, final: bool = False) -> ChunkProgress:
        """
        Feed a chunk of decompressed worksheet XML (xl/worksheets/sheetN.xml).

        Rows validate exactly like CSV rows. Set final=True on the last call.
        Raises ValueError with the native error message on failure.
        """
        self._check_open()
        prog = _IvProgress()
        err_buf = ctypes.create_string_buffer(_ERR_BUF_LEN)
        ret = self._lib.iv_engine_push_sheet_chunk(
            self._handle,
            chunk or b"",
            ctypes.c_uint32(len(chunk)),
            ctypes.c_uint8(1 if final else 0),
            ctypes.byref(prog),
            err_buf,
            ctypes.c_uint32(_ERR_BUF_LEN),
        )
        if ret != 0:
            raise ValueError(f"push_sheet_chunk failed: {_err_buf_message(err_buf, ret)}")
        return ChunkProgress(
            rows_processed=prog.rows_processed,
            errors_added=prog.errors_added,
            done=bool(prog.done),
        )

    def validate_xlsx_bytes(self, xlsx_bytes: bytes) -> ChunkProgress:
        """
        One-shot: validate a complete .xlsx workbook from a byte buffer.

        The engine parses the ZIP container, streams shared strings, then
        streams the first worksheet. Raises ValueError with the native error
        message on failure.
        """
        self._check_open()
        prog = _IvProgress()
        err_buf = ctypes.create_string_buffer(_ERR_BUF_LEN)
        ret = self._lib.iv_engine_validate_xlsx_bytes(
            self._handle,
            xlsx_bytes,
            ctypes.c_uint32(len(xlsx_bytes)),
            ctypes.byref(prog),
            err_buf,
            ctypes.c_uint32(_ERR_BUF_LEN),
        )
        if ret != 0:
            raise ValueError(f"validate_xlsx_bytes failed: {_err_buf_message(err_buf, ret)}")
        return ChunkProgress(
            rows_processed=prog.rows_processed,
            errors_added=prog.errors_added,
            done=bool(prog.done),
        )

    # ── Error draining ───────────────────────────────────────────────────────

    @property
    def errors_count(self) -> int:
        """Number of errors queued without draining."""
        self._check_open()
        return int(self._lib.iv_engine_errors_count(self._handle))

    def take_errors(self, max_errors: int = 100_000) -> List[ValidationError]:
        """Drain and decode all queued errors (up to max_errors)."""
        self._check_open()
        buf_size = max_errors * 2
        buf = (ctypes.c_uint32 * buf_size)()
        pairs = self._lib.iv_engine_take_errors_packed(
            self._handle,
            buf,
            ctypes.c_uint32(max_errors),
        )
        if pairs == 0:
            return []
        # Resolve column names once per drain call, not per error.
        schema_cols = self.schema_columns()
        input_cols = self.input_columns()
        return [
            _decode_error(buf[i * 2], buf[i * 2 + 1], schema_cols, input_cols)
            for i in range(pairs)
        ]

    def iter_errors(self, batch_size: int = 5_000) -> Iterator[ValidationError]:
        """Lazily drain errors in batches."""
        self._check_open()
        buf_size = batch_size * 2
        buf = (ctypes.c_uint32 * buf_size)()
        cols: Optional[Tuple[List[str], List[str]]] = None
        while True:
            pairs = self._lib.iv_engine_take_errors_packed(
                self._handle,
                buf,
                ctypes.c_uint32(batch_size),
            )
            if pairs == 0:
                break
            if cols is None:
                # Resolve column names once per drain call, not per error.
                cols = (self.schema_columns(), self.input_columns())
            for i in range(pairs):
                yield _decode_error(buf[i * 2], buf[i * 2 + 1], cols[0], cols[1])

    # ── Metadata ─────────────────────────────────────────────────────────────

    def schema_columns(self) -> List[str]:
        """Schema column names in schema order."""
        self._check_open()
        ptr = self._lib.iv_engine_schema_columns_json(self._handle)
        return _take_json_list(self._lib, ptr)

    def input_columns(self) -> List[str]:
        """Input (CSV/XLSX header) column names in input order."""
        self._check_open()
        ptr = self._lib.iv_engine_input_columns_json(self._handle)
        return _take_json_list(self._lib, ptr)

    @property
    def rows_processed(self) -> int:
        """Total data rows processed so far (header excluded)."""
        self._check_open()
        return int(self._lib.iv_engine_rows_processed(self._handle))

    # ── Normalized output ────────────────────────────────────────────────────

    def take_normalized(self) -> bytes:
        """Drain normalized CSV bytes accumulated so far."""
        self._check_open()
        out_len = ctypes.c_uint32(0)
        ptr = self._lib.iv_engine_take_normalized(self._handle, ctypes.byref(out_len))
        if not ptr:
            return b""
        length = out_len.value
        data = ctypes.string_at(ptr, length)
        self._lib.iv_free_bytes(ptr, ctypes.c_uint32(length))
        return data

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("Engine has been closed")


# ── Convenience functions ────────────────────────────────────────────────────

def engine_version() -> str:
    """Native engine version string (from iv_version)."""
    lib = _get_lib()
    raw = lib.iv_version()
    return raw.decode("utf-8", errors="replace") if raw else ""


def validate_bytes(
    csv_bytes: bytes,
    schema_json: str,
    *,
    max_errors: int = 10_000,
    emit_normalized: bool = False,
    chunk_size: int = 256 * 1024,
) -> "ValidationResult":
    """Validate all of csv_bytes against schema_json in one call."""
    with Engine(schema_json, max_errors=max_errors, emit_normalized=emit_normalized) as engine:
        offset = 0
        while offset < len(csv_bytes):
            end = min(offset + chunk_size, len(csv_bytes))
            is_last = end >= len(csv_bytes)
            engine.push_chunk(csv_bytes[offset:end], final=is_last)
            offset = end
        if not csv_bytes:
            engine.push_chunk(b"", final=True)
        return _collect_result(engine, max_errors, emit_normalized)


def validate_file(
    path: str,
    schema_json: str,
    *,
    max_errors: int = 10_000,
    emit_normalized: bool = False,
    chunk_size: int = 256 * 1024,
) -> "ValidationResult":
    """Validate a CSV file at path against schema_json."""
    with Engine(schema_json, max_errors=max_errors, emit_normalized=emit_normalized) as engine:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    engine.push_chunk(b"", final=True)
                    break
                engine.push_chunk(chunk)
        return _collect_result(engine, max_errors, emit_normalized)


def validate_xlsx_bytes(
    xlsx_bytes: bytes,
    schema_json: str,
    *,
    max_errors: int = 10_000,
    emit_normalized: bool = False,
) -> "ValidationResult":
    """Validate a complete .xlsx workbook held in memory against schema_json."""
    with Engine(schema_json, max_errors=max_errors, emit_normalized=emit_normalized) as engine:
        engine.validate_xlsx_bytes(xlsx_bytes)
        return _collect_result(engine, max_errors, emit_normalized)


def validate_xlsx_file(
    path: str,
    schema_json: str,
    *,
    max_errors: int = 10_000,
    emit_normalized: bool = False,
) -> "ValidationResult":
    """Validate an .xlsx file at path against schema_json."""
    with open(path, "rb") as f:
        data = f.read()
    return validate_xlsx_bytes(
        data, schema_json, max_errors=max_errors, emit_normalized=emit_normalized
    )


@dataclass
class ValidationResult:
    errors: List[ValidationError]
    schema_columns: List[str]
    input_columns: List[str]
    normalized: bytes

    @property
    def valid(self) -> bool:
        return len(self.errors) == 0


def _collect_result(engine: Engine, max_errors: int, emit_normalized: bool) -> ValidationResult:
    schema_cols = engine.schema_columns()
    input_cols = engine.input_columns()
    errors = engine.take_errors(max_errors)
    normalized = engine.take_normalized() if emit_normalized else b""
    return ValidationResult(
        errors=errors,
        schema_columns=schema_cols,
        input_columns=input_cols,
        normalized=normalized,
    )


# ── Internal decode helpers ───────────────────────────────────────────────────

def _decode_error(
    word0: int,
    word1: int,
    schema_cols: List[str],
    input_cols: List[str],
) -> ValidationError:
    # word0 = row (1-based; 0 = header)
    # word1 = (kind:1)(col:23)(code:8)
    row = word0
    code = word1 & 0xFF
    col = (word1 >> 8) & 0x7FFFFF
    kind = "input" if (word1 >> 31) & 1 else "schema"
    code_name = error_code_name(code)
    cols = input_cols if kind == "input" else schema_cols
    column_name = cols[col] if col < len(cols) else None
    return ValidationError(
        row=row,
        col=col,
        kind=kind,
        code=code,
        code_name=code_name,
        column_name=column_name,
        message=_format_message(row, code_name, column_name),
    )


def _format_message(row: int, code_name: str, column_name: Optional[str]) -> str:
    where = "Header" if row == 0 else f"Row {row}"
    col_part = f', column "{column_name}"' if column_name else ""

    if code_name == "MissingRequiredColumn":
        return f"{where}{col_part}: missing required column"
    if code_name == "ExtraColumn":
        return f"{where}{col_part}: extra column not allowed"
    if code_name == "ColumnCountMismatch":
        return f"{where}: column count does not match configured totalColumns"
    if code_name == "MissingRequired":
        return f"{where}{col_part}: value is required"
    if code_name == "InvalidType":
        return f"{where}{col_part}: invalid type"
    if code_name == "MaxLengthExceeded":
        return f"{where}{col_part}: exceeds max length"
    if code_name == "MinLengthNotMet":
        return f"{where}{col_part}: below minimum length"
    if code_name == "NotAllowed":
        return f"{where}{col_part}: value not allowed"
    if code_name == "InvalidEmail":
        return f"{where}{col_part}: invalid email format"
    if code_name == "PatternMismatch":
        return f"{where}{col_part}: does not match required pattern"
    if code_name == "PrecisionExceeded":
        return f"{where}{col_part}: decimal precision exceeded"
    if code_name == "InvalidUtf8":
        return f"{where}{col_part}: invalid text encoding"
    if code_name == "DuplicateValue":
        return f"{where}{col_part}: duplicate value not allowed"
    if code_name == "DuplicateCombination":
        return f"{where}{col_part}: duplicate combination not allowed"
    return f"{where}{col_part}: validation error"


def _err_buf_message(err_buf: "ctypes.Array", ret: int) -> str:
    msg = err_buf.value.decode("utf-8", errors="replace")
    if msg:
        return msg
    if ret == -1:
        return "null engine handle or missing input"
    return f"native call failed (code {ret})"


def _take_json_list(lib: ctypes.CDLL, ptr: int) -> List[str]:
    if not ptr:
        return []
    s = ctypes.cast(ptr, ctypes.c_char_p).value
    lib.iv_free_string(ctypes.c_void_p(ptr))
    if not s:
        return []
    return json.loads(s.decode("utf-8"))


def error_code_name(code: int) -> str:
    """Return the stable string name for a numeric error code."""
    lib = _get_lib()
    ptr = lib.iv_error_code_to_string(ctypes.c_uint8(code))
    if not ptr:
        return "Unknown"
    s = ctypes.cast(ptr, ctypes.c_char_p).value
    lib.iv_free_string(ctypes.c_void_p(ptr))
    return s.decode("utf-8") if s else "Unknown"
