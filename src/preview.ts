/**
 * Tolerant scanner for the patch text while it is still streaming.
 *
 * The execution parser rejects incomplete input. This scanner only feeds the TUI, never execution:
 * it ignores malformed lines, caps its work, and coalesces repeated headers for the roster.
 */

import {
	normalizeMarkerLine,
	PATCH_MARKERS,
	type PatchOperation,
	parseFileHeader,
	parseMoveTarget,
} from "./patch-format.ts";

type PreviewLineType = "add" | "delete" | "context";

interface PreviewLine {
	type: PreviewLineType;
	text: string;
}

export interface PreviewFile {
	operation: PatchOperation;
	path: string;
	targetPath?: string;
	added: number;
	removed: number;
	lines: PreviewLine[];
}

export interface PatchPreview {
	files: PreviewFile[];
	added: number;
	removed: number;
	truncated: boolean;
}

const MAX_PREVIEW_CHARS = 256 * 1024;
const MAX_PREVIEW_FILES = 500;
const MAX_PREVIEW_LINES = 2000;
const MAX_PREVIEW_LINES_PER_FILE = 500;
const MAX_PREVIEW_LINE_CHARS = 200;

export function scanPatchPreview(input: string): PatchPreview {
	const capped = input.length > MAX_PREVIEW_CHARS ? input.slice(0, MAX_PREVIEW_CHARS) : input;
	const lines = capped.split("\n");
	const files: PreviewFile[] = [];
	const byPath = new Map<string, PreviewFile>();
	let current: PreviewFile | undefined;
	let inPatch = false;
	let truncated = input.length > capped.length;
	let added = 0;
	let removed = 0;
	let storedLines = 0;

	const pushLine = (file: PreviewFile, type: PreviewLineType, text: string): void => {
		if (storedLines >= MAX_PREVIEW_LINES || file.lines.length >= MAX_PREVIEW_LINES_PER_FILE) {
			truncated = true;
			return;
		}
		file.lines.push({
			type,
			text: text.length > MAX_PREVIEW_LINE_CHARS ? `${text.slice(0, MAX_PREVIEW_LINE_CHARS - 1)}…` : text,
		});
		storedLines++;
	};

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
			current = { operation, path, added: 0, removed: 0, lines: [] };
			byPath.set(path, current);
			files.push(current);
			continue;
		}
		if (
			!current ||
			current.operation === "delete" ||
			marker === PATCH_MARKERS.emptyContext ||
			marker.startsWith(PATCH_MARKERS.context)
		) {
			continue;
		}
		if (current.operation === "add") {
			if (line.startsWith("+")) {
				current.added++;
				added++;
				pushLine(current, "add", line.slice(1));
			}
			continue;
		}
		if (line.startsWith("+")) {
			current.added++;
			added++;
			pushLine(current, "add", line.slice(1));
		} else if (line.startsWith("-")) {
			current.removed++;
			removed++;
			pushLine(current, "delete", line.slice(1));
		} else if (line.startsWith(" ")) {
			pushLine(current, "context", line.slice(1));
		}
	}

	return { files, added, removed, truncated };
}
