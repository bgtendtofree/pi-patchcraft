mod aliases;
mod file_update;
mod parser;
mod paths;
mod seek_sequence;
mod streaming_parser;
#[cfg(test)]
mod tests;
mod text_file;
mod transaction;

pub use transaction::{Cancelled, Plan};

pub const MAX_PATCH_BYTES: usize = 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
