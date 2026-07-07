// C# ASP.NET Core minimal API — CSV + Excel (XLSX) validation via the
// ImportValidator native library (bindings/csharp).
//
// Prerequisites (run from the repo root):
//   ./scripts/build-native.sh             # build the native library
//   export IMPORT_VALIDATOR_LIB=$PWD/crates/validator/target/release/libimport_validator.dylib
//                                         # .so on Linux, import_validator.dll on Windows
//   cd examples/csharp_server && dotnet run
//
// Endpoints:
//   POST /validate        multipart form-data: 'file' (CSV), 'schema' (JSON string)
//   POST /validate/json   JSON body: { "csv": "<base64>", "schema": {...} }
//   POST /validate-xlsx   multipart form-data: 'file' (.xlsx), 'schema' (JSON string)

using System.Text.Json;
using ImportValidator;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();

// The binding locates the native library through the IMPORT_VALIDATOR_LIB
// environment variable (or the platform's default library search path).

app.Logger.LogInformation("ImportValidator C# server starting…");

// ── POST /validate (multipart) ───────────────────────────────────────────────
app.MapPost("/validate", async (HttpRequest request) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart/form-data" });

    var form = await request.ReadFormAsync();
    var schemaStr = form["schema"].FirstOrDefault();
    var file      = form.Files.GetFile("file");

    if (string.IsNullOrEmpty(schemaStr))
        return Results.BadRequest(new { error = "Missing 'schema' field" });
    if (file is null)
        return Results.BadRequest(new { error = "Missing 'file' field" });

    using var ms = new MemoryStream();
    await file.CopyToAsync(ms);
    var csvBytes = ms.ToArray();

    try
    {
        var result = Validator.ValidateBytes(csvBytes, schemaStr, maxErrors: 10_000);
        return Results.Ok(FormatResult(result));
    }
    catch (Exception ex)
    {
        return Results.UnprocessableEntity(new { error = ex.Message });
    }
});

// ── POST /validate/json ──────────────────────────────────────────────────────
app.MapPost("/validate/json", async ([FromBody] JsonElement body) =>
{
    if (!body.TryGetProperty("csv", out var csvProp))
        return Results.BadRequest(new { error = "Missing 'csv' field" });
    if (!body.TryGetProperty("schema", out var schemaProp))
        return Results.BadRequest(new { error = "Missing 'schema' field" });

    byte[] csvBytes;
    try
    {
        csvBytes = Convert.FromBase64String(csvProp.GetString() ?? "");
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = $"Invalid base64 CSV: {ex.Message}" });
    }

    var schemaStr = schemaProp.GetRawText();

    try
    {
        var result = Validator.ValidateBytes(csvBytes, schemaStr, maxErrors: 10_000);
        return Results.Ok(FormatResult(result));
    }
    catch (Exception ex)
    {
        return Results.UnprocessableEntity(new { error = ex.Message });
    }
});

// ── POST /validate-xlsx (multipart, Excel .xlsx) ─────────────────────────────
//
// The workbook is buffered fully in memory before validation: XLSX is a ZIP
// container and its central directory sits at the END of the file, so the
// engine needs random access over the complete byte buffer — an upload stream
// cannot be fed to it chunk by chunk the way CSV can.
app.MapPost("/validate-xlsx", async (HttpRequest request) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart/form-data" });

    var form = await request.ReadFormAsync();
    var schemaStr = form["schema"].FirstOrDefault();
    var file      = form.Files.GetFile("file");

    if (string.IsNullOrEmpty(schemaStr))
        return Results.BadRequest(new { error = "Missing 'schema' field" });
    if (file is null)
        return Results.BadRequest(new { error = "Missing 'file' field" });

    using var ms = new MemoryStream();
    await file.CopyToAsync(ms);
    var xlsxBytes = ms.ToArray();

    try
    {
        var result = Validator.ValidateXlsxBytes(xlsxBytes, schemaStr, maxErrors: 10_000);
        return Results.Ok(FormatResult(result));
    }
    catch (Exception ex)
    {
        return Results.UnprocessableEntity(new { error = ex.Message });
    }
});

app.Run();

// ── Helper ───────────────────────────────────────────────────────────────────
static object FormatResult(ValidationResult result) => new
{
    valid        = result.IsValid,
    errorCount   = result.Errors.Count,
    errors       = result.Errors.Select(e => new
    {
        row      = e.Row,
        col      = e.Col,
        column   = e.ColumnName,
        kind     = e.Kind,
        code     = e.Code,
        codeName = e.CodeName,
        message  = e.Message,
    }),
    schemaColumns = result.SchemaColumns,
    inputColumns  = result.InputColumns,
};
