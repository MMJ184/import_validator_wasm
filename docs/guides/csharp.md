# C# / .NET Integration Guide

CSV + Excel validation from .NET via the native library and the P/Invoke
binding (`netstandard2.1` — works on .NET 6/7/8+). Zero NuGet dependencies.

## Get the library + binding

1. Native library: prebuilt release or `./scripts/build-native.sh` →
   `libimport_validator.dylib` / `.so` / `import_validator.dll`
   (see [../NATIVE_CLIENTS.md](../NATIVE_CLIENTS.md)).
2. Reference the binding project:

```xml
<ProjectReference Include="path/to/bindings/csharp/ImportValidator.csproj" />
```

3. Library resolution: place the native library next to your binary, set
   `IMPORT_VALIDATOR_LIB=/abs/path`, or set `Engine.LibraryName` before
   first use.

## Quick start — CSV

```csharp
using ImportValidator;

var schema = """
{
  "hasHeaders": true,
  "columns": [
    { "name": "id", "type": "int", "required": true, "unique": true },
    { "name": "email", "type": "email", "required": true,
      "modifiers": { "trim": true, "lowercase": true } }
  ]
}
""";

var result = Validator.ValidateBytes(File.ReadAllBytes("data.csv"), schema);
Console.WriteLine(result.IsValid);
foreach (var e in result.Errors)
{
    // e.Row, e.Col, e.Kind, e.Code, e.CodeName, e.ColumnName, e.Message
    Console.WriteLine(e.Message);   // Row 2, column "email": invalid email format
}
```

Also: `Validator.ValidateFile(path, schema, maxErrors, emitNormalized)`.

With `emitNormalized: true` these one-shot helpers materialize the *entire*
normalized output as a single `byte[]` in `result.Normalized` — expect memory
proportional to the output size (plus a transient copy while the chunks are
concatenated). For very large files, stream with `Engine` instead and write
each `TakeNormalized()` piece straight to its destination.

## `maxErrors` and `ErrorsSuppressed`

`maxErrors` caps how many errors are **recorded**, never how much of the file
is validated. The engine always reads, counts and validates every row, so
`RowsProcessed` is a true total no matter how many errors it hits.

Errors found once the cap is reached are still counted, and surfaced as
`ErrorsSuppressed` (`ulong`) on both `ValidationResult` and `Engine`:

```csharp
var result = Validator.ValidateBytes(bytes, schema, maxErrors: 100);

// Exact number of problems in the file — not a floor, not an estimate.
ulong total = (ulong)result.Errors.Count + result.ErrorsSuppressed;

Console.WriteLine(result.ErrorsSuppressed > 0
    ? $"Showing {result.Errors.Count} of {total} problems"
    : $"{total} problems");
```

For the one-shot `Validator.*` helpers `maxErrors` is an effective per-file
total: they drain only at the end, so the detail you get back is the first
`maxErrors` errors and the rest are summarized by `ErrorsSuppressed`. Nothing
is dropped silently. `IsValid` is true only when both are zero.

When you drive `Engine` yourself and call `TakeErrors()` between chunks, each
drain frees queue space, so `maxErrors` behaves as a per-drain budget rather
than a per-file one — you keep more detail, and `ErrorsSuppressed` still
counts only what genuinely never fit.

## Excel (.xlsx)

```csharp
var result = Validator.ValidateXlsxBytes(File.ReadAllBytes("data.xlsx"), schema);
var result2 = Validator.ValidateXlsxFile("data.xlsx", schema);
```

The engine handles ZIP + DEFLATE internally and streams the first worksheet.
Same schema, error codes, and normalized output as CSV.

## Streaming / advanced

```csharp
using var engine = new Engine(schema, maxErrors: 10_000, emitNormalized: true);
using var output = File.Create("normalized.csv");   // or any Stream
foreach (var chunk in ReadChunks(stream))
{
    engine.PushChunk(chunk);                    // ReadOnlySpan<byte>
    // Drain every chunk: the engine holds normalized bytes until you take
    // them, so taking only at the end buffers the whole output natively.
    output.Write(engine.TakeNormalized());
}
engine.PushChunk(Array.Empty<byte>(), final: true);
output.Write(engine.TakeNormalized());          // final flush

var errors = engine.TakeErrors();               // List<ValidationError>
uint  rows       = engine.RowsProcessed;        // every row, always
ulong suppressed = engine.ErrorsSuppressed;     // found but over the maxErrors cap
```

XLSX streaming (when you inflate yourself): `PushSharedStringsChunk(...)`
to completion first, then `PushSheetChunk(...)` — or the one-shot
`engine.ValidateXlsxBytes(bytes)`.

Threading: an `Engine` is NOT thread-safe — one engine per concurrent
validation. Invalid schemas / XLSX failures throw
`InvalidOperationException` carrying the engine's message; a disposed engine
throws `ObjectDisposedException`. `Engine.Version()` returns the native
engine version.

## Full server example

`examples/csharp_server/` — ASP.NET minimal API with `/validate` (CSV) and
`/validate-xlsx` endpoints, runnable with its own README.

More: schema contract → [../SCHEMA_REFERENCE.md](../SCHEMA_REFERENCE.md) ·
tuning → [../PERFORMANCE.md](../PERFORMANCE.md) ·
failures → [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
