// ImportValidator.cs — C# P/Invoke bindings for the ImportValidator native library.
//
// Target framework: .NET 6+ (uses record types and using-declarations).
//
// 1. Build the native library:
//      ./scripts/build-native.sh
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
//        Console.WriteLine(e);

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace ImportValidator
{
    // ── Native P/Invoke declarations ─────────────────────────────────────────

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
                return "libimport_validator_wasm.dylib";
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                return "import_validator_wasm.dll";
            return "libimport_validator_wasm.so";
        }

        // iv_engine_new
        [DllImport("__placeholder__", EntryPoint = "iv_engine_new", CharSet = CharSet.Ansi)]
        private static extern IntPtr _iv_engine_new(
            [MarshalAs(UnmanagedType.LPStr)] string schemaJson,
            uint   maxErrors,
            byte   emitNormalized,
            IntPtr errBuf,
            uint   errBufLen);

        internal static IntPtr EngineNew(string schemaJson, uint maxErrors, bool emitNormalized,
                                          byte[] errBuf)
        {
            var handle = GCHandle.Alloc(errBuf, GCHandleType.Pinned);
            try
            {
                return NativeLibraryThunk.iv_engine_new(
                    schemaJson, maxErrors, emitNormalized ? (byte)1 : (byte)0,
                    handle.AddrOfPinnedObject(), (uint)errBuf.Length);
            }
            finally { handle.Free(); }
        }

        // Delegate-based thunks resolved at runtime (avoids hard-coding library name in DllImport).
        // All function pointers are loaded lazily on first access.

        private static readonly Lazy<NativeLib> _lib = new(() => new NativeLib(LibraryPath));

        internal static IntPtr    EngineNew2(string s, uint m, byte e, IntPtr buf, uint bl)
            => _lib.Value.iv_engine_new(s, m, e, buf, bl);
        internal static void      EngineDestroy(IntPtr h)       => _lib.Value.iv_engine_destroy(h);
        internal static int       PushChunk(IntPtr h, IntPtr d, uint l, byte f, ref IvProgress p)
            => _lib.Value.iv_engine_push_chunk(h, d, l, f, ref p);
        internal static uint      ErrorsCount(IntPtr h)         => _lib.Value.iv_engine_errors_count(h);
        internal static uint      TakeErrorsPacked(IntPtr h, uint[] buf, uint n)
            => _lib.Value.iv_engine_take_errors_packed(h, buf, n);
        internal static IntPtr    SchemaColumnsJson(IntPtr h)   => _lib.Value.iv_engine_schema_columns_json(h);
        internal static IntPtr    InputColumnsJson(IntPtr h)    => _lib.Value.iv_engine_input_columns_json(h);
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

    // ── Runtime library loader (avoids DllImport limitation on dynamic names) ──

    internal sealed class NativeLib
    {
        private readonly IntPtr _handle;

        internal NativeLib(string path)
        {
            _handle = NativeLibrary.Load(path);
        }

        private T Get<T>(string name) where T : Delegate
            => Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(_handle, name));

        // Delegate types matching each C function signature.
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr EngineNewFn(
            [MarshalAs(UnmanagedType.LPStr)] string schema,
            uint maxErrors, byte emitNorm, IntPtr errBuf, uint errBufLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate void EngineDestroyFn(IntPtr h);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int PushChunkFn(IntPtr h, IntPtr data, uint len,
                                           byte final_, ref IvProgress progress);

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
        internal delegate IntPtr TakeNormalizedFn(IntPtr h, out uint outLen);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate IntPtr ErrorCodeToStringFn(byte code);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate void FreeStringFn(IntPtr p);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate void FreeBytesFn(IntPtr p, uint len);

        // Lazily resolved function pointers.
        private EngineNewFn?          _engNew;
        private EngineDestroyFn?      _engDestroy;
        private PushChunkFn?          _pushChunk;
        private ErrorsCountFn?        _errCount;
        private TakeErrorsPackedFn?   _takePacked;
        private SchemaColumnsJsonFn?  _schemaCols;
        private InputColumnsJsonFn?   _inputCols;
        private TakeNormalizedFn?     _takeNorm;
        private ErrorCodeToStringFn?  _errStr;
        private FreeStringFn?         _freeStr;
        private FreeBytesFn?          _freeBytes;

        internal IntPtr iv_engine_new(string s, uint m, byte e, IntPtr buf, uint bl)
            => (_engNew ??= Get<EngineNewFn>("iv_engine_new"))(s, m, e, buf, bl);
        internal void iv_engine_destroy(IntPtr h)
            => (_engDestroy ??= Get<EngineDestroyFn>("iv_engine_destroy"))(h);
        internal int iv_engine_push_chunk(IntPtr h, IntPtr d, uint l, byte f, ref IvProgress p)
            => (_pushChunk ??= Get<PushChunkFn>("iv_engine_push_chunk"))(h, d, l, f, ref p);
        internal uint iv_engine_errors_count(IntPtr h)
            => (_errCount ??= Get<ErrorsCountFn>("iv_engine_errors_count"))(h);
        internal uint iv_engine_take_errors_packed(IntPtr h, uint[] buf, uint n)
            => (_takePacked ??= Get<TakeErrorsPackedFn>("iv_engine_take_errors_packed"))(h, buf, n);
        internal IntPtr iv_engine_schema_columns_json(IntPtr h)
            => (_schemaCols ??= Get<SchemaColumnsJsonFn>("iv_engine_schema_columns_json"))(h);
        internal IntPtr iv_engine_input_columns_json(IntPtr h)
            => (_inputCols ??= Get<InputColumnsJsonFn>("iv_engine_input_columns_json"))(h);
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

    /// Progress snapshot for a single PushChunk call.
    public record ChunkProgress(uint RowsProcessed, uint ErrorsAdded, bool Done);

    /// A single validation error.
    public record ValidationError(
        uint   Row,       // 1-based data row number
        uint   Col,       // 0-based column index
        string Kind,      // "schema" or "input"
        byte   Code,      // numeric error code
        string CodeName   // e.g. "InvalidType"
    )
    {
        public override string ToString() =>
            $"row={Row} col={Col} [{Kind}] {CodeName} ({Code})";
    }

    // ── Engine ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Streaming CSV validation engine. Use inside a <c>using</c> block or call
    /// <see cref="Dispose"/> when done to release native memory.
    /// </summary>
    public sealed class Engine : IDisposable
    {
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
            byte[] errBuf = new byte[512];
            var pin = GCHandle.Alloc(errBuf, GCHandleType.Pinned);
            IntPtr handle;
            try
            {
                handle = Native.EngineNew2(
                    schemaJson, maxErrors,
                    emitNormalized ? (byte)1 : (byte)0,
                    pin.AddrOfPinnedObject(), 512);
            }
            finally { pin.Free(); }

            if (handle == IntPtr.Zero)
            {
                string msg = Encoding.UTF8.GetString(errBuf, 0, Array.IndexOf(errBuf, (byte)0));
                throw new InvalidOperationException($"Engine init failed: {msg}");
            }
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

        // ── Processing ───────────────────────────────────────────────────────

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
            if (ret != 0) throw new InvalidOperationException("PushChunk failed (null handle)");
            return new ChunkProgress(prog.RowsProcessed, prog.ErrorsAdded, prog.Done != 0);
        }

        /// <inheritdoc cref="PushChunk(ReadOnlySpan{byte}, bool)"/>
        public ChunkProgress PushChunk(byte[] chunk, bool final = false)
            => PushChunk(new ReadOnlySpan<byte>(chunk), final);

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
            for (uint i = 0; i < pairs; i++)
                list.Add(DecodeError(buf[i * 2], buf[i * 2 + 1]));
            return list;
        }

        // ── Metadata ─────────────────────────────────────────────────────────

        /// <summary>Schema column names in schema order.</summary>
        public List<string> SchemaColumns()
        {
            CheckOpen();
            return TakeJsonList(Native.SchemaColumnsJson(_handle));
        }

        /// <summary>Input CSV header column names in input order.</summary>
        public List<string> InputColumns()
        {
            CheckOpen();
            return TakeJsonList(Native.InputColumnsJson(_handle));
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

        private static ValidationError DecodeError(uint word0, uint word1)
        {
            uint row  = word0;
            byte code = (byte)(word1 & 0xFF);
            uint col  = (word1 >> 8) & 0x7FFFFF;
            string kind = ((word1 >> 31) & 1) == 1 ? "input" : "schema";
            string name = ErrorCodeName(code);
            return new ValidationError(row, col, kind, code, name);
        }

        private static List<string> TakeJsonList(IntPtr ptr)
        {
            if (ptr == IntPtr.Zero) return new List<string>();
            string json = Marshal.PtrToStringAnsi(ptr) ?? "[]";
            Native.FreeString(ptr);
            return JsonSerializer.Deserialize<List<string>>(json) ?? new List<string>();
        }

        /// <summary>Returns the stable name for a numeric error code.</summary>
        public static string ErrorCodeName(byte code)
        {
            IntPtr ptr = Native.ErrorCodeToString(code);
            if (ptr == IntPtr.Zero) return "Unknown";
            string name = Marshal.PtrToStringAnsi(ptr) ?? "Unknown";
            Native.FreeString(ptr);
            return name;
        }
    }

    // ── ValidationResult ─────────────────────────────────────────────────────

    /// <summary>Result of a full Validator.ValidateBytes / ValidateFile call.</summary>
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

            return new ValidationResult(
                engine.TakeErrors(maxErrors),
                engine.SchemaColumns(),
                engine.InputColumns(),
                emitNormalized ? engine.TakeNormalized() : Array.Empty<byte>());
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

            return new ValidationResult(
                engine.TakeErrors(maxErrors),
                engine.SchemaColumns(),
                engine.InputColumns(),
                emitNormalized ? engine.TakeNormalized() : Array.Empty<byte>());
        }
    }
}
