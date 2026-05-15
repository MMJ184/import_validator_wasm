use serde::Serialize;

#[repr(u8)]
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    MissingRequired = 1,
    InvalidType = 2,
    MaxLengthExceeded = 3,
    NotAllowed = 4,
    InvalidUtf8 = 5,
    MissingRequiredColumn = 6,
    ExtraColumn = 7,
    MinLengthNotMet = 8,
    InvalidEmail = 9,
    #[cfg(feature = "pattern")]
    PatternMismatch = 10,
    PrecisionExceeded = 11,
    ColumnCountMismatch = 12,
    DuplicateValue = 13,
    DuplicateCombination = 14,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug)]
pub enum ColKind {
    Schema = 0,
    Input = 1,
}

#[derive(Clone, Copy, Debug)]
pub struct PackedError {
    pub row: u32,
    pub col: u32,
    pub code: ErrorCode,
    pub kind: ColKind,
}

impl PackedError {
    /// word0 = row
    /// word1 = (kind<<31) | (col<<8) | code
    pub fn to_words(self) -> [u32; 2] {
        let kind_bit = (self.kind as u32) << 31;
        [self.row, kind_bit | (self.col << 8) | (self.code as u32)]
    }
}
