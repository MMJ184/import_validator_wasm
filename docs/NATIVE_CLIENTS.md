# Native Client Integration Guide

ImportValidator ships a browser-side WebAssembly SDK and a **native shared library** for server-side use from any language that supports C FFI.

---

## Get the native library

### Option A — Prebuilt binaries (no Rust required)

Every tagged release (and any manual run of the *Release Native Libraries*
workflow) produces prebuilt libraries for Linux x86_64, macOS arm64, and
Windows x86_64 — each in a default and a `-pattern` (regex-enabled) variant —
plus the C header. Download from the GitHub Release assets (or the workflow
artifacts) and point your binding at the file:

| Platform | Asset |
|---|---|
| Linux x86_64 | `import-validator-linux-x86_64.so` |
| macOS arm64 | `import-validator-macos-arm64.dylib` |
| Windows x86_64 | `import-validator-windows-x86_64.dll` |

### Option B — Build from source

**Prerequisite**: Rust toolchain installed (`curl https://sh.rustup.rs | sh`).

```bash
# From the repository root:
./scripts/build-native.sh

# With regex support (pattern / regexReplacePattern schema fields):
./scripts/build-native.sh --features pattern
```

Output locations:

| Platform | File |
|---|---|
| macOS  | `crates/validator/target/release/libimport_validator_wasm.dylib` |
| Linux  | `crates/validator/target/release/libimport_validator_wasm.so`    |
| Windows | `crates/validator/target/release/import_validator_wasm.dll`      |

The C header with full documentation is at `bindings/include/import_validator.h`.

---

## Node.js

The `@import-validator/node` workspace package wraps the WASM engine directly (no Web Worker, no browser APIs).

### Build

```bash
pnpm --filter @import-validator/core run build:wasm
pnpm --filter @import-validator/core run build:pkg
pnpm --filter @import-validator/node run build
```

### API

```js
import { init, validateFile, validateBuffer, validateStream, Engine } from "@import-validator/node";

const schema = {
  hasHeaders: true,
  columns: [
    { name: "id",    type: "int",   required: true },
    { name: "email", type: "email", required: true, unique: true },
    { name: "name",  type: "string", required: true },
  ],
};

// Optional: warm up at server startup to avoid init latency on first request.
await init();

// ── One-shot: validate a file ─────────────────────────────────────────────
const result = await validateFile("data.csv", schema, { maxErrors: 10_000 });

if (!result.valid) {
  for (const err of result.errors) {
    console.log(err.message); // "Row 3, column "email": invalid email format"
  }
}

// ── One-shot: validate a Buffer ───────────────────────────────────────────
const buf = await fs.promises.readFile("data.csv");
const result2 = await validateBuffer(buf, schema);

// ── Streaming: any AsyncIterable<Uint8Array> ──────────────────────────────
const result3 = await validateStream(nodeReadableStream, schema, {
  onProgress: (p) => console.log(`${p.rowsProcessed} rows processed`),
});

// ── Low-level Engine (for advanced use) ──────────────────────────────────
const engine = await Engine.create(schema, 10_000, false);
engine.pushChunk(chunk1, false);
engine.pushChunk(chunk2, true); // final=true flushes the parser
const errors = engine.takeErrorsDecoded(10_000);
```

### ValidationResult shape

```ts
{
  valid: boolean;
  errors: DecodedError[];  // { row, code, codeString, colIndex, colKind, columnName, message }
  schemaColumns: string[];
  inputColumns: string[];
  normalized?: Uint8Array; // when emitNormalized: true
  rowsProcessed: number;
}
```

### Express server example

See `examples/node_express/server.mjs`.

---

## Python

Uses stdlib `ctypes` — zero additional dependencies.

### Setup

```bash
export IMPORT_VALIDATOR_LIB=/path/to/libimport_validator_wasm.dylib  # or .so / .dll
```

Or copy the library next to `import_validator.py`.

### API

```python
import sys
sys.path.insert(0, "bindings/python")
import import_validator as iv

# Optional explicit load:
iv.load_library("/path/to/libimport_validator_wasm.dylib")

schema = json.dumps({
    "hasHeaders": True,
    "columns": [
        {"name": "id",    "type": "int",   "required": True},
        {"name": "email", "type": "email", "required": True, "unique": True},
        {"name": "name",  "type": "string","required": True},
    ]
})

# ── One-shot: bytes ───────────────────────────────────────────────────────
result = iv.validate_bytes(csv_bytes, schema, max_errors=10_000)
print(result.valid, result.errors)

# ── One-shot: file ────────────────────────────────────────────────────────
result = iv.validate_file("data.csv", schema)

# ── Streaming Engine ──────────────────────────────────────────────────────
with iv.Engine(schema, max_errors=1000, emit_normalized=True) as eng:
    for chunk in my_chunks:
        prog = eng.push_chunk(chunk)          # ChunkProgress(rows_processed, errors_added, done)
    eng.push_chunk(b"", final=True)
    errors = eng.take_errors()               # List[ValidationError]
    norm   = eng.take_normalized()           # bytes
    cols   = eng.schema_columns()            # List[str]
```

### ValidationError fields

| Field | Type | Description |
|---|---|---|
| `row` | `int` | 1-based data row (0 = header-level) |
| `col` | `int` | 0-based column index |
| `kind` | `str` | `"schema"` or `"input"` |
| `code` | `int` | Numeric error code |
| `code_name` | `str` | e.g. `"InvalidType"` |

### Flask server example

See `examples/python_server/app.py`.

---

## C#

Targets .NET 6+. Uses `NativeLibrary.Load` so the DLL path is set at runtime — no hard-coded `DllImport` paths.

### Setup

```csharp
// Set once before first use (or via IMPORT_VALIDATOR_LIB env-var):
Engine.LibraryName = "/path/to/libimport_validator_wasm.dylib";
```

### API

```csharp
using ImportValidator;

var schema = """
    {
      "hasHeaders": true,
      "columns": [
        {"name":"id",    "type":"int",   "required":true},
        {"name":"email", "type":"email", "required":true,"unique":true},
        {"name":"name",  "type":"string","required":true}
      ]
    }
    """;

// ── One-shot: bytes ───────────────────────────────────────────────────────
byte[] csv = File.ReadAllBytes("data.csv");
var result = Validator.ValidateBytes(csv, schema, maxErrors: 10_000);

if (!result.IsValid)
    foreach (var e in result.Errors)
        Console.WriteLine(e); // "row=3 col=1 [schema] InvalidEmail (9)"

// ── One-shot: file ────────────────────────────────────────────────────────
var result2 = Validator.ValidateFile("data.csv", schema);

// ── Streaming Engine ──────────────────────────────────────────────────────
using var engine = new Engine(schema, maxErrors: 10_000, emitNormalized: true);

foreach (var chunk in GetChunks())
    engine.PushChunk(chunk);
engine.PushChunk(ReadOnlySpan<byte>.Empty, final: true);

var errors     = engine.TakeErrors();        // List<ValidationError>
var normalized = engine.TakeNormalized();    // byte[]
var cols       = engine.SchemaColumns();     // List<string>
```

### ValidationError fields

| Property | Type | Description |
|---|---|---|
| `Row` | `uint` | 1-based data row (0 = header-level) |
| `Col` | `uint` | 0-based column index |
| `Kind` | `string` | `"schema"` or `"input"` |
| `Code` | `byte` | Numeric error code |
| `CodeName` | `string` | e.g. `"InvalidType"` |

### ASP.NET Core example

See `examples/csharp_server/Program.cs`.

---

## Go

Uses CGO to call the C-ABI functions directly.

### Setup

```bash
# Point CGO to the header and library:
export CGO_CFLAGS="-I$(pwd)/bindings/include"
export LIBRARY_PATH=$(pwd)/crates/validator/target/release
export DYLD_LIBRARY_PATH=$LIBRARY_PATH    # macOS
export LD_LIBRARY_PATH=$LIBRARY_PATH      # Linux
```

### API

```go
import iv "github.com/yourorg/import-validator/bindings/go"

// ── One-shot: file ────────────────────────────────────────────────────────
result, err := iv.ValidateFile("data.csv", schemaJSON, 10_000, false, 0)
if err != nil { log.Fatal(err) }
for _, e := range result.Errors {
    fmt.Println(e) // "row=3 col=1 [schema] InvalidEmail (9)"
}

// ── One-shot: bytes ───────────────────────────────────────────────────────
result, err := iv.ValidateBytes(csvBytes, schemaJSON, 10_000, false)

// ── One-shot: io.Reader ───────────────────────────────────────────────────
f, _ := os.Open("data.csv")
defer f.Close()
result, err := iv.ValidateReader(f, schemaJSON, 10_000, false, 0)

// ── Streaming Engine ──────────────────────────────────────────────────────
engine, err := iv.NewEngine(schemaJSON, 10_000, false)
if err != nil { log.Fatal(err) }
defer engine.Close()

for _, chunk := range chunks {
    _, err = engine.PushChunk(chunk, false)
}
_, err = engine.PushChunk(nil, true)  // final flush

errors := engine.TakeErrors(10_000)
cols   := engine.SchemaColumns()
```

### ValidationError fields

| Field | Type | Description |
|---|---|---|
| `Row` | `uint32` | 1-based data row (0 = header-level) |
| `Col` | `uint32` | 0-based column index |
| `Kind` | `string` | `"schema"` or `"input"` |
| `Code` | `uint8` | Numeric error code |
| `CodeName` | `string` | e.g. `"InvalidType"` |

### Go HTTP server example

See `examples/go_server/main.go`.

---

## Error codes reference

| Code | Name | Meaning |
|---|---|---|
| 1 | `MissingRequired` | Required field is empty |
| 2 | `InvalidType` | Value fails type check (int, email, date, …) |
| 3 | `MaxLengthExceeded` | Value longer than `maxLen` |
| 4 | `NotAllowed` | Value not in `allowed[]` list |
| 5 | `InvalidUtf8` | Bytes are not valid UTF-8 |
| 6 | `MissingRequiredColumn` | Required column absent from CSV header |
| 7 | `ExtraColumn` | Unexpected column when `failOnExtraColumns: true` |
| 8 | `MinLengthNotMet` | Value shorter than `minLen` |
| 9 | `InvalidEmail` | Email validation failed |
| 10 | `PatternMismatch` | Value does not match `pattern` regex (full build only) |
| 11 | `PrecisionExceeded` | Decimal exceeds `precision` + `strictPrecision: true` |
| 12 | `ColumnCountMismatch` | Row column count ≠ `totalColumns` |
| 13 | `DuplicateValue` | Value violates `unique: true` |
| 14 | `DuplicateCombination` | Row violates a `uniqueGroups` constraint |

---

## Schema reference

Full schema JSON contract: `docs/validation-config.schema.json`

Minimal example schema:

```json
{
  "schemaVersion": 1,
  "hasHeaders": true,
  "delimiter": ",",
  "columns": [
    {
      "name": "id",
      "type": "int",
      "required": true
    },
    {
      "name": "email",
      "type": "email",
      "required": true,
      "unique": true,
      "modifiers": { "trim": true, "lowercase": true }
    },
    {
      "name": "amount",
      "type": "decimal",
      "precision": 2,
      "nullable": true,
      "modifiers": { "decimalScale": 2 }
    },
    {
      "name": "created_at",
      "type": "date",
      "dateFormat": "yyyy-mm-dd"
    }
  ],
  "uniqueGroups": [
    { "name": "id_email_key", "columns": ["id", "email"] }
  ]
}
```

---

## Distribution checklist

When shipping the native library to a client:

1. Build for each target platform (macOS arm64/x86, Linux x86_64, Windows x64).
2. Ship the `.dylib`/`.so`/`.dll` alongside your application.
3. Set `IMPORT_VALIDATOR_LIB` (Python / C#) or `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` (Go).
4. For the Node.js package: bundle `@import-validator/core` + `@import-validator/node` together — the WASM binary is in `@import-validator/core/dist/wasm/pkg/`.
5. The Node.js WASM path auto-resolves via `import.meta.url` — no manual config needed.
