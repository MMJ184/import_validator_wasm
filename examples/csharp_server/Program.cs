// C# ASP.NET Core minimal API — CSV validation via ImportValidator native library.
//
// Prerequisites:
//   ./scripts/build-native.sh             # build the native library
//   set IMPORT_VALIDATOR_LIB to the .dll/.dylib/.so path
//   dotnet run
//
// Endpoints:
//   POST /validate        multipart form-data: 'file' (CSV), 'schema' (JSON string)
//   POST /validate/json   JSON body: { "csv": "<base64>", "schema": {...} }

using System.Text.Json;
using ImportValidator;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();

// ── Set the native library path ───────────────────────────────────────────────
// IMPORT_VALIDATOR_LIB env-var is read automatically by the binding.
// Or set it explicitly here before the first Engine is created:
//   Engine.LibraryName = "/path/to/libimport_validator_wasm.dylib";

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
        kind     = e.Kind,
        code     = e.Code,
        codeName = e.CodeName,
        message  = e.ToString(),
    }),
    schemaColumns = result.SchemaColumns,
    inputColumns  = result.InputColumns,
};
