use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub has_headers: bool,
    #[serde(default = "default_delimiter")]
    pub delimiter: u8, // ',' by default
    #[serde(default)]
    pub columns: Vec<ColumnSpec>,
    #[serde(default)]
    pub fail_on_extra_columns: bool,
}

fn default_delimiter() -> u8 { b',' }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(rename = "type")]
    pub col_type: ColumnType,

    #[serde(default)]
    pub max_len: Option<usize>,

    /// Allowed values (exact match after trimming).
    /// For performance/determinism, keep this list small-ish and already-canonical (case/whitespace).
    #[serde(default)]
    pub allowed: Vec<String>,

    /// For decimal
    #[serde(default)]
    pub precision: Option<u32>,

    /// For date
    #[serde(default)]
    pub date_format: Option<DateFormat>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    String,
    Int,
    Decimal,
    Date,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DateFormat {
    /// YYYY-MM-DD
    YmdDash,
    /// DD/MM/YYYY
    DmySlash,
    /// MM/DD/YYYY
    MdySlash,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub rows_processed: u32,
    pub errors_added: u32,
    pub done: bool,
}
