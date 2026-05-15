# Validation Schema Reference

This document describes every field of the validation schema passed to `createValidator({ schema })`.

The full machine-readable contract is in `validation-config.schema.json`.

---

## Top-Level Schema Fields

```ts
{
  hasHeaders: boolean,         // required — true if first row is a header row
  delimiter?: string | number, // default: "," — single char or ASCII byte value
  columns: ColumnSpec[],       // required — ordered list of column rules
  failOnExtraColumns?: boolean,// default: false — emit ExtraColumn error for unrecognized columns
  totalColumns?: number,       // strict total column count check (header + data rows)
  uniqueGroups?: UniqueGroup[] // composite uniqueness rules across multiple columns
}
```

### `delimiter`

Accepts a single-character string (`","`, `";"`, `"\t"`) or an ASCII byte integer (`44`, `59`, `9`).

---

## Column Fields (`columns[]`)

Each entry in `columns` maps to one column in the CSV/Excel file (matched by name when `hasHeaders: true`, by position when `hasHeaders: false`).

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Column name (matched against CSV header) |
| `type` | string | required | Data type — see types below |
| `required` | boolean | `false` | Error if value is empty |
| `nullable` | boolean | `false` | When `true`, empty values are allowed even if `required: true` |
| `unique` | boolean | `false` | Error if the same value appears more than once |
| `minLen` | integer | — | Minimum character length |
| `maxLen` | integer | — | Maximum character length |
| `allowed` | string[] | — | Allowlist of valid values (exact match after modifiers) |
| `precision` | integer | `2` | Decimal places (for `decimal` type) |
| `strictPrecision` | boolean | `false` | Error unless value has exactly `precision` decimal places |
| `dateFormat` | string | `"ymd-dash"` | Date format — see formats below |
| `pattern` | string | — | Regex pattern (requires full/pattern WASM build) |
| `modifiers` | object | — | Field transformation rules — see below |

### Column Types

| Type | Accepted Values | Notes |
|---|---|---|
| `string` | Any text | No type check beyond length/allowed |
| `int` | `[+|-]digits` | No decimals, no commas |
| `float` | IEEE 754 single | `parse::<f32>()`, must be finite |
| `double` | IEEE 754 double | `parse::<f64>()`, must be finite |
| `number` | int or double | Union of int and double rules |
| `decimal` | Fixed-point | No commas; scale ≤ precision; normalized to fixed scale |
| `email` | `local@domain.tld` | Must have `@`, non-empty local + domain, domain has `.` |
| `date` | Formatted date | Validated and normalized to `YYYY-MM-DD` |

### Date Formats

| `dateFormat` | Input Example | Normalized Output |
|---|---|---|
| `ymd-dash` (default) | `2024-01-31` | `2024-01-31` |
| `dmy-slash` | `31/01/2024` | `2024-01-31` |
| `mdy-slash` | `01/31/2024` | `2024-01-31` |

---

## Column Modifiers (`modifiers`)

Modifiers transform the raw field value **before** type validation runs. They apply in this order:

1. `trim`
2. `collapseWhitespace`
3. `substringStart` / `substringEnd`
4. `replaceFrom` / `replaceTo`
5. `regexReplacePattern` / `regexReplaceWith`
6. `lowercase` / `uppercase` / `titleCase`
7. `nullValues` check (treated as empty if matched)
8. `ceil` / `floor` / `round` / `decimalScale`
9. `prefix` / `suffix`

| Modifier | Type | Default | Description |
|---|---|---|---|
| `trim` | boolean | `true` | Strip leading/trailing ASCII whitespace |
| `collapseWhitespace` | boolean | `false` | Collapse internal whitespace runs to single space |
| `lowercase` | boolean | `false` | Convert to lowercase |
| `uppercase` | boolean | `false` | Convert to uppercase |
| `titleCase` | boolean | `false` | Capitalize first letter of each word |
| `prefix` | string | — | Prepend string to value |
| `suffix` | string | — | Append string to value |
| `substringStart` | integer | — | Slice value starting at char index |
| `substringEnd` | integer | — | Slice value ending at char index (exclusive) |
| `replaceFrom` | string | — | Literal string to replace (all occurrences) |
| `replaceTo` | string | `""` | Replacement string |
| `regexReplacePattern` | string | — | Regex pattern to replace (requires full build) |
| `regexReplaceWith` | string | `""` | Replacement for regex matches |
| `ceil` | boolean | `false` | Round numeric value up to integer |
| `floor` | boolean | `false` | Round numeric value down to integer |
| `round` | boolean | `false` | Round numeric value to nearest integer |
| `decimalScale` | integer | — | Round and fix decimal places (e.g. `2` → `"12.35"`) |
| `nullValues` | string[] | `[]` | Values to treat as empty (e.g. `["N/A", "NULL", "-"]`) |
| `nullValuesCaseInsensitive` | boolean | `true` | Case-insensitive null token matching |

> **`regexReplacePattern` requires the full WASM build** (`WASM_FEATURES=pattern`).  
> The fast/default build will throw `WASM_RUNTIME` at init if this field is present.

---

## Composite Uniqueness (`uniqueGroups[]`)

Enforce that the **combination** of values across multiple columns is unique per row.

```json
{
  "uniqueGroups": [
    {
      "name": "customer_email_key",
      "columns": ["customerId", "email"]
    }
  ]
}
```

- `name` — optional label for the group (does not affect behavior)
- `columns` — list of schema column names; all must be non-empty for the check to apply

Rows where any of the listed columns is empty are **skipped** (not flagged as duplicates).

Error code emitted: `DuplicateCombination` on the first listed column.

---

## Error Codes

| Code | Value | Triggered When |
|---|---|---|
| `MissingRequired` | 1 | Required field is empty |
| `InvalidType` | 2 | Value fails type check |
| `MaxLengthExceeded` | 3 | Value length > `maxLen` |
| `NotAllowed` | 4 | Value not in `allowed` list |
| `InvalidUtf8` | 5 | Field bytes are not valid UTF-8 |
| `MissingRequiredColumn` | 6 | Required column absent from header |
| `ExtraColumn` | 7 | Unrecognized column with `failOnExtraColumns: true` |
| `MinLengthNotMet` | 8 | Value length < `minLen` |
| `InvalidEmail` | 9 | Value fails email format check |
| `PatternMismatch` | 10 | Value does not match `pattern` regex (full build only) |
| `PrecisionExceeded` | 11 | Decimal scale > `precision` with `strictPrecision: true` |
| `ColumnCountMismatch` | 12 | Row column count ≠ `totalColumns` |
| `DuplicateValue` | 13 | Duplicate value in `unique: true` column |
| `DuplicateCombination` | 14 | Duplicate composite key in `uniqueGroups` |

`row === 0` in an error means the error is on the header row (e.g. `MissingRequiredColumn`).

---

## Full Schema Example

```json
{
  "hasHeaders": true,
  "delimiter": ",",
  "failOnExtraColumns": false,
  "uniqueGroups": [
    { "name": "id_email_key", "columns": ["id", "email"] }
  ],
  "columns": [
    {
      "name": "id",
      "type": "int",
      "required": true,
      "unique": true
    },
    {
      "name": "firstName",
      "type": "string",
      "required": true,
      "maxLen": 100,
      "modifiers": {
        "trim": true,
        "collapseWhitespace": true,
        "titleCase": true,
        "nullValues": ["N/A", "NULL"],
        "nullValuesCaseInsensitive": true
      }
    },
    {
      "name": "email",
      "type": "email",
      "required": true,
      "modifiers": {
        "trim": true,
        "lowercase": true
      }
    },
    {
      "name": "amount",
      "type": "decimal",
      "precision": 2,
      "strictPrecision": false,
      "modifiers": {
        "decimalScale": 2
      }
    },
    {
      "name": "status",
      "type": "string",
      "required": true,
      "allowed": ["active", "inactive", "pending"]
    },
    {
      "name": "createdAt",
      "type": "date",
      "dateFormat": "ymd-dash"
    }
  ]
}
```
