/**
 * Model-facing apply_patch guidance.
 *
 * Adapted from Codex's instructions, not copied verbatim: Patchcraft also exposes a JSON function
 * tool, so this text cannot assume Codex's freeform channel or its relative-path rule. Grammar
 * lives in grammar.ts; keep format rules here only where fallback models need them.
 */
export const APPLY_PATCH_DESCRIPTION = "Apply a Codex-format patch to add, update, move, or delete files.";

/** The envelope is explained once in the guidelines below; keep this parameter description short. */
export const APPLY_PATCH_PARAMETER_DESCRIPTION = "Complete patch text.";

export const APPLY_PATCH_PROMPT_SNIPPET = "Edit one or more files with a single patch";

export const APPLY_PATCH_PROMPT_GUIDELINES: string[] = [
	"Use apply_patch for file edits; combine related changes into one patch.",
	"apply_patch uses *** Begin Patch ... *** End Patch; each section starts with *** Add File:, *** Delete File:, or *** Update File:; prefix every added line, including blank lines, with +.",
	"apply_patch Update hunks start with @@ and 2-3 lines of unchanged context; use one *** Update File: header per file, and *** Move to: plus a hunk for renames.",
	"apply_patch resolves relative paths from cwd and accepts absolute paths; prefer relative. If a patch fails, re-read the file and retry with smaller, unambiguous hunks.",
];
