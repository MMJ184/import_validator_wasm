//! 128-bit content fingerprints for uniqueness tracking.
//!
//! Unique columns and composite unique groups store fingerprints instead of
//! owning every cell value: memory stays ~24 bytes per distinct value
//! regardless of value length, which keeps unique columns viable on very
//! large files inside 32-bit WASM memory.

use std::hash::{BuildHasherDefault, Hasher};

/// Single-pass xxh3 128-bit fingerprint. Collision odds at 10M distinct
/// values are ~1e-19 — far below hardware error rates. Inputs are not
/// adversarial in a way that matters: a crafted collision could only cause a
/// spurious duplicate error, never skip validation.
#[inline]
pub fn fingerprint128(value: &str) -> u128 {
    xxhash_rust::xxh3::xxh3_128(value.as_bytes())
}

/// Identity-style hasher for `HashSet<u128>` fingerprint sets. The key is
/// already a uniform hash, so re-hashing it through SipHash (the std default)
/// is pure overhead; folding the two halves preserves uniformity.
#[derive(Default, Clone)]
pub struct FpHasher(u64);

impl Hasher for FpHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        // Generic fallback (not used for u128 keys, but must stay correct).
        let mut v = 0u64;
        for chunk in bytes.chunks(8) {
            let mut b = [0u8; 8];
            b[..chunk.len()].copy_from_slice(chunk);
            v ^= u64::from_le_bytes(b);
        }
        self.0 ^= v;
    }

    #[inline]
    fn write_u128(&mut self, i: u128) {
        self.0 = (i as u64) ^ ((i >> 64) as u64);
    }
}

pub type FpBuildHasher = BuildHasherDefault<FpHasher>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn fingerprints_differ_for_different_values() {
        assert_ne!(fingerprint128("a"), fingerprint128("b"));
        assert_ne!(fingerprint128(""), fingerprint128("\u{0}"));
        assert_ne!(fingerprint128("ab"), fingerprint128("a\u{1f}b"));
    }

    #[test]
    fn fingerprint_set_detects_duplicates() {
        let mut set: HashSet<u128, FpBuildHasher> = HashSet::default();
        assert!(set.insert(fingerprint128("alice@example.com")));
        assert!(!set.insert(fingerprint128("alice@example.com")));
        assert!(set.insert(fingerprint128("bob@example.com")));
    }
}
