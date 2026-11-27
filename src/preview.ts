/** Bounded, display-only roster for complete arguments. The Rust parser validates execution. */

import {
	normalizeMarkerLine,
	PATCH_MARKERS,
	type PatchOperation,
	parseFileHeader,
	parseMoveTarget,
} from "./patch-format.ts";

export interface PreviewFile {
	operation: PatchOperation;
	path: string;
	targetPath?: string;
}

export interface PatchPreview {
	files: PreviewFile[];
	truncated: boolean;
}

const MAX_PREVIEW_CHARS = 256 * 1024;
const MAX_PREVIEW_FILES = 500;

export function scanPatchPreview(input: string): PatchPreview {
	const capped = input.length > MAX_PREVIEW_CHARS ? input.slice(0, MAX_PREVIEW_CHARS) : input;
	const lines = capped.split("\n");
	const files: PreviewFile[] = [];
	const byPath = new Map<string, PreviewFile>();
	let current: PreviewFile | undefined;
	let inPatch = false;
	let truncated = input.length > capped.length;

	for (const raw of lines) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!inPatch) {
			if (normalizeMarkerLine(line, undefined) === PATCH_MARKERS.begin) inPatch = true;
			continue;
		}
		// Match the core's whitespace rules: a leading space inside an open update hunk is a
		// context line, not a new marker.
		const marker = normalizeMarkerLine(line, current?.operation);
		if (marker === PATCH_MARKERS.end) break;
		if (marker === "" || marker === PATCH_MARKERS.begin || marker === PATCH_MARKERS.endOfFile) continue;
		const target = parseMoveTarget(marker);
		if (target !== undefined) {
			if (current && (current.operation === "update" || current.operation === "move")) {
				current.operation = "move";
				current.targetPath = target;
			}
			continue;
		}
		const header = parseFileHeader(marker);
		if (header) {
			const { operation, path } = header;
			const existing = byPath.get(path);
			if (existing) {
				current = existing;
				continue;
			}
			if (files.length >= MAX_PREVIEW_FILES) {
				truncated = true;
				break;
			}
			current = { operation, path };
			byPath.set(path, current);
			files.push(current);
			continue;
		}
	}

	return { files, truncated };
}
