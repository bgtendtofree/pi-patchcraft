/**
 * Tolerant scanner for the patch text while it is still streaming.
 *
 * The execution parser rejects incomplete input. This scanner only feeds the TUI, never execution:
 * it ignores malformed lines, caps its work, and coalesces repeated headers for the roster.
 */

export type PreviewOperation = "add" | "update" | "delete" | "move";

export interface PreviewFile {
	operation: PreviewOperation;
	path: string;
	targetPath?: string;
	added: number;
	removed: number;
}

export interface PatchPreview {
	files: PreviewFile[];
	added: number;
	removed: number;
	truncated: boolean;
}

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_FILES = 500;

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export function scanPatchPreview(input: string): PatchPreview {
	const capped = input.length > MAX_PREVIEW_BYTES ? input.slice(0, MAX_PREVIEW_BYTES) : input;
	const lines = capped.split("\n");
	const files: PreviewFile[] = [];
	const byPath = new Map<string, PreviewFile>();
	let current: PreviewFile | undefined;
	let inPatch = false;
	let truncated = input.length > capped.length;
	let added = 0;
	let removed = 0;

	for (const raw of lines) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!inPatch) {
			if (line === BEGIN) inPatch = true;
			continue;
		}
		if (line === END) break;
		if (line === "" || line === BEGIN || line === END_OF_FILE) continue;
		if (line.startsWith(MOVE)) {
			if (current && (current.operation === "update" || current.operation === "move")) {
				const targetPath = line.slice(MOVE.length).trimEnd();
				if (targetPath) {
					current.operation = "move";
					current.targetPath = targetPath;
				}
			}
			continue;
		}
		if (line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE)) {
			const operation: PreviewOperation = line.startsWith(ADD) ? "add" : line.startsWith(DELETE) ? "delete" : "update";
			const prefix = operation === "add" ? ADD : operation === "delete" ? DELETE : UPDATE;
			const path = line.slice(prefix.length).trimEnd();
			if (!path) {
				current = undefined;
				continue;
			}
			const existing = byPath.get(path);
			if (existing) {
				current = existing;
				continue;
			}
			if (files.length >= MAX_PREVIEW_FILES) {
				truncated = true;
				break;
			}
			current = { operation, path, added: 0, removed: 0 };
			byPath.set(path, current);
			files.push(current);
			continue;
		}
		if (!current || current.operation === "delete" || line.startsWith("@@")) continue;
		if (line.startsWith("+")) {
			current.added++;
			added++;
		} else if (line.startsWith("-")) {
			current.removed++;
			removed++;
		}
	}

	return { files, added, removed, truncated };
}
