#!/usr/bin/env bash
# Build the native ImportValidator shared library for the host platform.
#
# Output locations:
#   macOS:   crates/validator/target/release/libimport_validator_wasm.dylib
#   Linux:   crates/validator/target/release/libimport_validator_wasm.so
#   Windows: crates/validator/target/release/import_validator_wasm.dll
#
# Optional: pass --features pattern to include the regex engine.
# Optional: pass --target <triple> for cross-compilation (requires the toolchain).
#
# Usage:
#   ./scripts/build-native.sh
#   ./scripts/build-native.sh --features pattern
#   ./scripts/build-native.sh --target x86_64-unknown-linux-gnu

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$REPO_ROOT/crates/validator"

echo "[build-native] building native cdylib..."
cd "$CRATE_DIR"
cargo build --release "$@"

# Determine the produced library path and display it.
TRIPLE=$(rustc -vV | grep 'host:' | awk '{print $2}')
case "$TRIPLE" in
  *-apple-darwin)   LIB="libimport_validator_wasm.dylib" ;;
  *-linux-*)        LIB="libimport_validator_wasm.so"    ;;
  *-windows-*)      LIB="import_validator_wasm.dll"      ;;
  *)                LIB="(unknown extension for $TRIPLE)" ;;
esac

echo "[build-native] done → crates/validator/target/release/$LIB"
