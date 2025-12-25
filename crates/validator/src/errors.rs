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
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::MissingRequired => "MissingRequired",
            ErrorCode::InvalidType => "InvalidType",
            ErrorCode::MaxLengthExceeded => "MaxLengthExceeded",
            ErrorCode::NotAllowed => "NotAllowed",
            ErrorCode::InvalidUtf8 => "InvalidUtf8",
            ErrorCode::MissingRequiredColumn => "MissingRequiredColumn",
            ErrorCode::ExtraColumn => "ExtraColumn",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PackedError {
    pub row: u32,
    pub col: u32,
    pub code: ErrorCode,
}

impl PackedError {
    /// Packs into 2 u32 words:
    /// word0 = row
    /// word1 = (col << 8) | code
    pub fn to_words(self) -> [u32; 2] {
        [
            self.row,
            (self.col << 8) | (self.code as u32),
        ]
    }
}
