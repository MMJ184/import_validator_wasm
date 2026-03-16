# CSV/XLSX Generator Example

Generates schema-compliant CSV and XLSX files for testing uploads.

Columns generated (customer-style):
- `customerId` (int)
- `idNumber` (int)
- `firstName` (string)
- `middleName` (nullable string)
- `lastName` (string)
- `surname` (nullable string)
- `email` (email)
- `alternateEmail` (nullable email)
- `phoneNumber` (string)
- `alternatePhone` (nullable string)
- `addressLine1` (string)
- `addressLine2` (nullable string)
- `city` (fixed values)
- `state` (fixed values)
- `postalCode` (6-digit string)
- `countryCode` (fixed values)
- `gender` (fixed values)
- `kycVerified` (fixed values)
- `customerTier` (fixed values)
- `amount` (decimal, 2 precision)
- `taxAmount` (decimal, 2 precision)
- `discountRate` (double)
- `creditScore` (number)
- `dateOfBirth` (date `yyyy-mm-dd`)
- `joiningDate` (date `yyyy-mm-dd`)
- `lastLoginDate` (date `yyyy-mm-dd`)
- `accountStatus` (fixed values)
- `preferredLanguage` (fixed values)
- `notes` (nullable string)

## Output
Default preset:
- demo_100.csv
- demo_1000.csv
- demo_10000.csv
- demo_50000.csv
- demo_100000.csv
- demo_250000.csv
- demo_500000.csv
- demo_1000000.csv
- demo_2000000.csv
- demo_3000000.csv

Excel sample preset:
- demo_100.xlsx
- demo_1000.xlsx
- demo_10000.xlsx
- demo_25000.xlsx
- demo_50000.xlsx
- demo_100000.xlsx

Large preset:
- demo_10000000.csv
- demo_100000000.csv

Extreme preset:
- demo_1000000000.csv

## Run

```bash
pnpm --dir examples/csv-generator exec ts-node generate.ts
```

```bash
# Generate XLSX samples
pnpm --dir examples/csv-generator exec ts-node generate.ts --format=xlsx --overwrite
```

```bash
# Generate larger XLSX samples
pnpm --dir examples/csv-generator exec ts-node generate.ts --format=xlsx --sizes=25000,50000,100000 --overwrite
```

```bash
# Generate both CSV + XLSX for small sizes
pnpm --dir examples/csv-generator exec ts-node generate.ts --format=both --sizes=100,1000,10000 --overwrite
```

```bash
# Regenerate large files
pnpm --dir examples/csv-generator exec ts-node generate.ts --preset=large --overwrite
```

```bash
# Regenerate all (default + large + extreme)
pnpm --dir examples/csv-generator exec ts-node generate.ts --preset=all --overwrite
```

`--preset=extreme` (100cr) can take hours and very large disk space (~250GB+).

```bash
# Custom sizes
pnpm --dir examples/csv-generator exec ts-node generate.ts --format=csv --sizes=100,1000,10000000 --overwrite
```

`--format=xlsx` supports up to `100000` rows per file in this example generator.
