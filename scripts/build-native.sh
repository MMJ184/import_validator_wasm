#!/usr/bin/env bash
# Build the native ImportValidator shared library for the host platform.
#
# Output locations:
#   macOS:   crates/validator/target/release/libimport_validator.dylib
#   Linux:   crates/validator/target/release/libimport_validator.so
#   Windows: crates/validator/target/release/import_validator.dll
#
# Optional: pass --features pattern to include the regex engine.
# Optional: pass --target <triple> for cross-compilation (requires the toolchain).
# Optional: IV_NATIVE_CPU=native for host-tuned codegen (do NOT use for
#           binaries you distribute to other machines).
#
# Usage:
#   ./scripts/build-native.sh
#   ./scripts/build-native.sh --features pattern
#   ./scripts/build-native.sh --target x86_64-unknown-linux-gnu
#   IV_NATIVE_CPU=native ./scripts/build-native.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$REPO_ROOT/crates/validator"

if [[ "${IV_NATIVE_CPU:-}" != "" ]]; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C target-cpu=${IV_NATIVE_CPU}"
  echo "[build-native] RUSTFLAGS: $RUSTFLAGS"
fi

echo "[build-native] building native cdylib..."
cd "$CRATE_DIR"
cargo build --release "$@"

# Determine the produced library path and display it.
TRIPLE=$(rustc -vV | grep 'host:' | awk '{print $2}')
case "$TRIPLE" in
  *-apple-darwin)   LIB="libimport_validator.dylib" ;;
  *-linux-*)        LIB="libimport_validator.so"    ;;
  *-windows-*)      LIB="import_validator.dll"      ;;
  *)                LIB="(unknown extension for $TRIPLE)" ;;
esac

echo "[build-native] done → crates/validator/target/release/$LIB"
