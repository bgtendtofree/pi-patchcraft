/**
 * Codex apply_patch markers shared by the tolerant TUI scanner and its tests.
 *
 * The pinned Lark grammar in `grammar.ts` and the Rust runtime parser remain authoritative. This
 * table only keeps the TS-side mirror in one place; `patch-format.test.ts` checks it against the
 * pinned grammar.
 */
export const PATCH_MARKERS = {
	begin: "*** Begin Patch",
	end: "*** End Patch",
	add: "*** Add File: ",
	delete: "*** Delete File: ",
	update: "*** Update File: ",
	move: "*** Move to: ",
	endOfFile: "*** End of File",
	context: "@@ ",
	emptyContext: "@@",
} as const;

export type PatchOperation = "add" | "update" | "delete" | "move";

type FileHeaderOperation = Exclude<PatchOperation, "move">;

interface FileHeader {
	operation: FileHeaderOperation;
	path: string;
}

const FILE_HEADERS: readonly [FileHeaderOperation, string][] = [
	["add", PATCH_MARKERS.add],
	["delete", PATCH_MARKERS.delete],
	["update", PATCH_MARKERS.update],
];

/**
 * The runtime parser trims both ends at the top level and in Add/Delete modes, but only the end
 * while an Update File hunk is open: a leading space there is a context line, not a marker.
 */
export function normalizeMarkerLine(line: string, operation: PatchOperation | undefined): string {
	return operation === "update" || operation === "move" ? line.trimEnd() : line.trim();
}

/**
 * Parse a file header from a line already normalized by {@link normalizeMarkerLine}. Trailing
 * whitespace is ignored; a header without a path does not match.
 */
export function parseFileHeader(line: string): FileHeader | undefined {
	for (const [operation, marker] of FILE_HEADERS) {
		if (line.startsWith(marker)) return { operation, path: line.slice(marker.length) };
	}
	return undefined;
}

/** Parse `*** Move to:` from a normalized marker line. */
export function parseMoveTarget(line: string): string | undefined {
	return line.startsWith(PATCH_MARKERS.move) ? line.slice(PATCH_MARKERS.move.length) : undefined;
}
