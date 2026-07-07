# Documentation Index

Start here. Every document in this repository, grouped by who needs it.

## Understand the system (developers & AI agents)

| Doc | What it answers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How everything fits: components, data flow, XLSX/CSV paths, protocol, build pipeline, invariants |
| [CODE_MAP.md](./CODE_MAP.md) | Every file's purpose + "change here when…" recipes |
| [code-map-3d.html](./code-map-3d.html) | Interactive 3D graph of the codebase (open in a browser) |
| [PERFORMANCE.md](./PERFORMANCE.md) | Hot-path design, before/after numbers, tuning guide, memory model, limits |
| [BENCHMARKS.md](./BENCHMARKS.md) | Auto-generated benchmark tables (`pnpm run bench`) |
| [../CLAUDE.md](../CLAUDE.md) | Working instructions for AI agents in this repo |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Toolchain setup, build order, test recipes |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Build/runtime failure playbook |
| [CHANGELOG.md](./CHANGELOG.md) | Release history, breaking changes, upgrade notes |

## Integrate the product (customers)

| Doc | Language / surface |
|---|---|
| [guides/typescript-browser.md](./guides/typescript-browser.md) | Browser SDK (TypeScript/JavaScript) |
| [guides/node.md](./guides/node.md) | Node.js servers |
| [guides/python.md](./guides/python.md) | Python (ctypes over the native library) |
| [guides/csharp.md](./guides/csharp.md) | C# / .NET (P/Invoke) |
| [guides/go.md](./guides/go.md) | Go (cgo) |
| [guides/rust.md](./guides/rust.md) | Rust (crate dependency) |
| [NATIVE_CLIENTS.md](./NATIVE_CLIENTS.md) | Hub for the native-library guides + prebuilt binary matrix |
| [CLIENT_QUICKSTART.md](./CLIENT_QUICKSTART.md) | Redirects to guides/typescript-browser.md |
| [SDK_API.md](./SDK_API.md) | Full SDK reference: options, events, profiles, **fatal-code table (canonical)** |
| [SCHEMA_REFERENCE.md](./SCHEMA_REFERENCE.md) | Schema contract: fields, types, modifiers, **validation-code table (canonical)** |
| [validation-config.schema.json](./validation-config.schema.json) | Machine-readable schema contract (JSON Schema 2020-12) |
| [CUSTOMER_DISTRIBUTION.md](./CUSTOMER_DISTRIBUTION.md) | Kit generation + customer handoff |
| [customer-profiles.json](./customer-profiles.json) | Example per-tenant configuration envelopes |

## Operate & govern

| Doc | What it covers |
|---|---|
| [PRODUCT_READINESS.md](./PRODUCT_READINESS.md) | Multi-tenant policy, guardrails, production guidance |
| [ENGINEERING_STANDARDS.md](./ENGINEERING_STANDARDS.md) | CI gates, release standards, compatibility rules |
| [MODIFIER_TASKS.md](./MODIFIER_TASKS.md) | Modifier feature roadmap (Phase 4 open) |

Conventions: the fatal-code list lives ONLY in SDK_API.md and the
validation-code list ONLY in SCHEMA_REFERENCE.md — other docs link, never
copy. BENCHMARKS.md is machine-written; never hand-edit it.
