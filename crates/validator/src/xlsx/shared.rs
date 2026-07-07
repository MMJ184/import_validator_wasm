//! Streaming builder for `xl/sharedStrings.xml`.
//!
//! Strings are stored as one concatenated `String` plus start offsets —
//! ~4 bytes of overhead per string instead of a `String` allocation each,
//! which matters under the 128 MB shared-strings cap.

use super::xml::{append_text_decoded, classify_tag, Tag};

#[derive(Default)]
pub struct SharedStrings {
    data: String,
    // starts[i]..starts[i+1] is string i; sentinel end pushed on finish()
    starts: Vec<u32>,
}

impl SharedStrings {
    pub fn len(&self) -> usize {
        self.starts.len().saturating_sub(1)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline]
    pub fn get(&self, index: usize) -> Option<&str> {
        if index + 1 >= self.starts.len() {
            return None;
        }
        let start = self.starts[index] as usize;
        let end = self.starts[index + 1] as usize;
        self.data.get(start..end)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Content,
    InComment,
    InCdata,
}

/// Streaming parser: feed decompressed sharedStrings.xml chunks of any size.
pub struct SharedStringsBuilder {
    state: State,
    carry: Vec<u8>,
    text: Vec<u8>,
    data: String,
    starts: Vec<u32>,
    in_si: bool,
    in_t: bool,
    rph_depth: u32,
}

impl Default for SharedStringsBuilder {
    fn default() -> Self {
        Self {
            state: State::Content,
            carry: Vec::new(),
            text: Vec::new(),
            data: String::new(),
            starts: Vec::new(),
            in_si: false,
            in_t: false,
            rph_depth: 0,
        }
    }
}

const MAX_CARRY: usize = 64 * 1024;

impl SharedStringsBuilder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        if chunk.is_empty() {
            return Ok(());
        }
        let joined: Vec<u8>;
        let data: &[u8] = if self.carry.is_empty() {
            chunk
        } else {
            let mut j = std::mem::take(&mut self.carry);
            j.extend_from_slice(chunk);
            joined = j;
            &joined
        };
        self.scan(data, false)
    }

    pub fn finish(mut self) -> Result<SharedStrings, String> {
        if !self.carry.is_empty() {
            let leftover = std::mem::take(&mut self.carry);
            self.scan(&leftover, true)?;
        }
        // self.starts holds the END offset of each string; string i spans
        // ends[i-1]..ends[i] with ends[-1] = 0, so [0, ends...] is exactly
        // the starts array + sentinel that SharedStrings::get expects.
        let mut starts = Vec::with_capacity(self.starts.len() + 1);
        starts.push(0u32);
        starts.extend_from_slice(&self.starts);
        Ok(SharedStrings {
            data: self.data,
            starts,
        })
    }

    fn capturing(&self) -> bool {
        self.in_si && self.in_t && self.rph_depth == 0
    }

    fn scan(&mut self, data: &[u8], final_flush: bool) -> Result<(), String> {
        let mut i = 0usize;
        let len = data.len();

        loop {
            match self.state {
                State::InComment => match memchr::memmem::find(&data[i..], b"-->") {
                    Some(off) => {
                        i += off + 3;
                        self.state = State::Content;
                    }
                    None => {
                        let keep = (len - i).min(2);
                        self.set_carry(&data[len - keep..], final_flush)?;
                        return Ok(());
                    }
                },
                State::InCdata => match memchr::memmem::find(&data[i..], b"]]>") {
                    Some(off) => {
                        if self.capturing() {
                            self.text.extend_from_slice(&data[i..i + off]);
                        }
                        i += off + 3;
                        self.state = State::Content;
                    }
                    None => {
                        let keep = (len - i).min(2);
                        if self.capturing() {
                            self.text.extend_from_slice(&data[i..len - keep]);
                        }
                        self.set_carry(&data[len - keep..], final_flush)?;
                        return Ok(());
                    }
                },
                State::Content => {
                    let lt = memchr::memchr(b'<', &data[i..]).map(|off| i + off);
                    let text_end = lt.unwrap_or(len);
                    if self.capturing() && text_end > i {
                        let hold = append_text_decoded(
                            &data[i..text_end],
                            &mut self.text,
                            lt.is_none() && !final_flush,
                        );
                        if hold > 0 {
                            self.set_carry(&data[text_end - hold..], final_flush)?;
                            return Ok(());
                        }
                    }
                    let Some(lt) = lt else {
                        return Ok(());
                    };
                    i = lt;

                    // Comments / CDATA / DOCTYPE / PI need lookahead
                    if data[i..].len() >= 4 && &data[i..i + 4] == b"<!--" {
                        i += 4;
                        self.state = State::InComment;
                        continue;
                    }
                    if data[i..].len() >= 9 && &data[i..i + 9] == b"<![CDATA[" {
                        i += 9;
                        self.state = State::InCdata;
                        continue;
                    }
                    if data[i..].len() < 9
                        && (data[i..].starts_with(b"<!") || len - i < 4)
                        && !final_flush
                    {
                        // could be a split "<![CDATA[" or "<!--" marker
                        self.set_carry(&data[i..], final_flush)?;
                        return Ok(());
                    }

                    match memchr::memchr(b'>', &data[i..]) {
                        None => {
                            self.set_carry(&data[i..], final_flush)?;
                            return Ok(());
                        }
                        Some(off) => {
                            let tag = &data[i + 1..i + off];
                            self.handle_tag(tag)?;
                            i += off + 1;
                        }
                    }
                }
            }
            if i >= len {
                return Ok(());
            }
        }
    }

    fn set_carry(&mut self, bytes: &[u8], final_flush: bool) -> Result<(), String> {
        if final_flush {
            // Truncated trailing construct at end of stream: parity with the
            // regex pipeline — ignore it silently.
            return Ok(());
        }
        if bytes.len() > MAX_CARRY {
            return Err(
                "Invalid shared strings XML: unterminated construct exceeds 64 KB".to_string(),
            );
        }
        self.carry.clear();
        self.carry.extend_from_slice(bytes);
        Ok(())
    }

    fn handle_tag(&mut self, tag: &[u8]) -> Result<(), String> {
        match classify_tag(tag) {
            Tag::Open {
                name, self_closing, ..
            } => match name {
                b"si" => {
                    self.text.clear();
                    self.in_si = true;
                    if self_closing {
                        self.finish_si()?;
                    }
                }
                b"t" if self.in_si => {
                    if !self_closing {
                        self.in_t = true;
                    }
                }
                b"rPh" | b"phoneticPr" => {
                    if !self_closing {
                        self.rph_depth += 1;
                    }
                }
                _ => {}
            },
            Tag::Close { name } => match name {
                b"si" => self.finish_si()?,
                b"t" => self.in_t = false,
                b"rPh" | b"phoneticPr" => {
                    self.rph_depth = self.rph_depth.saturating_sub(1);
                }
                _ => {}
            },
            Tag::Skip => {}
        }
        Ok(())
    }

    fn finish_si(&mut self) -> Result<(), String> {
        if !self.in_si {
            return Ok(());
        }
        self.in_si = false;
        self.in_t = false;
        let text = std::mem::take(&mut self.text);
        let s = String::from_utf8(text)
            .map_err(|_| "Invalid UTF-8 data in XLSX shared strings".to_string())?;
        self.data.push_str(&s);
        self.starts.push(self.data.len() as u32); // end offset of this string
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(xml: &[u8], chunk: usize) -> SharedStrings {
        let mut b = SharedStringsBuilder::default();
        for c in xml.chunks(chunk.max(1)) {
            b.push(c).expect("push");
        }
        b.finish().expect("finish")
    }

    const SST: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>plain</t></si>
  <si><r><t>ri</t></r><r><t xml:space="preserve">ch</t></r></si>
  <si><t>a&amp;b &#65;</t></si>
  <si><rPh sb="0" eb="1"><t>phonetic-run</t></rPh><t>kanji</t></si>
  <si><t></t></si>
</sst>"#;

    #[test]
    fn parses_shared_strings_at_any_chunk_size() {
        for chunk in [1usize, 2, 3, 7, 16, 64, 4096] {
            let ss = build(SST, chunk);
            assert_eq!(ss.len(), 5, "chunk={chunk}");
            assert_eq!(ss.get(0), Some("plain"), "chunk={chunk}");
            assert_eq!(ss.get(1), Some("rich"), "chunk={chunk}");
            assert_eq!(ss.get(2), Some("a&b A"), "chunk={chunk}");
            assert_eq!(ss.get(3), Some("kanji"), "chunk={chunk}");
            assert_eq!(ss.get(4), Some(""), "chunk={chunk}");
            assert_eq!(ss.get(5), None, "chunk={chunk}");
        }
    }

    #[test]
    fn cdata_and_self_closing_si_are_supported() {
        let xml = br#"<sst><si><t><![CDATA[x<y&z]]></t></si><si/></sst>"#;
        for chunk in [1usize, 5, 64] {
            let ss = build(xml, chunk);
            assert_eq!(ss.len(), 2);
            assert_eq!(ss.get(0), Some("x<y&z"));
            assert_eq!(ss.get(1), Some(""));
        }
    }
}
