//! Quote-aware streaming CSV row counter for the estimate pass.
//!
//! Ports the exact row/column semantics of the original worker-side
//! JavaScript estimator (packages/worker/src/pipeline/estimateCsv.ts) so
//! estimates stay byte-for-byte compatible, but runs at WASM speed with
//! memchr scanning. Counts total physical CSV rows (header included) and the
//! column count of the first row.

#[derive(Debug)]
pub struct RowCounterCore {
    delimiter: u8,
    rows: u64,
    first_row_columns: Option<u32>,
    current_row_columns: u32,
    has_any_byte: bool,
    ended_with_row_break: bool,
    prev_cr: bool,
    in_quotes: bool,
    quote_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowCount {
    /// Total physical rows seen (including a header row, if any).
    pub rows: u64,
    /// Column count of the first row, when at least one row exists.
    pub first_row_columns: Option<u32>,
}

impl RowCounterCore {
    pub fn new(delimiter: u8) -> Self {
        Self {
            delimiter,
            rows: 0,
            first_row_columns: None,
            current_row_columns: 1,
            has_any_byte: false,
            ended_with_row_break: false,
            prev_cr: false,
            in_quotes: false,
            quote_pending: false,
        }
    }

    #[inline]
    fn finish_row(&mut self) {
        self.rows += 1;
        if self.first_row_columns.is_none() {
            self.first_row_columns = Some(self.current_row_columns);
        }
        self.current_row_columns = 1;
        self.ended_with_row_break = true;
        self.prev_cr = false;
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.has_any_byte = true;

        let mut i = 0usize;
        let len = chunk.len();
        while i < len {
            // Inside quotes only a quote byte matters — jump straight to it.
            // (ended_with_row_break is always false here: the opening quote
            // byte cleared it on the normal path.)
            if self.in_quotes && !self.quote_pending {
                match memchr::memchr(b'"', &chunk[i..]) {
                    Some(off) => {
                        i += off + 1;
                        self.quote_pending = true;
                        continue;
                    }
                    None => return,
                }
            }

            let b = chunk[i];
            i += 1;

            if self.quote_pending {
                if b == b'"' {
                    self.quote_pending = false;
                    continue;
                }
                self.in_quotes = false;
                self.quote_pending = false;
            }

            if self.in_quotes {
                if b == b'"' {
                    self.quote_pending = true;
                }
                continue;
            }

            // The '\n' of a CRLF pair is part of the same row break: it must
            // not clear ended_with_row_break, or CRLF-terminated files count
            // a phantom trailing row. (Fixes a legacy JS-estimator bug.)
            if b == b'\n' && self.prev_cr {
                self.prev_cr = false;
                continue;
            }

            if self.ended_with_row_break {
                self.ended_with_row_break = false;
            }

            if b == b'"' {
                self.in_quotes = true;
                continue;
            }

            if b == self.delimiter {
                self.current_row_columns += 1;
                self.prev_cr = false;
                continue;
            }

            if b == b'\r' {
                self.finish_row();
                self.prev_cr = true;
                continue;
            }

            if b == b'\n' {
                // CRLF pairs were consumed above; this is a bare LF.
                self.finish_row();
                continue;
            }

            self.prev_cr = false;
        }
    }

    /// Finalize and return counts. Idempotent.
    pub fn finish(&mut self) -> RowCount {
        if self.quote_pending {
            self.in_quotes = false;
            self.quote_pending = false;
        }
        if self.has_any_byte && !self.ended_with_row_break {
            self.finish_row();
        }
        RowCount {
            rows: self.rows,
            first_row_columns: self.first_row_columns,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(data: &[u8], chunk_size: usize) -> RowCount {
        let mut c = RowCounterCore::new(b',');
        for chunk in data.chunks(chunk_size.max(1)) {
            c.push(chunk);
        }
        c.finish()
    }

    #[test]
    fn counts_rows_and_first_row_columns() {
        let data = b"a,b,c\n1,2,3\n4,5,6\n";
        for cs in [1, 2, 3, 5, 64] {
            let rc = count(data, cs);
            assert_eq!(rc.rows, 3, "chunk={cs}");
            assert_eq!(rc.first_row_columns, Some(3), "chunk={cs}");
        }
    }

    #[test]
    fn quoted_newlines_do_not_split_rows() {
        let data = b"a,b\n\"line1\nline2\",x\n\"say \"\"hi\"\"\",y\n";
        for cs in [1, 2, 3, 7, 64] {
            let rc = count(data, cs);
            assert_eq!(rc.rows, 3, "chunk={cs}");
            assert_eq!(rc.first_row_columns, Some(2), "chunk={cs}");
        }
    }

    #[test]
    fn crlf_counts_once_and_trailing_partial_row_counts() {
        assert_eq!(count(b"a,b\r\n1,2\r\n", 3).rows, 2);
        assert_eq!(count(b"a,b\n1,2", 4).rows, 2); // no trailing newline
        assert_eq!(count(b"", 4).rows, 0);
        assert_eq!(count(b"\n", 4).rows, 1);
    }
}
