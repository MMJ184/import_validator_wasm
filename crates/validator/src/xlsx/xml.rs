//! Minimal streaming-XML helpers shared by the sheet scanner and the
//! shared-strings builder.
//!
//! This is not a general XML parser: it supports exactly what SpreadsheetML
//! produces — elements with optional namespace prefixes, double/single quoted
//! attributes, character data with the five named entities plus numeric
//! references, CDATA sections, comments, and processing instructions.
//! Known accepted limitation (same as the previous regex pipeline): a literal
//! `>` inside an attribute value terminates the tag early.

/// Classified tag, borrowing from the tag byte slice (between `<` and `>`).
pub(crate) enum Tag<'a> {
    /// `<name attrs...>` — `self_closing` covers `<name/>`.
    Open {
        name: &'a [u8],
        attrs: &'a [u8],
        self_closing: bool,
    },
    /// `</name>`
    Close { name: &'a [u8] },
    /// `<!DOCTYPE…>`, `<?xml…?>` — already fully skipped by the caller.
    Skip,
}

/// Classify the bytes between `<` and `>` (exclusive). Comments and CDATA are
/// handled by the caller before this point.
pub(crate) fn classify_tag(tag: &[u8]) -> Tag<'_> {
    if tag.is_empty() {
        return Tag::Skip;
    }
    match tag[0] {
        b'?' | b'!' => Tag::Skip,
        b'/' => Tag::Close {
            name: local_name(trim_xml_ws(&tag[1..])),
        },
        _ => {
            let (raw, self_closing) = match tag.last() {
                Some(b'/') => (&tag[..tag.len() - 1], true),
                _ => (tag, false),
            };
            let name_end = raw
                .iter()
                .position(|b| b.is_ascii_whitespace())
                .unwrap_or(raw.len());
            Tag::Open {
                name: local_name(&raw[..name_end]),
                attrs: &raw[name_end..],
                self_closing,
            }
        }
    }
}

/// Strip an optional namespace prefix: `x:row` → `row`.
pub(crate) fn local_name(name: &[u8]) -> &[u8] {
    match memchr::memchr(b':', name) {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

pub(crate) fn trim_xml_ws(mut b: &[u8]) -> &[u8] {
    while let Some((&f, rest)) = b.split_first() {
        if f.is_ascii_whitespace() {
            b = rest
        } else {
            break;
        }
    }
    while let Some((&l, rest)) = b.split_last() {
        if l.is_ascii_whitespace() {
            b = rest
        } else {
            break;
        }
    }
    b
}

/// Find attribute `wanted` in a tag's attribute bytes; returns the raw value
/// (entities not decoded — cell refs/types never contain them).
pub(crate) fn find_attr<'a>(attrs: &'a [u8], wanted: &[u8]) -> Option<&'a [u8]> {
    let mut i = 0usize;
    let len = attrs.len();
    while i < len {
        while i < len && attrs[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            return None;
        }
        // attribute name
        let name_start = i;
        while i < len && attrs[i] != b'=' && !attrs[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = &attrs[name_start..i];
        while i < len && attrs[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len || attrs[i] != b'=' {
            // valueless attribute — not produced by Excel; skip defensively
            continue;
        }
        i += 1; // '='
        while i < len && attrs[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            return None;
        }
        let quote = attrs[i];
        if quote != b'"' && quote != b'\'' {
            // unquoted value: read until whitespace
            let v_start = i;
            while i < len && !attrs[i].is_ascii_whitespace() {
                i += 1;
            }
            if local_name(name) == wanted {
                return Some(&attrs[v_start..i]);
            }
            continue;
        }
        i += 1;
        let v_start = i;
        let v_end = match memchr::memchr(quote, &attrs[i..]) {
            Some(off) => i + off,
            None => return None,
        };
        i = v_end + 1;
        if local_name(name) == wanted {
            return Some(&attrs[v_start..v_end]);
        }
    }
    None
}

/// Excel column reference (`"BC12"` → column index 54). Returns `None` for
/// refs without a leading letter. Errors (beyond Excel's XFD = 16384 columns)
/// are reported by the caller.
pub(crate) fn col_from_ref(r: &[u8]) -> Option<u32> {
    let mut out: u64 = 0;
    let mut seen = false;
    for &b in r {
        let v = match b {
            b'A'..=b'Z' => (b - 64) as u64,
            b'a'..=b'z' => (b - 96) as u64,
            _ => break,
        };
        seen = true;
        out = out * 26 + v;
        if out > 1_000_000 {
            return Some(u32::MAX); // caller rejects out-of-range
        }
    }
    if !seen || out == 0 {
        return None;
    }
    Some((out - 1) as u32)
}

/// Decode XML character data from `text` into `out`.
///
/// Returns the number of bytes at the END of `text` that could not be
/// consumed because they may be the start of an entity split across chunk
/// boundaries (0 when everything was consumed). When `may_continue` is false
/// (a tag follows, or the stream ended) trailing partial entities are
/// emitted literally instead, matching the old pipeline's behavior for
/// malformed entities.
pub(crate) fn append_text_decoded(text: &[u8], out: &mut Vec<u8>, may_continue: bool) -> usize {
    const MAX_ENTITY: usize = 12; // "&#x10FFFF;" fits comfortably
    let mut i = 0usize;
    let len = text.len();

    while i < len {
        match memchr::memchr(b'&', &text[i..]) {
            None => {
                out.extend_from_slice(&text[i..]);
                return 0;
            }
            Some(off) => {
                out.extend_from_slice(&text[i..i + off]);
                let amp = i + off;
                let search_end = (amp + MAX_ENTITY).min(len);
                match memchr::memchr(b';', &text[amp + 1..search_end]) {
                    Some(semi_off) => {
                        let semi = amp + 1 + semi_off;
                        if decode_entity(&text[amp + 1..semi], out) {
                            i = semi + 1;
                        } else {
                            // unknown entity → literal '&', continue after it
                            out.push(b'&');
                            i = amp + 1;
                        }
                    }
                    None => {
                        if may_continue && len - amp < MAX_ENTITY {
                            // possible split entity — hold it back
                            return len - amp;
                        }
                        out.push(b'&');
                        i = amp + 1;
                    }
                }
            }
        }
    }
    0
}

/// Decode one entity body (bytes between `&` and `;`). Returns false when the
/// entity is unknown/invalid (caller emits it literally).
fn decode_entity(body: &[u8], out: &mut Vec<u8>) -> bool {
    match body {
        b"amp" => out.push(b'&'),
        b"lt" => out.push(b'<'),
        b"gt" => out.push(b'>'),
        b"quot" => out.push(b'"'),
        b"apos" => out.push(b'\''),
        _ => {
            if body.len() < 2 || body[0] != b'#' {
                return false;
            }
            let code = if body[1] == b'x' || body[1] == b'X' {
                match std::str::from_utf8(&body[2..])
                    .ok()
                    .and_then(|s| u32::from_str_radix(s, 16).ok())
                {
                    Some(c) => c,
                    None => return false,
                }
            } else {
                match std::str::from_utf8(&body[1..])
                    .ok()
                    .and_then(|s| s.parse::<u32>().ok())
                {
                    Some(c) => c,
                    None => return false,
                }
            };
            // Parity with the old pipeline: out-of-range/surrogate code
            // points become empty output, not a literal.
            if let Some(c) = char::from_u32(code) {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(s: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let carried = append_text_decoded(s, &mut out, false);
        assert_eq!(carried, 0);
        out
    }

    #[test]
    fn decodes_named_and_numeric_entities() {
        assert_eq!(
            decode_all(b"a&amp;b&lt;c&gt;d&quot;e&apos;f"),
            b"a&b<c>d\"e'f"
        );
        assert_eq!(decode_all(b"&#65;&#x42;&#x63;"), b"ABc");
        assert_eq!(decode_all(b"caf&#233;"), "café".as_bytes());
        assert_eq!(decode_all(b"&bogus;x"), b"&bogus;x");
        assert_eq!(decode_all(b"tail&am"), b"tail&am");
    }

    #[test]
    fn holds_back_split_entities_when_more_data_may_come() {
        let mut out = Vec::new();
        let carried = append_text_decoded(b"abc&am", &mut out, true);
        assert_eq!(out, b"abc");
        assert_eq!(carried, 3);
    }

    #[test]
    fn finds_attributes_with_prefixes_and_quotes() {
        let attrs = br#" r="B2" s='1' t="s""#;
        assert_eq!(find_attr(attrs, b"r"), Some(&b"B2"[..]));
        assert_eq!(find_attr(attrs, b"t"), Some(&b"s"[..]));
        assert_eq!(find_attr(attrs, b"missing"), None);
    }

    #[test]
    fn parses_column_refs() {
        assert_eq!(col_from_ref(b"A1"), Some(0));
        assert_eq!(col_from_ref(b"Z9"), Some(25));
        assert_eq!(col_from_ref(b"AA10"), Some(26));
        assert_eq!(col_from_ref(b"XFD1"), Some(16383));
        assert_eq!(col_from_ref(b"123"), None);
    }

    #[test]
    fn classifies_tags_and_strips_prefixes() {
        match classify_tag(b"x:row r=\"1\"") {
            Tag::Open {
                name, self_closing, ..
            } => {
                assert_eq!(name, b"row");
                assert!(!self_closing);
            }
            _ => panic!("expected open"),
        }
        match classify_tag(b"c r=\"A1\"/") {
            Tag::Open {
                name, self_closing, ..
            } => {
                assert_eq!(name, b"c");
                assert!(self_closing);
            }
            _ => panic!("expected self-closing open"),
        }
        match classify_tag(b"/x:sheetData") {
            Tag::Close { name } => assert_eq!(name, b"sheetData"),
            _ => panic!("expected close"),
        }
    }
}
