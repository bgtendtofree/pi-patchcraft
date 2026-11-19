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

/// Wire protocol version. The TS client mirrors it in `src/protocol.ts`; `doctor` verifies it at runtime.
pub const PROTOCOL_VERSION: u32 = 4;

pub const MAX_PATCH_BYTES: usize = 1024 * 1024;
/// Mirrored in `src/protocol.ts`; the oversized-source test guards the pair.
pub(crate) const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
