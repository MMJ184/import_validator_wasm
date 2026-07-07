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
foreach (var chunk in ReadChunks(stream))
    engine.PushChunk(chunk);                    // ReadOnlySpan<byte>
engine.PushChunk(Array.Empty<byte>(), final: true);

var errors = engine.TakeErrors();               // List<ValidationError>
byte[] normalized = engine.TakeNormalized();
uint rows = engine.RowsProcessed;
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
