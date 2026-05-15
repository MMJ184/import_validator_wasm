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
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub has_headers: bool,

    #[serde(default = "default_delimiter", deserialize_with = "deserialize_delimiter")]
    pub delimiter: u8, // stored as byte internally

    #[serde(default)]
    pub columns: Vec<ColumnSpec>,

    #[serde(default)]
    pub fail_on_extra_columns: bool,

    #[serde(default)]
    pub total_columns: Option<usize>,

    #[serde(default)]
    pub unique_groups: Vec<UniqueGroupSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub name: String,

    #[serde(default)]
    pub required: bool,

    #[serde(default)]
    pub nullable: bool,

    #[serde(rename = "type")]
    pub col_type: ColumnType,

    #[serde(default)]
    pub max_len: Option<usize>,

    #[serde(default)]
    pub min_len: Option<usize>,

    #[serde(default)]
    pub allowed: Vec<String>,

    #[serde(default)]
    pub precision: Option<u32>,

    #[serde(default)]
    pub date_format: Option<DateFormat>,

    #[serde(default)]
    pub pattern: Option<String>,

    #[serde(default)]
    pub strict_precision: bool,

    #[serde(default)]
    pub unique: bool,

    #[serde(default)]
    pub modifiers: ColumnModifiers,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ColumnModifiers {
    #[serde(default = "default_true")]
    pub trim: bool,

    #[serde(default)]
    pub collapse_whitespace: bool,

    #[serde(default)]
    pub title_case: bool,

    #[serde(default)]
    pub lowercase: bool,

    #[serde(default)]
    pub uppercase: bool,

    #[serde(default)]
    pub prefix: Option<String>,

    #[serde(default)]
    pub suffix: Option<String>,

    #[serde(default)]
    pub ceil: bool,

    #[serde(default)]
    pub floor: bool,

    #[serde(default)]
    pub round: bool,

    #[serde(default)]
    pub decimal_scale: Option<u32>,

    #[serde(default)]
    pub substring_start: Option<usize>,

    #[serde(default)]
    pub substring_end: Option<usize>,

    #[serde(default)]
    pub replace_from: Option<String>,

    #[serde(default)]
    pub replace_to: Option<String>,

    #[serde(default)]
    pub regex_replace_pattern: Option<String>,

    #[serde(default)]
    #[cfg_attr(not(feature = "pattern"), allow(dead_code))]
    pub regex_replace_with: Option<String>,

    #[serde(default)]
    pub null_values: Vec<String>,

    #[serde(default = "default_true")]
    pub null_values_case_insensitive: bool,
}

impl Default for ColumnModifiers {
    fn default() -> Self {
        Self {
            trim: true,
            collapse_whitespace: false,
            title_case: false,
            lowercase: false,
            uppercase: false,
            prefix: None,
            suffix: None,
            ceil: false,
            floor: false,
            round: false,
            decimal_scale: None,
            substring_start: None,
            substring_end: None,
            replace_from: None,
            replace_to: None,
            regex_replace_pattern: None,
            regex_replace_with: None,
            null_values: Vec::new(),
            null_values_case_insensitive: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct UniqueGroupSpec {
    pub columns: Vec<String>,

    #[serde(default)]
    #[allow(dead_code)]
    pub name: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    String,
    Int,
    Decimal,
    Float,
    Double,
    Number,
    Email,
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
