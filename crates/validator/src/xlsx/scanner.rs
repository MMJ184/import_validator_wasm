//! Streaming worksheet-XML scanner.
//!
//! Consumes decompressed `xl/worksheets/sheetN.xml` bytes in chunks of any
//! size and feeds completed rows straight into [`ValidatorCore`] — the same
//! record path CSV uses, with no CSV text round-trip.
//!
//! Semantics parity with the retired TypeScript regex pipeline:
//! - rows are emitted per `<row>` element; omitted (sparse) rows are skipped
//! - cells are keyed by their `r` reference when present, positionally
//!   otherwise; gaps become empty fields; a row with no cells becomes a
//!   single empty field (what its CSV round-trip used to produce)
//! - cell types: `s` shared string, `b` boolean → TRUE/FALSE,
//!   `inlineStr` → concatenated `<is><t>` runs, everything else → `<v>` text
//! - XML entities and CDATA are decoded in text content
//! - rows must close (`</row>`) to be emitted; a truncated trailing row is
//!   dropped silently
//!
//! Documented deviations (improvements): cell references past Excel's XFD
//! (16384) column limit raise an error instead of exhausting memory, and
//! scanning stops at `</sheetData>`.

use super::xml::{append_text_decoded, classify_tag, col_from_ref, find_attr, Tag};
use crate::engine::ValidatorCore;

const MAX_CARRY: usize = 64 * 1024;
/// Excel's hard column limit (column "XFD").
const MAX_COLS: u32 = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Content,
    InComment,
    InCdata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CellType {
    General,
    Shared,
    Bool,
    InlineStr,
}

pub struct SheetScanner {
    state: State,
    carry: Vec<u8>,
    done: bool,

    // element context
    in_row: bool,
    in_c: bool,
    in_v: bool,
    seen_v: bool,
    in_is: bool,
    in_t: bool,
    rph_depth: u32,

    // current cell
    cell_col: u32, // u32::MAX = skip (unparsable ref)
    cell_type: CellType,
    saw_is: bool,
    text: Vec<u8>,

    // current row
    cells_processed: u32,
    row_cells: Vec<(u32, u32, u32)>, // (col, arena_start, arena_end)
    row_arena: Vec<u8>,

    // record assembly (reused across rows)
    record_buf: Vec<u8>,
    ends_buf: Vec<usize>,
    slot_scratch: Vec<(u32, u32)>,
}

impl Default for SheetScanner {
    fn default() -> Self {
        Self {
            state: State::Content,
            carry: Vec::new(),
            done: false,
            in_row: false,
            in_c: false,
            in_v: false,
            seen_v: false,
            in_is: false,
            in_t: false,
            rph_depth: 0,
            cell_col: 0,
            cell_type: CellType::General,
            saw_is: false,
            text: Vec::new(),
            cells_processed: 0,
            row_cells: Vec::new(),
            row_arena: Vec::new(),
            record_buf: Vec::new(),
            ends_buf: Vec::new(),
            slot_scratch: Vec::new(),
        }
    }
}

impl SheetScanner {
    /// Feed a chunk of decompressed worksheet XML. Rows are validated as they
    /// complete. Mirrors the CSV path on error-limit: the rest of the chunk
    /// is skipped once the engine's error queue is full.
    pub fn push(
        &mut self,
        chunk: &[u8],
        final_chunk: bool,
        core: &mut ValidatorCore,
    ) -> Result<(), String> {
        if self.done {
            return Ok(());
        }

        if !chunk.is_empty() {
            let joined: Vec<u8>;
            let data: &[u8] = if self.carry.is_empty() {
                chunk
            } else {
                let mut j = std::mem::take(&mut self.carry);
                j.extend_from_slice(chunk);
                joined = j;
                &joined
            };
            self.scan(data, false, core)?;
        }

        if final_chunk {
            if !self.carry.is_empty() {
                let leftover = std::mem::take(&mut self.carry);
                self.scan(&leftover, true, core)?;
            }
            // A row without its closing tag is dropped (regex-pipeline parity).
            self.done = true;
        }
        Ok(())
    }

    fn capturing(&self) -> bool {
        (self.in_v && !self.seen_v) || (self.in_is && self.in_t && self.rph_depth == 0)
    }

    fn scan(
        &mut self,
        data: &[u8],
        final_flush: bool,
        core: &mut ValidatorCore,
    ) -> Result<(), String> {
        let mut i = 0usize;
        let len = data.len();

        loop {
            if self.done {
                return Ok(());
            }
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
                    if data[i..].len() < 9 && data[i..].starts_with(b"<!") && !final_flush {
                        // possibly a split "<![CDATA[" / "<!--" marker
                        self.set_carry(&data[i..], final_flush)?;
                        return Ok(());
                    }

                    match memchr::memchr(b'>', &data[i..]) {
                        None => {
                            self.set_carry(&data[i..], final_flush)?;
                            return Ok(());
                        }
                        Some(off) => {
                            let tag_start = i + 1;
                            let tag_end = i + off;
                            i += off + 1;
                            // Split borrow: hand the tag slice to the handler
                            // without cloning. `data` is external to self, but
                            // the handler mutates self buffers — copy small
                            // tags is avoided by scoping the borrow.
                            self.handle_tag(&data[tag_start..tag_end], core)?;
                            if core.hit_error_limit() {
                                // CSV-path parity: abandon the rest of this
                                // chunk; scanning resumes on the next push.
                                return Ok(());
                            }
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
            return Ok(());
        }
        if bytes.len() > MAX_CARRY {
            return Err("Invalid worksheet XML: unterminated construct exceeds 64 KB".to_string());
        }
        self.carry.clear();
        self.carry.extend_from_slice(bytes);
        Ok(())
    }

    fn handle_tag(&mut self, tag: &[u8], core: &mut ValidatorCore) -> Result<(), String> {
        match classify_tag(tag) {
            Tag::Open {
                name,
                attrs,
                self_closing,
            } => match name {
                b"row" => {
                    if self.in_row {
                        // malformed: unterminated previous row — flush it
                        self.flush_row(core);
                    }
                    self.in_row = true;
                    if self_closing {
                        self.flush_row(core);
                        self.in_row = false;
                    }
                }
                b"c" if self.in_row => {
                    self.begin_cell(attrs)?;
                    if self_closing {
                        self.finish_cell(core)?;
                    }
                }
                b"v" if self.in_c => {
                    if !self_closing {
                        self.in_v = true;
                    }
                }
                b"is" if self.in_c => {
                    if !self_closing {
                        self.in_is = true;
                        self.saw_is = true;
                        self.text.clear();
                    }
                }
                b"t" if self.in_is => {
                    if !self_closing {
                        self.in_t = true;
                    }
                }
                b"rPh" | b"phoneticPr" => {
                    if !self_closing {
                        self.rph_depth += 1;
                    }
                }
                b"sheetData" if self_closing => {
                    self.done = true;
                }
                _ => {}
            },
            Tag::Close { name } => match name {
                b"row" => {
                    if self.in_row {
                        if self.in_c {
                            // malformed: cell not closed — finalize it first
                            self.finish_cell(core)?;
                        }
                        self.flush_row(core);
                        self.in_row = false;
                    }
                }
                b"c" => {
                    self.finish_cell(core)?;
                }
                b"v" => {
                    if self.in_v {
                        self.in_v = false;
                        self.seen_v = true;
                    }
                }
                b"is" => self.in_is = false,
                b"t" => self.in_t = false,
                b"rPh" | b"phoneticPr" => {
                    self.rph_depth = self.rph_depth.saturating_sub(1);
                }
                b"sheetData" => {
                    self.done = true;
                }
                _ => {}
            },
            Tag::Skip => {}
        }
        Ok(())
    }

    fn begin_cell(&mut self, attrs: &[u8]) -> Result<(), String> {
        self.in_c = true;
        self.in_v = false;
        self.seen_v = false;
        self.in_is = false;
        self.in_t = false;
        self.saw_is = false;
        self.text.clear();

        self.cell_col = match find_attr(attrs, b"r") {
            // u32::MAX marks an unparsable ref → skip cell (TS parity)
            Some(r) => col_from_ref(r).unwrap_or(u32::MAX),
            None => self.cells_processed, // positional fallback (TS parity)
        };
        if self.cell_col != u32::MAX && self.cell_col >= MAX_COLS {
            return Err(format!(
                "XLSX cell reference exceeds Excel's column limit ({MAX_COLS} columns)"
            ));
        }

        self.cell_type = match find_attr(attrs, b"t") {
            Some(t) => {
                if t.eq_ignore_ascii_case(b"s") {
                    CellType::Shared
                } else if t.eq_ignore_ascii_case(b"b") {
                    CellType::Bool
                } else if t.eq_ignore_ascii_case(b"inlineStr") {
                    CellType::InlineStr
                } else {
                    CellType::General
                }
            }
            None => CellType::General,
        };
        Ok(())
    }

    fn finish_cell(&mut self, core: &ValidatorCore) -> Result<(), String> {
        if !self.in_c {
            return Ok(());
        }
        self.in_c = false;
        self.in_v = false;
        self.in_is = false;
        self.in_t = false;

        let col = self.cell_col;
        if col == u32::MAX {
            // TS parity: skipped cells do not advance the positional counter
            self.text.clear();
            self.saw_is = false;
            return Ok(());
        }

        let start = self.row_arena.len() as u32;
        match self.cell_type {
            CellType::Shared => {
                if let Some(idx) = parse_shared_index(&self.text) {
                    if let Some(s) = core.shared_strings.get(idx) {
                        self.row_arena.extend_from_slice(s.as_bytes());
                    }
                }
            }
            CellType::Bool => {
                if self.text.as_slice() == b"1" {
                    self.row_arena.extend_from_slice(b"TRUE");
                } else {
                    self.row_arena.extend_from_slice(b"FALSE");
                }
            }
            CellType::InlineStr => {
                if self.saw_is {
                    self.row_arena.extend_from_slice(&self.text);
                }
            }
            CellType::General => {
                self.row_arena.extend_from_slice(&self.text);
            }
        }
        let end = self.row_arena.len() as u32;
        self.row_cells.push((col, start, end));
        self.cells_processed += 1;
        self.text.clear();
        self.saw_is = false;
        Ok(())
    }

    fn flush_row(&mut self, core: &mut ValidatorCore) {
        let width = self.row_cells.iter().map(|c| c.0 + 1).max().unwrap_or(0) as usize;

        self.record_buf.clear();
        self.ends_buf.clear();

        if width == 0 {
            // Empty row → one empty field: exactly what its CSV round-trip
            // ("" + newline) used to produce.
            self.ends_buf.push(0);
        } else {
            self.slot_scratch.clear();
            self.slot_scratch.resize(width, (u32::MAX, u32::MAX));
            for &(col, s, e) in &self.row_cells {
                self.slot_scratch[col as usize] = (s, e); // last-wins (TS parity)
            }
            for &(s, e) in &self.slot_scratch {
                if s != u32::MAX {
                    self.record_buf
                        .extend_from_slice(&self.row_arena[s as usize..e as usize]);
                }
                self.ends_buf.push(self.record_buf.len());
            }
        }

        core.handle_record(&self.record_buf, &self.ends_buf);

        self.row_cells.clear();
        self.row_arena.clear();
        self.cells_processed = 0;
    }
}

/// Shared-string index: optional ASCII whitespace, then leading digits
/// (parseInt-style tolerance for trailing junk).
fn parse_shared_index(text: &[u8]) -> Option<usize> {
    let t = super::xml::trim_xml_ws(text);
    let mut val: usize = 0;
    let mut seen = false;
    for &b in t {
        if !b.is_ascii_digit() {
            break;
        }
        seen = true;
        val = val.checked_mul(10)?.checked_add((b - b'0') as usize)?;
    }
    if seen {
        Some(val)
    } else {
        None
    }
}

// ── Row counter for the estimate pass ────────────────────────────────────────

/// Counts `<row>` elements (and the first row's width) without validating.
/// Used by the estimate fallback when the worksheet has no usable
/// `<dimension>` element. Tolerances match its purpose: it is an estimator,
/// not a parser — CDATA containing literal `<row` text can overcount (the
/// old regex pipeline shared this).
#[derive(Default)]
pub struct SheetRowCounter {
    carry: Vec<u8>,
    rows: u64,
    first_row_max_col: Option<u32>,
    first_row_cells: u32,
    in_first_row: bool,
    first_row_done: bool,
}

const COUNTER_OVERLAP: usize = 128;

impl SheetRowCounter {
    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
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
        let processed = self.scan(data, false);
        let keep = data.len() - processed;
        self.carry.clear();
        self.carry.extend_from_slice(&data[data.len() - keep..]);
    }

    pub fn finish(&mut self) -> (u64, Option<u32>) {
        if !self.carry.is_empty() {
            let leftover = std::mem::take(&mut self.carry);
            self.scan(&leftover, true);
        }
        let columns = self.first_row_max_col.map(|c| c + 1).or({
            if self.first_row_cells > 0 {
                Some(self.first_row_cells)
            } else {
                None
            }
        });
        (self.rows, columns)
    }

    /// Scans data, returning how many leading bytes are fully decided.
    /// Undecided tail (up to COUNTER_OVERLAP) is carried by the caller.
    fn scan(&mut self, data: &[u8], final_flush: bool) -> usize {
        let len = data.len();
        let decide_until = if final_flush {
            len
        } else {
            len.saturating_sub(COUNTER_OVERLAP)
        };
        let mut i = 0usize;

        while i < len {
            let Some(off) = memchr::memchr(b'<', &data[i..]) else {
                return len;
            };
            let lt = i + off;
            if lt >= decide_until && !final_flush {
                return lt; // defer this tag to the next chunk
            }
            let rest = &data[lt + 1..];

            if let Some(name_len) = match_local(rest, b"row") {
                let after = lt + 1 + name_len;
                self.rows += 1;
                if self.rows == 1 {
                    self.in_first_row = true;
                    // self-closing first row?
                    if let Some(gt) = memchr::memchr(b'>', &data[after..]) {
                        if data[after..after + gt].ends_with(b"/") {
                            self.in_first_row = false;
                            self.first_row_done = true;
                        }
                    }
                } else {
                    // a second <row> implicitly ends the first
                    self.in_first_row = false;
                    self.first_row_done = true;
                }
                i = after;
                continue;
            }
            if rest.starts_with(b"/") {
                if let Some(name_len) = match_local(&rest[1..], b"row") {
                    if self.in_first_row {
                        self.in_first_row = false;
                        self.first_row_done = true;
                    }
                    i = lt + 2 + name_len;
                    continue;
                }
            }
            if self.in_first_row && !self.first_row_done {
                if let Some(name_len) = match_local(rest, b"c") {
                    let after = lt + 1 + name_len;
                    // width via r attr when available, positional otherwise
                    if let Some(gt) = memchr::memchr(b'>', &data[after..]) {
                        let attrs = &data[after..after + gt];
                        if let Some(r) = find_attr(attrs, b"r") {
                            if let Some(col) = col_from_ref(r) {
                                let cur = self.first_row_max_col.unwrap_or(0);
                                if col != u32::MAX
                                    && (self.first_row_max_col.is_none() || col > cur)
                                {
                                    self.first_row_max_col = Some(col);
                                }
                            }
                        }
                    }
                    self.first_row_cells += 1;
                    i = after;
                    continue;
                }
            }
            i = lt + 1;
        }
        len
    }
}

/// Match `<[prefix:]wanted` at the start of `rest` (bytes after `<`), where
/// the name must be followed by whitespace, `/`, or `>`. Returns the matched
/// name length (prefix included) on success.
fn match_local(rest: &[u8], wanted: &[u8]) -> Option<usize> {
    // optional namespace prefix
    let mut start = 0usize;
    let colon = rest
        .iter()
        .take(16)
        .position(|&b| b == b':' || !(b.is_ascii_alphanumeric()));
    if let Some(pos) = colon {
        if rest.get(pos) == Some(&b':') {
            start = pos + 1;
        }
    }
    let end = start + wanted.len();
    if rest.len() < end + 1 {
        return None;
    }
    if &rest[start..end] != wanted {
        return None;
    }
    match rest[end] {
        b' ' | b'\t' | b'\r' | b'\n' | b'/' | b'>' => Some(end),
        _ => None,
    }
}
