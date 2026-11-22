#[cfg(not(unix))]
compile_error!("patchcraft-core supports Unix-like systems only");

mod aliases;
mod file_update;
mod hunk_parser;
mod parser;
mod paths;
mod seek_sequence;
#[cfg(test)]
mod tests;
mod text_file;
mod transaction;

pub use transaction::{Cancelled, Plan};

/// Wire protocol version. The TS client mirrors it in `src/protocol.ts`; `doctor` verifies it at runtime.
pub const PROTOCOL_VERSION: u32 = 5;

pub const MAX_PATCH_BYTES: usize = 1024 * 1024;
/// Mirrored in `src/protocol.ts`; the oversized-source test guards the pair. Snapshots travel as
/// base64 inside one frame, so this also bounds a frame at roughly 24 MiB.
pub(crate) const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
