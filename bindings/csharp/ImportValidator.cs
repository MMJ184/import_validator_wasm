// Copyright (c) 2025-2026 Maulik Mangukiya. All rights reserved. See LICENSE.
//
// ImportValidator.cs — C# P/Invoke bindings for the ImportValidator native library.
//
// Target framework: .NET Standard 2.1 (consumable from .NET Core 3.0+/.NET 5+).
//
// 1. Build the native library:
//      ./scripts/build-native.sh
//    which produces:
//      macOS:   libimport_validator.dylib
//      Linux:   libimport_validator.so
//      Windows: import_validator.dll
//
// 2. Copy the library next to your executable and set Engine.LibraryName
//    if the default name does not match, or set IMPORT_VALIDATOR_LIB env-var.
//
// Quick example:
//    using ImportValidator;
//    string schema = """
//        {"hasHeaders":true,"columns":[
//          {"name":"id","type":"int","required":true},
//          {"name":"email","type":"email","required":true,"unique":true}
//        ]}
//    """;
//    byte[] csv = File.ReadAllBytes("data.csv");
//    var result = Validator.ValidateBytes(csv, schema);
//    foreach (var e in result.Errors)
//        Console.WriteLine(e.Message);

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace ImportValidator
{
    // ── Native function table ────────────────────────────────────────────────

    internal static class Native
    {
        // Set via Engine.LibraryName or IMPORT_VALIDATOR_LIB env-var before first use.
        internal static string LibraryPath { get; set; } = DefaultLibraryName();

        private static string DefaultLibraryName()
        {
            string? envPath = Environment.GetEnvironmentVariable("IMPORT_VALIDATOR_LIB");
            if (!string.IsNullOrEmpty(envPath))
                return envPath!;

            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                return "libimport_validator.dylib";
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return "import_validator.dll";
            return "libimport_validator.so";
        }

        // Delegate-based thunks resolved at runtime (avoids hard-coding library
        // name in DllImport). All function pointers are loaded lazily on first access.
        private static readonly Lazy<NativeLib> _lib = new Lazy<NativeLib>(() => new NativeLib(LibraryPath));

        internal static IntPtr    EngineNew(IntPtr schemaUtf8, uint m, byte e, IntPtr buf, uint bl)
            => _lib.Value.iv_engine_new(schemaUtf8, m, e, buf, bl);
        internal static void      EngineDestroy(IntPtr h)       => _lib.Value.iv_engine_destroy(h);
        internal static IntPtr    VersionPtr()                  => _lib.Value.iv_version();
        internal static int       PushChunk(IntPtr h, IntPtr d, uint l, byte f, ref IvProgress p)
            => _lib.Value.iv_engine_push_chunk(h, d, l, f, ref p);
        internal static int       PushSharedStringsChunk(IntPtr h, IntPtr d, uint l, byte f, IntPtr eb, uint ebl)
            => _lib.Value.iv_engine_push_shared_strings_chunk(h, d, l, f, eb, ebl);
        internal static int       PushSheetChunk(IntPtr h, IntPtr d, uint l, byte f, ref IvProgress p, IntPtr eb, uint ebl)
            => _lib.Value.iv_engine_push_sheet_chunk(h, d, l, f, ref p, eb, ebl);
        internal static int       ValidateXlsxBytes(IntPtr h, IntPtr d, uint l, ref IvProgress p, IntPtr eb, uint ebl)
            => _lib.Value.iv_engine_validate_xlsx_bytes(h, d, l, ref p, eb, ebl);
        internal static uint      ErrorsCount(IntPtr h)         => _lib.Value.iv_engine_errors_count(h);
        internal static uint      TakeErrorsPacked(IntPtr h, uint[] buf, uint n)
            => _lib.Value.iv_engine_take_errors_packed(h, buf, n);
        internal static IntPtr    SchemaColumnsJson(IntPtr h)   => _lib.Value.iv_engine_schema_columns_json(h);
        internal static IntPtr    InputColumnsJson(IntPtr h)    => _lib.Value.iv_engine_input_columns_json(h);
        internal static uint      RowsProcessed(IntPtr h)       => _lib.Value.iv_engine_rows_processed(h);
        internal static IntPtr    TakeNormalized(IntPtr h, out uint len)
            => _lib.Value.iv_engine_take_normalized(h, out len);
        internal static IntPtr    ErrorCodeToString(byte c)     => _lib.Value.iv_error_code_to_string(c);
        internal static void      FreeString(IntPtr p)          => _lib.Value.iv_free_string(p);
        internal static void      FreeBytes(IntPtr p, uint l)   => _lib.Value.iv_free_bytes(p, l);
    }

    // ── IvProgress struct (must match Rust #[repr(C)] layout) ───────────────

    [StructLayout(LayoutKind.Sequential)]
    internal struct IvProgress
    {
        public uint RowsProcessed;
        public uint ErrorsAdded;
        public byte Done;
        private byte _p1, _p2, _p3; // explicit padding to match Rust layout
    }

    // ── Runtime library loader ───────────────────────────────────────────────
    //
    // System.Runtime.InteropServices.NativeLibrary is not part of
    // .NET Standard 2.1, so loading a library from a dynamic path uses
    // dlopen/dlsym on Unix and LoadLibraryW/GetProcAddress on Windows.

    internal static class NativeLoader
    {
        private const int RTLD_NOW = 2;

        internal static IntPtr Load(string path)
        {
            IntPtr handle;
            string detail;
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                handle = Win32.LoadLibraryW(path);
                detail = $"error code {Marshal.GetLastWin32Error()}";
            }
            else
            {
                handle = DlOpen(path, RTLD_NOW);
                detail = DlErrorMessage();
            }
            if (handle == IntPtr.Zero)
                throw new DllNotFoundException($"Failed to load native library '{path}' ({detail}).");
            return handle;
        }

        internal static IntPtr GetExport(IntPtr handle, string name)
        {
            IntPtr sym = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? Win32.GetProcAddress(handle, name)
                : DlSym(handle, name);
            if (sym == IntPtr.Zero)
                throw new EntryPointNotFoundException($"Native export '{name}' not found in ImportValidator library.");
            return sym;
        }

        private static IntPtr DlOpen(string path, int flags)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                return MacSystem.dlopen(path, flags);
            try { return LinuxDl2.dlopen(path, flags); }
            catch (DllNotFoundException) { }
            try { return LinuxDl.dlopen(path, flags); }
            catch (DllNotFoundException) { }
            return LinuxLibc.dlopen(path, flags); // glibc >= 2.34 / musl
        }

        private static IntPtr DlSym(IntPtr handle, string name)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                return MacSystem.dlsym(handle, name);
            try { return LinuxDl2.dlsym(handle, name); }
            catch (DllNotFoundException) { }
            try { return LinuxDl.dlsym(handle, name); }
            catch (DllNotFoundException) { }
            return LinuxLibc.dlsym(handle, name);
        }

        private static string DlErrorMessage()
        {
            IntPtr err;
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                err = MacSystem.dlerror();
            }
            else
            {
                try { err = LinuxDl2.dlerror(); }
                catch (DllNotFoundException)
                {
                    try { err = LinuxDl.dlerror(); }
                    catch (DllNotFoundException) { err = LinuxLibc.dlerror(); }
                }
            }
            return err == IntPtr.Zero
                ? "unknown dlopen error"
                : Marshal.PtrToStringUTF8(err) ?? "unknown dlopen error";
        }

        private static class MacSystem
        {
            [DllImport("/usr/lib/libSystem.dylib")] internal static extern IntPtr dlopen(string path, int flags);
            [DllImport("/usr/lib/libSystem.dylib")] internal static extern IntPtr dlsym(IntPtr handle, string symbol);
            [DllImport("/usr/lib/libSystem.dylib")] internal static extern IntPtr dlerror();
        }

        private static class LinuxDl2
        {
            [DllImport("libdl.so.2")] internal static extern IntPtr dlopen(string path, int flags);
            [DllImport("libdl.so.2")] internal static extern IntPtr dlsym(IntPtr handle, string symbol);
            [DllImport("libdl.so.2")] internal static extern IntPtr dlerror();
        }

        private static class LinuxDl
        {
            [DllImport("libdl")] internal static extern IntPtr dlopen(string path, int flags);
            [DllImport("libdl")] internal static extern IntPtr dlsym(IntPtr handle, string symbol);
            [DllImport("libdl")] internal static extern IntPtr dlerror();
        }

        private static class LinuxLibc
        {
            [DllImport("libc")] internal static extern IntPtr dlopen(string path, int flags);
            [DllImport("libc")] internal static extern IntPtr dlsym(IntPtr handle, string symbol);
            [DllImport("libc")] internal static extern IntPtr dlerror();
        }

        private static class Win32
        {
            [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
            internal static extern IntPtr LoadLibraryW(string path);
            [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
            internal static extern IntPtr GetProcAddress(IntPtr module, string name);
        }
    }

    // ── Native function pointer table ────────────────────────────────────────

    internal sealed class NativeLib
    {
        private readonly IntPtr _handle;

        internal NativeLib(string path)
        {
            _handle = NativeLoader.Load(path);
        }

        private T Get<T>(string name) where T : Delegate
            => Marshal.GetDelegateForFunctionPointer<T>(NativeLoader.GetExport(_handle, name));

        // Delegate types matching each C function signature
        // (see bindings/include/import_validator.h).
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr EngineNewFn(IntPtr schemaUtf8, uint maxErrors, byte emitNorm,
                                             IntPtr errBuf, uint errBufLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate void EngineDestroyFn(IntPtr h);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr VersionFn();

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int PushChunkFn(IntPtr h, IntPtr data, uint len,
                                           byte final_, ref IvProgress progress);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int PushSharedStringsChunkFn(IntPtr h, IntPtr data, uint len,
                                                       byte final_, IntPtr errBuf, uint errBufLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int PushSheetChunkFn(IntPtr h, IntPtr data, uint len, byte final_,
                                               ref IvProgress progress, IntPtr errBuf, uint errBufLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int ValidateXlsxBytesFn(IntPtr h, IntPtr data, uint len,
                                                  ref IvProgress progress, IntPtr errBuf, uint errBufLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate uint ErrorsCountFn(IntPtr h);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate uint TakeErrorsPackedFn(IntPtr h,
            [MarshalAs(UnmanagedType.LPArray)] uint[] buf, uint maxPairs);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr SchemaColumnsJsonFn(IntPtr h);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr InputColumnsJsonFn(IntPtr h);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate uint RowsProcessedFn(IntPtr h);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr TakeNormalizedFn(IntPtr h, out uint outLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr ErrorCodeToStringFn(byte code);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate void FreeStringFn(IntPtr p);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate void FreeBytesFn(IntPtr p, uint len);

        // Lazily resolved function pointers.
        private EngineNewFn?              _engNew;
        private EngineDestroyFn?          _engDestroy;
        private VersionFn?                _version;
        private PushChunkFn?              _pushChunk;
        private PushSharedStringsChunkFn? _pushShared;
        private PushSheetChunkFn?         _pushSheet;
        private ValidateXlsxBytesFn?      _validateXlsx;
        private ErrorsCountFn?            _errCount;
        private TakeErrorsPackedFn?       _takePacked;
        private SchemaColumnsJsonFn?      _schemaCols;
        private InputColumnsJsonFn?       _inputCols;
        private RowsProcessedFn?          _rowsProcessed;
        private TakeNormalizedFn?         _takeNorm;
        private ErrorCodeToStringFn?      _errStr;
        private FreeStringFn?             _freeStr;
        private FreeBytesFn?              _freeBytes;

        internal IntPtr iv_engine_new(IntPtr schemaUtf8, uint m, byte e, IntPtr buf, uint bl)
            => (_engNew ??= Get<EngineNewFn>("iv_engine_new"))(schemaUtf8, m, e, buf, bl);
        internal void iv_engine_destroy(IntPtr h)
            => (_engDestroy ??= Get<EngineDestroyFn>("iv_engine_destroy"))(h);
        internal IntPtr iv_version()
            => (_version ??= Get<VersionFn>("iv_version"))();
        internal int iv_engine_push_chunk(IntPtr h, IntPtr d, uint l, byte f, ref IvProgress p)
            => (_pushChunk ??= Get<PushChunkFn>("iv_engine_push_chunk"))(h, d, l, f, ref p);
        internal int iv_engine_push_shared_strings_chunk(IntPtr h, IntPtr d, uint l, byte f, IntPtr eb, uint ebl)
            => (_pushShared ??= Get<PushSharedStringsChunkFn>("iv_engine_push_shared_strings_chunk"))(h, d, l, f, eb, ebl);
        internal int iv_engine_push_sheet_chunk(IntPtr h, IntPtr d, uint l, byte f, ref IvProgress p, IntPtr eb, uint ebl)
            => (_pushSheet ??= Get<PushSheetChunkFn>("iv_engine_push_sheet_chunk"))(h, d, l, f, ref p, eb, ebl);
        internal int iv_engine_validate_xlsx_bytes(IntPtr h, IntPtr d, uint l, ref IvProgress p, IntPtr eb, uint ebl)
            => (_validateXlsx ??= Get<ValidateXlsxBytesFn>("iv_engine_validate_xlsx_bytes"))(h, d, l, ref p, eb, ebl);
        internal uint iv_engine_errors_count(IntPtr h)
            => (_errCount ??= Get<ErrorsCountFn>("iv_engine_errors_count"))(h);
        internal uint iv_engine_take_errors_packed(IntPtr h, uint[] buf, uint n)
            => (_takePacked ??= Get<TakeErrorsPackedFn>("iv_engine_take_errors_packed"))(h, buf, n);
        internal IntPtr iv_engine_schema_columns_json(IntPtr h)
            => (_schemaCols ??= Get<SchemaColumnsJsonFn>("iv_engine_schema_columns_json"))(h);
        internal IntPtr iv_engine_input_columns_json(IntPtr h)
            => (_inputCols ??= Get<InputColumnsJsonFn>("iv_engine_input_columns_json"))(h);
        internal uint iv_engine_rows_processed(IntPtr h)
            => (_rowsProcessed ??= Get<RowsProcessedFn>("iv_engine_rows_processed"))(h);
        internal IntPtr iv_engine_take_normalized(IntPtr h, out uint len)
            => (_takeNorm ??= Get<TakeNormalizedFn>("iv_engine_take_normalized"))(h, out len);
        internal IntPtr iv_error_code_to_string(byte c)
            => (_errStr ??= Get<ErrorCodeToStringFn>("iv_error_code_to_string"))(c);
        internal void iv_free_string(IntPtr p)
            => (_freeStr ??= Get<FreeStringFn>("iv_free_string"))(p);
        internal void iv_free_bytes(IntPtr p, uint l)
            => (_freeBytes ??= Get<FreeBytesFn>("iv_free_bytes"))(p, l);
    }

    // ── Public data types ────────────────────────────────────────────────────

    /// Progress snapshot for a single PushChunk / PushSheetChunk / ValidateXlsxBytes call.
    public record ChunkProgress(uint RowsProcessed, uint ErrorsAdded, bool Done);

    /// A single validation error.
    public record ValidationError(
        uint    Row,               // 1-based data row number (0 = header row)
        uint    Col,               // 0-based column index
        string  Kind,              // "schema" or "input"
        byte    Code,              // numeric error code
        string  CodeName,          // e.g. "InvalidType"
        string? ColumnName = null, // resolved column name (null if out of range)
        string  Message = ""       // human-readable message
    )
    {
        public override string ToString() =>
            $"row={Row} col={Col} [{Kind}] {CodeName} ({Code})";
    }

    // ── Engine ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Streaming CSV/XLSX validation engine. Use inside a <c>using</c> block or
    /// call <see cref="Dispose"/> when done to release native memory.
    ///
    /// An engine validates exactly ONE stream — either CSV bytes via
    /// <see cref="PushChunk(ReadOnlySpan{byte}, bool)"/>, or XLSX via
    /// <see cref="PushSharedStringsChunk"/>/<see cref="PushSheetChunk"/> (or the
    /// one-shot <see cref="ValidateXlsxBytes"/>). Create a new engine per file.
    /// </summary>
    public sealed class Engine : IDisposable
    {
        private const int ErrBufLen = 1024;

        /// <summary>
        /// Path to the native library. Set before first use when the library is
        /// not on the default search path.
        /// </summary>
        public static string LibraryName
        {
            get  => Native.LibraryPath;
            set  => Native.LibraryPath = value;
        }

        private IntPtr _handle;
        private bool   _disposed;

        /// <summary>Create an engine from a JSON schema string.</summary>
        /// <param name="schemaJson">Schema JSON (see docs/validation-config.schema.json).</param>
        /// <param name="maxErrors">Stop accumulating errors after this many.</param>
        /// <param name="emitNormalized">Collect normalised CSV output.</param>
        public Engine(string schemaJson, uint maxErrors = 10_000, bool emitNormalized = false)
        {
            byte[] schemaUtf8 = NulTerminatedUtf8(schemaJson ?? throw new ArgumentNullException(nameof(schemaJson)));
            byte[] errBuf = new byte[ErrBufLen];
            var schemaPin = GCHandle.Alloc(schemaUtf8, GCHandleType.Pinned);
            var errPin = GCHandle.Alloc(errBuf, GCHandleType.Pinned);
            IntPtr handle;
            try
            {
                handle = Native.EngineNew(
                    schemaPin.AddrOfPinnedObject(), maxErrors,
                    emitNormalized ? (byte)1 : (byte)0,
                    errPin.AddrOfPinnedObject(), (uint)errBuf.Length);
            }
            finally
            {
                schemaPin.Free();
                errPin.Free();
            }

            if (handle == IntPtr.Zero)
                throw new InvalidOperationException($"Engine init failed: {ErrBufToString(errBuf)}");
            _handle = handle;
        }

        public void Dispose()
        {
            if (!_disposed && _handle != IntPtr.Zero)
            {
                Native.EngineDestroy(_handle);
                _handle = IntPtr.Zero;
                _disposed = true;
            }
        }

        /// <summary>Native engine version string (from iv_version).</summary>
        public static string Version()
        {
            IntPtr ptr = Native.VersionPtr();
            // Static storage — never freed.
            return ptr == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUTF8(ptr) ?? string.Empty;
        }

        // ── Processing: CSV ──────────────────────────────────────────────────

        /// <summary>
        /// Feed a CSV chunk to the engine.
        /// Call with <paramref name="final"/> = true on the last chunk.
        /// </summary>
        public ChunkProgress PushChunk(ReadOnlySpan<byte> chunk, bool final = false)
        {
            CheckOpen();
            IvProgress prog = default;
            int ret;
            if (chunk.IsEmpty)
            {
                ret = Native.PushChunk(_handle, IntPtr.Zero, 0, final ? (byte)1 : (byte)0, ref prog);
            }
            else
            {
                unsafe
                {
                    fixed (byte* p = chunk)
                    {
                        ret = Native.PushChunk(_handle, (IntPtr)p, (uint)chunk.Length,
                                               final ? (byte)1 : (byte)0, ref prog);
                    }
                }
            }
            if (ret != 0)
                throw new InvalidOperationException("PushChunk failed (null handle or input-mode misuse)");
            return new ChunkProgress(prog.RowsProcessed, prog.ErrorsAdded, prog.Done != 0);
        }

        /// <inheritdoc cref="PushChunk(ReadOnlySpan{byte}, bool)"/>
        public ChunkProgress PushChunk(byte[] chunk, bool final = false)
            => PushChunk(new ReadOnlySpan<byte>(chunk), final);

        // ── Processing: XLSX ─────────────────────────────────────────────────

        /// <summary>
        /// Feed a chunk of decompressed xl/sharedStrings.xml to the engine.
        /// Must complete (<paramref name="final"/> = true) BEFORE the first
        /// <see cref="PushSheetChunk"/> call. Throws
        /// <see cref="InvalidOperationException"/> with the native error message
        /// on failure.
        /// </summary>
        public void PushSharedStringsChunk(ReadOnlySpan<byte> chunk, bool final = false)
        {
            CheckOpen();
            byte[] errBuf = new byte[ErrBufLen];
            var errPin = GCHandle.Alloc(errBuf, GCHandleType.Pinned);
            int ret;
            try
            {
                byte finalByte = final ? (byte)1 : (byte)0;
                if (chunk.IsEmpty)
                {
                    ret = Native.PushSharedStringsChunk(_handle, IntPtr.Zero, 0, finalByte,
                                                        errPin.AddrOfPinnedObject(), (uint)errBuf.Length);
                }
                else
                {
                    unsafe
                    {
                        fixed (byte* p = chunk)
                        {
                            ret = Native.PushSharedStringsChunk(_handle, (IntPtr)p, (uint)chunk.Length,
                                                                finalByte, errPin.AddrOfPinnedObject(),
                                                                (uint)errBuf.Length);
                        }
                    }
                }
            }
            finally { errPin.Free(); }
            ThrowIfNativeError(ret, errBuf, nameof(PushSharedStringsChunk));
        }

        /// <summary>
        /// Feed a chunk of decompressed worksheet XML (xl/worksheets/sheetN.xml).
        /// Rows validate exactly like CSV rows. Call with
        /// <paramref name="final"/> = true on the last chunk. Throws
        /// <see cref="InvalidOperationException"/> with the native error message
        /// on failure.
        /// </summary>
        public ChunkProgress PushSheetChunk(ReadOnlySpan<byte> chunk, bool final = false)
        {
            CheckOpen();
            IvProgress prog = default;
            byte[] errBuf = new byte[ErrBufLen];
            var errPin = GCHandle.Alloc(errBuf, GCHandleType.Pinned);
            int ret;
            try
            {
                byte finalByte = final ? (byte)1 : (byte)0;
                if (chunk.IsEmpty)
                {
                    ret = Native.PushSheetChunk(_handle, IntPtr.Zero, 0, finalByte, ref prog,
                                                errPin.AddrOfPinnedObject(), (uint)errBuf.Length);
                }
                else
                {
                    unsafe
                    {
                        fixed (byte* p = chunk)
                        {
                            ret = Native.PushSheetChunk(_handle, (IntPtr)p, (uint)chunk.Length,
                                                        finalByte, ref prog, errPin.AddrOfPinnedObject(),
                                                        (uint)errBuf.Length);
                        }
                    }
                }
            }
            finally { errPin.Free(); }
            ThrowIfNativeError(ret, errBuf, nameof(PushSheetChunk));
            return new ChunkProgress(prog.RowsProcessed, prog.ErrorsAdded, prog.Done != 0);
        }

        /// <summary>
        /// One-shot: validate a complete .xlsx workbook from a byte buffer. The
        /// engine parses the ZIP container, streams shared strings, then streams
        /// the first worksheet. Throws <see cref="InvalidOperationException"/>
        /// with the native error message on failure.
        /// </summary>
        public ChunkProgress ValidateXlsxBytes(byte[] xlsxBytes)
        {
            if (xlsxBytes == null) throw new ArgumentNullException(nameof(xlsxBytes));
            CheckOpen();
            IvProgress prog = default;
            byte[] errBuf = new byte[ErrBufLen];
            var dataPin = GCHandle.Alloc(xlsxBytes, GCHandleType.Pinned);
            var errPin = GCHandle.Alloc(errBuf, GCHandleType.Pinned);
            int ret;
            try
            {
                ret = Native.ValidateXlsxBytes(_handle, dataPin.AddrOfPinnedObject(),
                                               (uint)xlsxBytes.Length, ref prog,
                                               errPin.AddrOfPinnedObject(), (uint)errBuf.Length);
            }
            finally
            {
                dataPin.Free();
                errPin.Free();
            }
            ThrowIfNativeError(ret, errBuf, nameof(ValidateXlsxBytes));
            return new ChunkProgress(prog.RowsProcessed, prog.ErrorsAdded, prog.Done != 0);
        }

        // ── Error draining ───────────────────────────────────────────────────

        /// <summary>Number of errors currently queued (without draining).</summary>
        public uint ErrorsCount
        {
            get { CheckOpen(); return Native.ErrorsCount(_handle); }
        }

        /// <summary>Drain and decode queued errors.</summary>
        public List<ValidationError> TakeErrors(uint maxErrors = 100_000)
        {
            CheckOpen();
            uint[] buf = new uint[maxErrors * 2];
            uint pairs = Native.TakeErrorsPacked(_handle, buf, maxErrors);
            var list = new List<ValidationError>((int)pairs);
            if (pairs == 0) return list;
            // Resolve column names once per drain call, not per error.
            List<string> schemaCols = SchemaColumns();
            List<string> inputCols  = InputColumns();
            for (uint i = 0; i < pairs; i++)
                list.Add(DecodeError(buf[i * 2], buf[i * 2 + 1], schemaCols, inputCols));
            return list;
        }

        // ── Metadata ─────────────────────────────────────────────────────────

        /// <summary>Schema column names in schema order.</summary>
        public List<string> SchemaColumns()
        {
            CheckOpen();
            return TakeJsonList(Native.SchemaColumnsJson(_handle));
        }

        /// <summary>Input (CSV/XLSX header) column names in input order.</summary>
        public List<string> InputColumns()
        {
            CheckOpen();
            return TakeJsonList(Native.InputColumnsJson(_handle));
        }

        /// <summary>Total data rows processed so far (header excluded).</summary>
        public uint RowsProcessed
        {
            get { CheckOpen(); return Native.RowsProcessed(_handle); }
        }

        // ── Normalized output ────────────────────────────────────────────────

        /// <summary>Drain normalized CSV bytes accumulated so far.</summary>
        public byte[] TakeNormalized()
        {
            CheckOpen();
            IntPtr ptr = Native.TakeNormalized(_handle, out uint len);
            if (ptr == IntPtr.Zero || len == 0) return Array.Empty<byte>();
            byte[] result = new byte[len];
            Marshal.Copy(ptr, result, 0, (int)len);
            Native.FreeBytes(ptr, len);
            return result;
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        private void CheckOpen()
        {
            if (_disposed) throw new ObjectDisposedException(nameof(Engine));
        }

        private static byte[] NulTerminatedUtf8(string s)
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(s);
            byte[] buf = new byte[utf8.Length + 1];
            Buffer.BlockCopy(utf8, 0, buf, 0, utf8.Length);
            // buf[^1] is already 0.
            return buf;
        }

        private static string ErrBufToString(byte[] errBuf)
        {
            int nul = Array.IndexOf(errBuf, (byte)0);
            if (nul < 0) nul = errBuf.Length;
            return Encoding.UTF8.GetString(errBuf, 0, nul);
        }

        private static void ThrowIfNativeError(int ret, byte[] errBuf, string operation)
        {
            if (ret == 0) return;
            string msg = ErrBufToString(errBuf);
            if (msg.Length == 0)
                msg = ret == -1 ? "null engine handle or missing input" : $"native call failed (code {ret})";
            throw new InvalidOperationException($"{operation} failed: {msg}");
        }

        private static ValidationError DecodeError(uint word0, uint word1,
                                                   List<string> schemaCols, List<string> inputCols)
        {
            uint row  = word0;
            byte code = (byte)(word1 & 0xFF);
            uint col  = (word1 >> 8) & 0x7FFFFF;
            bool isInput = ((word1 >> 31) & 1) == 1;
            string kind = isInput ? "input" : "schema";
            string name = ErrorCodeName(code);
            List<string> cols = isInput ? inputCols : schemaCols;
            string? columnName = col < (uint)cols.Count ? cols[(int)col] : null;
            string message = FormatMessage(row, name, columnName);
            return new ValidationError(row, col, kind, code, name, columnName, message);
        }

        private static string FormatMessage(uint row, string codeName, string? columnName)
        {
            string where   = row == 0 ? "Header" : $"Row {row}";
            string colPart = string.IsNullOrEmpty(columnName) ? "" : $", column \"{columnName}\"";

            switch (codeName)
            {
                case "MissingRequiredColumn":
                    return $"{where}{colPart}: missing required column";
                case "ExtraColumn":
                    return $"{where}{colPart}: extra column not allowed";
                case "ColumnCountMismatch":
                    return $"{where}: column count does not match configured totalColumns";
                case "MissingRequired":
                    return $"{where}{colPart}: value is required";
                case "InvalidType":
                    return $"{where}{colPart}: invalid type";
                case "MaxLengthExceeded":
                    return $"{where}{colPart}: exceeds max length";
                case "MinLengthNotMet":
                    return $"{where}{colPart}: below minimum length";
                case "NotAllowed":
                    return $"{where}{colPart}: value not allowed";
                case "InvalidEmail":
                    return $"{where}{colPart}: invalid email format";
                case "PatternMismatch":
                    return $"{where}{colPart}: does not match required pattern";
                case "PrecisionExceeded":
                    return $"{where}{colPart}: decimal precision exceeded";
                case "InvalidUtf8":
                    return $"{where}{colPart}: invalid text encoding";
                case "DuplicateValue":
                    return $"{where}{colPart}: duplicate value not allowed";
                case "DuplicateCombination":
                    return $"{where}{colPart}: duplicate combination not allowed";
                default:
                    return $"{where}{colPart}: validation error";
            }
        }

        private static List<string> TakeJsonList(IntPtr ptr)
        {
            if (ptr == IntPtr.Zero) return new List<string>();
            string json = Marshal.PtrToStringUTF8(ptr) ?? "[]";
            Native.FreeString(ptr);
            return ParseJsonStringArray(json);
        }

        /// <summary>Returns the stable name for a numeric error code.</summary>
        public static string ErrorCodeName(byte code)
        {
            IntPtr ptr = Native.ErrorCodeToString(code);
            if (ptr == IntPtr.Zero) return "Unknown";
            string name = Marshal.PtrToStringUTF8(ptr) ?? "Unknown";
            Native.FreeString(ptr);
            return name;
        }

        // Minimal JSON parser for a flat array of strings (the only JSON shape
        // returned by the native library). Avoids a System.Text.Json dependency
        // on .NET Standard 2.1.
        private static List<string> ParseJsonStringArray(string json)
        {
            var result = new List<string>();
            int i = 0;

            void SkipWs()
            {
                while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            }

            SkipWs();
            if (i >= json.Length || json[i] != '[') return result;
            i++; // '['
            SkipWs();
            if (i < json.Length && json[i] == ']') return result;

            while (i < json.Length)
            {
                SkipWs();
                if (i >= json.Length || json[i] != '"') break; // malformed
                i++; // opening quote
                var sb = new StringBuilder();
                while (i < json.Length && json[i] != '"')
                {
                    char c = json[i];
                    if (c == '\\' && i + 1 < json.Length)
                    {
                        i++;
                        char esc = json[i];
                        switch (esc)
                        {
                            case '"':  sb.Append('"');  break;
                            case '\\': sb.Append('\\'); break;
                            case '/':  sb.Append('/');  break;
                            case 'b':  sb.Append('\b'); break;
                            case 'f':  sb.Append('\f'); break;
                            case 'n':  sb.Append('\n'); break;
                            case 'r':  sb.Append('\r'); break;
                            case 't':  sb.Append('\t'); break;
                            case 'u':
                                if (i + 4 < json.Length)
                                {
                                    sb.Append((char)Convert.ToUInt16(json.Substring(i + 1, 4), 16));
                                    i += 4;
                                }
                                break;
                        }
                        i++;
                    }
                    else
                    {
                        sb.Append(c);
                        i++;
                    }
                }
                i++; // closing quote
                result.Add(sb.ToString());
                SkipWs();
                if (i < json.Length && json[i] == ',') { i++; continue; }
                break; // ']' or end of input
            }
            return result;
        }
    }

    // ── ValidationResult ─────────────────────────────────────────────────────

    /// <summary>Result of a full Validator.Validate* call.</summary>
    public sealed class ValidationResult
    {
        public IReadOnlyList<ValidationError> Errors         { get; }
        public IReadOnlyList<string>          SchemaColumns  { get; }
        public IReadOnlyList<string>          InputColumns   { get; }
        public byte[]                         Normalized     { get; }
        public bool                           IsValid        => Errors.Count == 0;

        internal ValidationResult(
            List<ValidationError> errors,
            List<string> schemaCols,
            List<string> inputCols,
            byte[] normalized)
        {
            Errors        = errors;
            SchemaColumns = schemaCols;
            InputColumns  = inputCols;
            Normalized    = normalized;
        }
    }

    // ── Validator (convenience wrappers) ─────────────────────────────────────

    /// <summary>Convenience methods for one-shot validation.</summary>
    public static class Validator
    {
        /// <summary>Version of these C# bindings.</summary>
        public const string Version = "0.2.0";

        /// <summary>Validate an in-memory CSV byte array against a schema.</summary>
        public static ValidationResult ValidateBytes(
            byte[]  csvBytes,
            string  schemaJson,
            uint    maxErrors       = 10_000,
            bool    emitNormalized  = false,
            int     chunkSize       = 256 * 1024)
        {
            using var engine = new Engine(schemaJson, maxErrors, emitNormalized);
            int offset = 0;
            while (offset < csvBytes.Length)
            {
                int end    = Math.Min(offset + chunkSize, csvBytes.Length);
                bool final = end >= csvBytes.Length;
                engine.PushChunk(new ReadOnlySpan<byte>(csvBytes, offset, end - offset), final);
                offset = end;
            }
            if (csvBytes.Length == 0)
                engine.PushChunk(ReadOnlySpan<byte>.Empty, true);

            return CollectResult(engine, maxErrors, emitNormalized);
        }

        /// <summary>Validate a CSV file against a schema.</summary>
        public static ValidationResult ValidateFile(
            string filePath,
            string schemaJson,
            uint   maxErrors      = 10_000,
            bool   emitNormalized = false,
            int    chunkSize      = 256 * 1024)
        {
            using var engine = new Engine(schemaJson, maxErrors, emitNormalized);
            byte[] buf = new byte[chunkSize];
            using var fs = System.IO.File.OpenRead(filePath);
            int read;
            bool sentFinal = false;
            while ((read = fs.Read(buf, 0, buf.Length)) > 0)
            {
                bool isLast = fs.Position >= fs.Length;
                engine.PushChunk(new ReadOnlySpan<byte>(buf, 0, read), isLast);
                if (isLast) sentFinal = true;
            }
            if (!sentFinal)
                engine.PushChunk(ReadOnlySpan<byte>.Empty, true);

            return CollectResult(engine, maxErrors, emitNormalized);
        }

        /// <summary>Validate a complete in-memory .xlsx workbook against a schema.</summary>
        public static ValidationResult ValidateXlsxBytes(
            byte[] xlsxBytes,
            string schemaJson,
            uint   maxErrors      = 10_000,
            bool   emitNormalized = false)
        {
            using var engine = new Engine(schemaJson, maxErrors, emitNormalized);
            engine.ValidateXlsxBytes(xlsxBytes);
            return CollectResult(engine, maxErrors, emitNormalized);
        }

        /// <summary>Validate an .xlsx file against a schema.</summary>
        public static ValidationResult ValidateXlsxFile(
            string filePath,
            string schemaJson,
            uint   maxErrors      = 10_000,
            bool   emitNormalized = false)
        {
            return ValidateXlsxBytes(System.IO.File.ReadAllBytes(filePath), schemaJson,
                                     maxErrors, emitNormalized);
        }

        private static ValidationResult CollectResult(Engine engine, uint maxErrors, bool emitNormalized)
        {
            return new ValidationResult(
                engine.TakeErrors(maxErrors),
                engine.SchemaColumns(),
                engine.InputColumns(),
                emitNormalized ? engine.TakeNormalized() : Array.Empty<byte>());
        }
    }
}

// Required for record types (init accessors) when targeting .NET Standard 2.1.
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}
