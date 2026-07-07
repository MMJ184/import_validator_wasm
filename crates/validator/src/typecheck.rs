//! Field type validators and canonicalizers.
//!
//! Validators take `&str` and never allocate. Canonicalizers return
//! `Ok(None)` when the input is already in canonical form (the caller keeps
//! the borrowed value — zero allocation on the hot path) and `Ok(Some(s))`
//! only when a rewrite is required.

use crate::errors::ErrorCode;
use crate::schema::DateFormat;
use rust_decimal::{Decimal, RoundingStrategy};

pub fn trim_ascii(mut b: &[u8]) -> &[u8] {
    while let Some((&first, rest)) = b.split_first() {
        if first.is_ascii_whitespace() {
            b = rest;
        } else {
            break;
        }
    }
    while let Some((&last, rest)) = b.split_last() {
        if last.is_ascii_whitespace() {
            b = rest;
        } else {
            break;
        }
    }
    b
}

pub fn is_valid_int(s: &str) -> bool {
    let bs = s.as_bytes();
    if bs.is_empty() {
        return false;
    }
    let mut i = 0usize;
    if bs[0] == b'+' || bs[0] == b'-' {
        i = 1;
    }
    if i >= bs.len() {
        return false;
    }
    bs[i..].iter().all(|c| c.is_ascii_digit())
}

pub fn is_valid_float(s: &str) -> bool {
    match s.parse::<f32>() {
        Ok(v) => v.is_finite(),
        Err(_) => false,
    }
}

pub fn is_valid_double(s: &str) -> bool {
    match s.parse::<f64>() {
        Ok(v) => v.is_finite(),
        Err(_) => false,
    }
}

pub fn is_valid_number(s: &str) -> bool {
    is_valid_int(s) || is_valid_double(s)
}

/// Validate and normalize a decimal string.
///
/// `Ok(None)` — valid and already canonical for `precision` (borrow input).
/// `Ok(Some(s))` — valid, `s` is the canonical rewrite.
/// `Err(code)` — invalid.
pub fn validate_normalize_decimal(
    s: &str,
    precision: u32,
    strict: bool,
) -> Result<Option<String>, ErrorCode> {
    if decimal_is_canonical(s, precision) {
        return Ok(None);
    }
    if s.contains(',') {
        return Err(ErrorCode::InvalidType);
    }
    let d = match Decimal::from_str_exact(s) {
        Ok(v) => v,
        Err(_) => return Err(ErrorCode::InvalidType),
    };
    if d.scale() > precision {
        return Err(ErrorCode::InvalidType);
    }
    if strict && d.scale() != precision {
        return Err(ErrorCode::PrecisionExceeded);
    }
    let rounded = d.round_dp_with_strategy(precision, RoundingStrategy::MidpointAwayFromZero);
    let mut fixed = rounded;
    fixed.rescale(precision);
    Ok(Some(fixed.to_string()))
}

/// True when `s` is byte-identical to what the slow path would emit for
/// `precision`: optional `-`, integer digits without leading zeros (a single
/// `0` is fine), then — iff precision > 0 — a `.` and exactly `precision`
/// fractional digits. Mantissa must fit Decimal's 28-digit budget, and
/// negative zero is excluded (Decimal may re-serialize its sign differently).
fn decimal_is_canonical(s: &str, precision: u32) -> bool {
    let bs = s.as_bytes();
    let mut i = 0usize;
    let negative = bs.first() == Some(&b'-');
    if negative {
        i = 1;
    }

    let int_start = i;
    while i < bs.len() && bs[i].is_ascii_digit() {
        i += 1;
    }
    let int_len = i - int_start;
    if int_len == 0 {
        return false;
    }
    // No leading zeros unless the integer part is exactly "0".
    if int_len > 1 && bs[int_start] == b'0' {
        return false;
    }

    let frac_len: usize;
    if precision == 0 {
        if i != bs.len() {
            return false;
        }
        frac_len = 0;
    } else {
        if i >= bs.len() || bs[i] != b'.' {
            return false;
        }
        i += 1;
        let frac_start = i;
        while i < bs.len() && bs[i].is_ascii_digit() {
            i += 1;
        }
        frac_len = i - frac_start;
        if i != bs.len() || frac_len != precision as usize {
            return false;
        }
    }

    // Mantissa (all digits) must fit in Decimal's 96-bit / 28-digit budget.
    if int_len + frac_len > 28 {
        return false;
    }

    // Exclude "-0", "-0.00", …: Decimal sign handling on zero is not worth
    // special-casing in the fast path.
    if negative && bs[int_start..].iter().all(|&b| b == b'0' || b == b'.') {
        return false;
    }

    true
}

pub fn is_valid_email(s: &str) -> bool {
    // Heuristic validation: practical gates without a full RFC 5322 parser.
    if s.len() > 254 {
        return false;
    }
    let bytes = s.as_bytes();
    // Reject ASCII whitespace and control characters anywhere. Multi-byte
    // UTF-8 sequences are >= 0x80, so international addresses still pass.
    if bytes.iter().any(|&b| b <= b' ') {
        return false;
    }
    let mut at = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'@' {
            if at.is_some() {
                return false; // exactly one '@'
            }
            at = Some(i);
        }
    }
    let Some(at) = at else { return false };
    if at == 0 || at + 1 >= s.len() {
        return false;
    }

    let domain = &s[at + 1..];
    if !domain.contains('.') {
        return false;
    }
    if domain.starts_with('.') || domain.ends_with('.') || domain.contains("..") {
        return false;
    }

    true
}

/// Validate a date and produce its canonical `YYYY-MM-DD` form in one parse.
///
/// `None` — invalid. `Some(None)` — valid and already canonical (borrow the
/// input). `Some(Some(s))` — valid, `s` is the canonical rewrite.
pub fn validate_normalize_date(s: &str, fmt: DateFormat) -> Option<Option<String>> {
    let (p1, p2, p3) = match fmt {
        DateFormat::YmdDash => parse_3_u32(s, b'-')?,
        DateFormat::DmySlash | DateFormat::MdySlash => parse_3_u32(s, b'/')?,
    };

    let (y, m, d) = match fmt {
        DateFormat::YmdDash => (p1, p2, p3),
        DateFormat::DmySlash => (p3, p2, p1),
        DateFormat::MdySlash => (p3, p1, p2),
    };

    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }

    let date =
        time::Date::from_calendar_date(y as i32, time::Month::try_from(m as u8).ok()?, d as u8)
            .ok()?;

    // Fast path: input already in zero-padded YYYY-MM-DD shape.
    if matches!(fmt, DateFormat::YmdDash) {
        let bs = s.as_bytes();
        if bs.len() == 10
            && bs[4] == b'-'
            && bs[7] == b'-'
            && bs[..4].iter().all(|b| b.is_ascii_digit())
            && bs[5..7].iter().all(|b| b.is_ascii_digit())
            && bs[8..10].iter().all(|b| b.is_ascii_digit())
        {
            return Some(None);
        }
    }

    Some(Some(format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )))
}

fn parse_3_u32(s: &str, sep: u8) -> Option<(u32, u32, u32)> {
    let bs = s.as_bytes();
    let mut parts = [0u32; 3];
    let mut pi = 0usize;

    let mut acc: u32 = 0;
    let mut seen_digit = false;

    for &b in bs {
        if b == sep {
            if !seen_digit || pi >= 3 {
                return None;
            }
            parts[pi] = acc;
            pi += 1;
            acc = 0;
            seen_digit = false;
            continue;
        }

        if !b.is_ascii_digit() {
            return None;
        }
        seen_digit = true;
        acc = acc.saturating_mul(10).saturating_add((b - b'0') as u32);
    }

    if !seen_digit || pi != 2 {
        return None;
    }
    parts[2] = acc;

    Some((parts[0], parts[1], parts[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference implementation: the pre-optimization decimal path.
    fn reference_decimal(s: &str, precision: u32, strict: bool) -> Result<String, ErrorCode> {
        if s.contains(',') {
            return Err(ErrorCode::InvalidType);
        }
        let d = Decimal::from_str_exact(s).map_err(|_| ErrorCode::InvalidType)?;
        if d.scale() > precision {
            return Err(ErrorCode::InvalidType);
        }
        if strict && d.scale() != precision {
            return Err(ErrorCode::PrecisionExceeded);
        }
        let rounded = d.round_dp_with_strategy(precision, RoundingStrategy::MidpointAwayFromZero);
        let mut fixed = rounded;
        fixed.rescale(precision);
        Ok(fixed.to_string())
    }

    #[test]
    fn decimal_fast_path_matches_reference_exactly() {
        let inputs = [
            "0",
            "1",
            "-1",
            "12.34",
            "-12.34",
            "0.00",
            "-0.00",
            "-0",
            "007.00",
            "+1.00",
            "1.5",
            "1.50",
            "1.500",
            "12345678901234567890.12",
            ".5",
            "5.",
            "-.5",
            "1e3",
            "abc",
            "",
            " 1.00",
            "1,00",
            "0.99",
            "-0.01",
            "99999999999999999999999999.99",
            "999999999999999999999999999.99",
            "10.00",
            "-10.00",
            "0.10",
            "3.14",
        ];
        for precision in [0u32, 2, 4] {
            for strict in [false, true] {
                for s in inputs {
                    let reference = reference_decimal(s, precision, strict);
                    let optimized = validate_normalize_decimal(s, precision, strict)
                        .map(|opt| opt.unwrap_or_else(|| s.to_string()));
                    match (&reference, &optimized) {
                        (Ok(a), Ok(b)) => assert_eq!(
                            a, b,
                            "mismatch for {s:?} precision={precision} strict={strict}"
                        ),
                        (Err(a), Err(b)) => assert_eq!(
                            *a as u8, *b as u8,
                            "error mismatch for {s:?} precision={precision} strict={strict}"
                        ),
                        _ => panic!(
                            "ok/err mismatch for {s:?} precision={precision} strict={strict}: {reference:?} vs {optimized:?}"
                        ),
                    }
                }
            }
        }
    }

    #[test]
    fn date_fast_path_borrows_canonical_and_rewrites_the_rest() {
        assert_eq!(
            validate_normalize_date("2024-02-29", DateFormat::YmdDash),
            Some(None)
        );
        assert_eq!(
            validate_normalize_date("2024-2-9", DateFormat::YmdDash),
            Some(Some("2024-02-09".to_string()))
        );
        assert_eq!(
            validate_normalize_date("9/2/2024", DateFormat::DmySlash),
            Some(Some("2024-02-09".to_string()))
        );
        assert_eq!(
            validate_normalize_date("2/9/2024", DateFormat::MdySlash),
            Some(Some("2024-02-09".to_string()))
        );
        assert_eq!(
            validate_normalize_date("2023-02-29", DateFormat::YmdDash),
            None
        );
        assert_eq!(
            validate_normalize_date("2024-13-01", DateFormat::YmdDash),
            None
        );
        assert_eq!(
            validate_normalize_date("not-a-date", DateFormat::YmdDash),
            None
        );
    }
}
