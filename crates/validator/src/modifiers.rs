//! Column modifier pipeline: value transforms that run before type checking.
//!
//! Ordering contract (documented in docs/SCHEMA_REFERENCE.md):
//! collapseWhitespace → substring → replace → regexReplace → case transforms
//! → null-token check → numeric transforms → prefix/suffix.

use crate::schema::ColumnModifiers;
use rust_decimal::{Decimal, RoundingStrategy};

#[cfg(feature = "pattern")]
pub type RegexReplaceRule = (regex::Regex, String);
#[cfg(not(feature = "pattern"))]
pub type RegexReplaceRule = ();

pub fn apply_modifiers(
    input: &str,
    modifiers: &ColumnModifiers,
    null_values_lower: &[String],
    regex_rule: Option<&RegexReplaceRule>,
) -> String {
    let mut out = if modifiers.collapse_whitespace {
        collapse_whitespace(input)
    } else {
        input.to_string()
    };

    if modifiers.substring_start.is_some() || modifiers.substring_end.is_some() {
        out = substring_by_chars(
            out.as_str(),
            modifiers.substring_start.unwrap_or(0),
            modifiers.substring_end,
        );
    }

    if let Some(from) = modifiers.replace_from.as_ref() {
        if !from.is_empty() {
            out = out.replace(from, modifiers.replace_to.as_deref().unwrap_or(""));
        }
    }

    out = apply_regex_replace(out, regex_rule);

    if modifiers.lowercase {
        out = out.to_lowercase();
    }
    if modifiers.uppercase {
        out = out.to_uppercase();
    }
    if modifiers.title_case {
        out = to_title_case(out.as_str());
    }

    if is_null_token(out.as_str(), modifiers, null_values_lower) {
        return String::new();
    }

    if (modifiers.ceil || modifiers.floor || modifiers.round || modifiers.decimal_scale.is_some())
        && !out.is_empty()
    {
        if let Some(num_out) = apply_numeric_modifiers(out.as_str(), modifiers) {
            out = num_out;
        }
    }

    if let Some(prefix) = modifiers.prefix.as_ref() {
        let mut prefixed = String::with_capacity(prefix.len() + out.len());
        prefixed.push_str(prefix);
        prefixed.push_str(&out);
        out = prefixed;
    }
    if let Some(suffix) = modifiers.suffix.as_ref() {
        out.push_str(suffix.as_str());
    }

    out
}

fn apply_numeric_modifiers(input: &str, modifiers: &ColumnModifiers) -> Option<String> {
    if input.contains(',') {
        return None;
    }

    let mut value = Decimal::from_str_exact(input).ok()?;

    if modifiers.ceil {
        value = value.ceil();
    } else if modifiers.floor {
        value = value.floor();
    } else if modifiers.round {
        value = value.round();
    }

    if let Some(scale) = modifiers.decimal_scale {
        let rounded = value.round_dp_with_strategy(scale, RoundingStrategy::MidpointAwayFromZero);
        let mut fixed = rounded;
        fixed.rescale(scale);
        return Some(fixed.to_string());
    }

    Some(value.to_string())
}

#[cfg(feature = "pattern")]
fn apply_regex_replace(value: String, rule: Option<&RegexReplaceRule>) -> String {
    if let Some((re, replacement)) = rule {
        return re
            .replace_all(value.as_str(), replacement.as_str())
            .to_string();
    }
    value
}

#[cfg(not(feature = "pattern"))]
fn apply_regex_replace(value: String, _rule: Option<&RegexReplaceRule>) -> String {
    value
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for token in input.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(token);
    }
    out
}

fn substring_by_chars(input: &str, start: usize, end: Option<usize>) -> String {
    let char_count = input.chars().count();
    if start >= char_count {
        return String::new();
    }
    let end_idx = end.unwrap_or(char_count).min(char_count);
    if end_idx <= start {
        return String::new();
    }
    input.chars().skip(start).take(end_idx - start).collect()
}

fn to_title_case(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (i, token) in input.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut chars = token.chars();
        if let Some(first) = chars.next() {
            for c in first.to_uppercase() {
                out.push(c);
            }
            let rest = chars.as_str().to_lowercase();
            out.push_str(rest.as_str());
        }
    }
    out
}

fn is_null_token(input: &str, modifiers: &ColumnModifiers, lower_cache: &[String]) -> bool {
    if modifiers.null_values.is_empty() {
        return false;
    }
    if modifiers.null_values_case_insensitive {
        let candidate = input.to_lowercase();
        return lower_cache.contains(&candidate);
    }
    modifiers.null_values.iter().any(|v| input == v)
}

/// True when `apply_modifiers` is a no-op for this column (only the default
/// trim, which happens before this pipeline). Lets the engine skip the whole
/// pipeline — and the allocation — for plain columns.
pub fn is_identity_modifiers(modifiers: &ColumnModifiers) -> bool {
    if modifiers.collapse_whitespace {
        return false;
    }
    if modifiers.substring_start.is_some() || modifiers.substring_end.is_some() {
        return false;
    }
    if modifiers
        .replace_from
        .as_ref()
        .is_some_and(|s| !s.is_empty())
    {
        return false;
    }
    if modifiers.lowercase || modifiers.uppercase || modifiers.title_case {
        return false;
    }
    if !modifiers.null_values.is_empty() {
        return false;
    }
    if modifiers.ceil || modifiers.floor || modifiers.round || modifiers.decimal_scale.is_some() {
        return false;
    }
    if modifiers.prefix.is_some() || modifiers.suffix.is_some() {
        return false;
    }
    #[cfg(feature = "pattern")]
    if modifiers.regex_replace_pattern.is_some() {
        return false;
    }
    true
}
