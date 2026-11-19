/**
 * Lark grammar for the Codex apply_patch format.
 *
 * Copied verbatim from OpenAI Codex `codex-rs/core/assets/tools/apply_patch.lark`
 * at the revision pinned in `rust/patchcraft-core/README.md`.
 * Capable models write the patch as raw text instead of a JSON-escaped string; Pi falls back to the
 * JSON-schema function tool on providers without grammar constrained sampling.
 *
 * Like Codex, the runtime parser is authoritative: this grammar admits some shorthand it
 * rejects (e.g. a move without a chunk). Marker spellings are mirrored in `src/patch-format.ts`
 * and the Rust parser; the grammar string itself stays byte-for-byte upstream.
 * Pi requires exactly one
 * required string property in the tool parameters (here `patch`), or Pi rejects every request.
 */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
