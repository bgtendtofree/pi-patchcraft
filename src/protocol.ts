/**
 * Wire contract shared by the TS client and the Rust core.
 *
 * The Rust constants are authoritative; tests exercise them through `doctor` and the source-size
 * limit so a mismatch fails rather than silently accepting incompatible releases.
 */

/** Must match `patchcraft_core::PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 5;

/** Must match `patchcraft_core::MAX_SOURCE_BYTES`. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Two base64 source snapshots (4/3 of the source size each) plus JSON overhead. */
export const MAX_FRAME_BYTES = 3 * MAX_SOURCE_BYTES;
