# Modifier And Validation Task Plan

## Goal
Support strong data correction plus validation in import-validator:
- prefix/suffix for names and strings,
- trim and whitespace cleanup,
- numeric modifiers (`ceil`, `floor`, `round`, `decimalScale`),
- duplicate value checks,
- keep existing validation behavior stable.

## Phase 1 (Implemented)
- Add schema-level column modifiers (`modifiers`) with:
  - `trim`
  - `collapseWhitespace`
  - `lowercase`
  - `uppercase`
  - `prefix`
  - `suffix`
  - `ceil`
  - `floor`
  - `round`
  - `decimalScale`
- Add column-level duplicate check:
  - `unique: true`
  - new error code `DuplicateValue`
- Apply modifiers in both:
  - validation path
  - normalized output path
- Extend config contract:
  - `docs/validation-config.schema.json`

## Phase 2 (Implemented)
- Add worker test coverage for:
  - trim/prefix/suffix behavior
  - decimal scale normalization
  - duplicate detection
- Add demo controls in `examples/vite-ts-demo` to toggle modifier scenarios.

## Phase 3 (Implemented)
- Add advanced modifiers:
  - substring / replace / regex replace
  - title-case transform
  - custom null tokens (`"N/A"`, `"NULL"`, `"-"`)
- Add row-level composite uniqueness:
  - unique key across multiple columns.

## Phase 4 (Open — not started)
- Add prebuilt customer profiles for common data domains:
  - names/emails/phone/address normalization packs
  - finance amount precision packs
  - compliance-focused strict duplicate policy packs.

Note: `docs/customer-profiles.json` is NOT this deliverable — it holds
runtime tuning presets (limits/profiles per tenant). Phase 4 is about
reusable schema/modifier packs and remains fully open.
