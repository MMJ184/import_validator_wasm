use serde::{Deserialize, Serialize};
use serde::de::{self, Deserializer};
use serde_json::Value;

fn default_delimiter() -> u8 {
    b','
}

// Accept delimiter as "," or 44
fn deserialize_delimiter<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(deserializer)?;
    match v {
        Value::Number(n) => n
            .as_u64()
            .and_then(|x| u8::try_from(x).ok())
            .ok_or_else(|| de::Error::custom("delimiter must be a u8 (0..=255)")),
        Value::String(s) => {
            let b = s.as_bytes();
            if b.len() == 1 {
                Ok(b[0])
            } else {
                Err(de::Error::custom("delimiter must be a single character string (e.g. \",\" or \";\")"))
            }
        }
        _ => Err(de::Error::custom("delimiter must be a number or a single character string")),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub has_headers: bool,

    #[serde(default = "default_delimiter", deserialize_with = "deserialize_delimiter")]
    pub delimiter: u8, // stored as byte internally

    #[serde(default)]
    pub columns: Vec<ColumnSpec>,

    #[serde(default)]
    pub fail_on_extra_columns: bool,
}

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

    #[serde(default)]
    pub allowed: Vec<String>,

    #[serde(default)]
    pub precision: Option<u32>,

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
    YmdDash,   // "ymd-dash"
    DmySlash,  // "dmy-slash"
    MdySlash,  // "mdy-slash"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub rows_processed: u32,
    pub errors_added: u32,
    pub done: bool,
}
