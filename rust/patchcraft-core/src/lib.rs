mod aliases;
mod file_update;
mod parser;
mod paths;
mod seek_sequence;
#[cfg(test)]
mod tests;
mod text_file;
mod transaction;

pub use file_update::{MatchError, Update, apply_chunks};
pub use parser::{Operation, UpdateChunk, parse_patch};
pub use transaction::{Cancelled, Plan};

pub const MAX_PATCH_BYTES: usize = 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;

// ECMAScript WhiteSpace and LineTerminator, matching TS trim/trimEnd rather
// than Rust's Unicode White_Space (which includes NEL but excludes BOM).
fn is_trim_char(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
