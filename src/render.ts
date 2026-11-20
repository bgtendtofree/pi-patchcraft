/** Codex-style summary and diff presentation for apply_patch. Execution never imports this module. */
import os from "node:os";
import { type KeybindingHints, renderDiff, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PatchPreview, PreviewFile } from "./preview.ts";
import type { PatchResultChange, PatchResultDetails } from "./types.ts";

export interface RenderTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

/**
 * Pi injects the hint helpers into the render context so they read the running instance's configured
 * keys. Importing `keyHint()` from the package can resolve another copy that never saw them.
 */
export type KeyHint = KeybindingHints["keyHint"];

interface TextBlock {
	type: string;
	text?: string;
}

const MAX_ROSTER_COLLAPSED = 10;
const MAX_ROSTER_EXPANDED = 500;
const MAX_DIFF_EXPANDED = 2000;
const MAX_DIFF_PER_FILE = 500;
const MAX_PATH_CHARS = 80;
const MAX_LINE_CHARS = 200;

function sanitize(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (character) => (character === "\n" || character === "\t" ? character : ""))
		.replace(/\t/g, "   ");
}

function sanitizeInline(text: string): string {
	return sanitize(text).replace(/\n/g, " ").trim();
}

function displayPath(value: string): string {
	const sanitized = sanitizeInline(value);
	const home = os.homedir();
	const shortened = sanitized.startsWith(home) ? `~${sanitized.slice(home.length)}` : sanitized;
	return shortened.length > MAX_PATH_CHARS ? `…${shortened.slice(shortened.length - MAX_PATH_CHARS + 1)}` : shortened;
}

function pathLabel(file: Pick<PreviewFile, "path" | "targetPath">): string {
	const source = displayPath(file.path);
	return file.targetPath ? `${source} → ${displayPath(file.targetPath)}` : source;
}

function countsLabel(theme: RenderTheme, added: number, removed: number): string {
	return `${theme.fg("muted", "(")}${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}${theme.fg("muted", ")")}`;
}

function actionLabel(file: Pick<PreviewFile, "operation" | "added" | "removed">): string {
	if (file.operation === "add") return "Added";
	if (file.operation === "delete") return "Deleted";
	if (file.operation === "move" && file.added === 0 && file.removed === 0) return "Moved";
	return "Edited";
}

function markLabel(file: Pick<PreviewFile, "operation">): string {
	if (file.operation === "add") return "A";
	if (file.operation === "delete") return "D";
	return "M";
}

function markColor(file: Pick<PreviewFile, "operation">): ThemeColor {
	if (file.operation === "add") return "toolDiffAdded";
	if (file.operation === "delete") return "toolDiffRemoved";
	return "warning";
}

function title(theme: RenderTheme): string {
	return theme.fg("toolTitle", theme.bold("apply_patch"));
}

function countsSuffix(file: PreviewFile, theme: RenderTheme): string {
	if (file.added === 0 && file.removed === 0 && (file.operation === "move" || file.operation === "delete")) return "";
	return ` ${countsLabel(theme, file.added, file.removed)}`;
}

function singleHeader(file: PreviewFile, theme: RenderTheme): string {
	return `${title(theme)}  ${theme.fg("toolTitle", actionLabel(file))} ${theme.fg("accent", pathLabel(file))}${countsSuffix(file, theme)}`;
}

function multiAction(files: readonly PreviewFile[]): string {
	if (files.length > 0 && files.every((file) => file.operation === "add")) return "Added";
	if (files.length > 0 && files.every((file) => file.operation === "delete")) return "Deleted";
	if (files.length > 0 && files.every((file) => file.operation === "move" && file.added === 0 && file.removed === 0)) {
		return "Moved";
	}
	return "Edited";
}

function multiSummary(
	files: readonly PreviewFile[],
	added: number,
	removed: number,
	theme: RenderTheme,
	showCounts: boolean,
): string {
	const action = theme.fg("toolTitle", `${multiAction(files)} ${files.length} files`);
	const empty =
		added === 0 && removed === 0 && files.every((file) => file.operation === "move" || file.operation === "delete");
	return showCounts && !empty ? `${action} ${countsLabel(theme, added, removed)}` : action;
}

function rosterLine(file: PreviewFile, theme: RenderTheme): string {
	return `  ${theme.fg("muted", "└")} ${theme.fg(markColor(file), markLabel(file))} ${theme.fg("accent", pathLabel(file))}${countsSuffix(file, theme)}`;
}

function hiddenFiles(count: number, theme: RenderTheme): string {
	return `  ${theme.fg("muted", `… ${count} more files`)}`;
}

function focusFile(files: readonly PreviewFile[]): PreviewFile | undefined {
	for (let index = files.length - 1; index >= 0; index--) {
		const file = files[index];
		if (file && file.operation !== "delete" && file.lines.length > 0) return file;
	}
	return files.at(-1);
}

function sanitizeLine(text: string): string {
	const clean = sanitize(text).replace(/\n/g, " ");
	return clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS - 1)}…` : clean;
}

function appendGlimpse(
	lines: string[],
	file: PreviewFile,
	theme: RenderTheme,
	expanded: boolean,
	indent: string,
): void {
	if (file.operation === "delete" || file.lines.length === 0) return;
	const max = expanded ? MAX_ROSTER_EXPANDED : MAX_ROSTER_COLLAPSED;
	const visible = file.lines.slice(0, max);
	for (const line of visible) {
		const sign = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
		const color =
			line.type === "add" ? "toolDiffAdded" : line.type === "delete" ? "toolDiffRemoved" : "toolDiffContext";
		lines.push(`${indent}${theme.fg(color, `${sign}${sanitizeLine(line.text)}`)}`);
	}
	const remaining = file.lines.length - visible.length;
	if (remaining > 0) {
		lines.push(`${indent}${theme.fg("muted", `… ${remaining} more lines`)}`);
	}
}

interface CallPreviewOptions {
	expanded: boolean;
	argsComplete: boolean;
	executionStarted: boolean;
}

function formatCallPreview(preview: PatchPreview, theme: RenderTheme, options: CallPreviewOptions): string {
	if (preview.files.length === 0) return title(theme);
	if (preview.files.length === 1) {
		const file = preview.files[0] as PreviewFile;
		const lines = [singleHeader(file, theme)];
		if (options.argsComplete && !options.executionStarted) {
			appendGlimpse(lines, file, theme, options.expanded, "  ");
		}
		if (preview.truncated && !options.executionStarted) {
			lines.push(`  ${theme.fg("muted", "(large patch; preview truncated)")}`);
		}
		return lines.join("\n");
	}

	// Once execution starts, the result row owns the summary, roster, and exact counts.
	if (options.executionStarted) return title(theme);
	// Delete counts are only known after reading the source, so omit uncertain totals from the preview.
	const showCounts = preview.files.every((file) => file.operation !== "delete");
	const lines = [`${title(theme)}  ${multiSummary(preview.files, preview.added, preview.removed, theme, showCounts)}`];
	const max = options.expanded ? MAX_ROSTER_EXPANDED : MAX_ROSTER_COLLAPSED;
	const visible = preview.files.slice(0, max);
	const focus = options.argsComplete ? focusFile(visible) : undefined;
	for (const file of visible) {
		lines.push(rosterLine(file, theme));
		if (file === focus) appendGlimpse(lines, file, theme, options.expanded, "    ");
	}
	const hidden = preview.files.length - visible.length;
	if (hidden > 0) lines.push(hiddenFiles(hidden, theme));
	if (preview.truncated) lines.push(`  ${theme.fg("muted", "(large patch; preview truncated)")}`);
	return lines.join("\n");
}

export function formatPatchCall(
	preview: PatchPreview,
	theme: RenderTheme,
	options: { expanded: boolean; argsComplete: boolean; executionStarted?: boolean },
): string {
	return formatCallPreview(preview, theme, {
		expanded: options.expanded,
		argsComplete: options.argsComplete,
		executionStarted: options.executionStarted ?? false,
	});
}

interface RenderedDiff {
	lines: string[];
	used: number;
	truncated: boolean;
}

function renderChangeDiff(change: PatchResultChange, maxLines: number): RenderedDiff {
	const diff = sanitize(change.displayDiff).trimEnd();
	if (!diff) return { lines: [], used: 0, truncated: false };
	const lines = renderDiff(diff).split("\n");
	if (lines.length <= maxLines) return { lines, used: lines.length, truncated: false };
	return { lines: lines.slice(0, maxLines), used: maxLines, truncated: true };
}

function indent(lines: readonly string[], prefix: string): string[] {
	return lines.map((line) => `${prefix}${line}`);
}

function outputTruncated(theme: RenderTheme): string {
	return `  ${theme.fg("muted", "… output truncated")}`;
}

function expandHint(theme: RenderTheme, keyHint: KeyHint): string {
	return `  ${theme.fg("muted", keyHint("app.tools.expand", "to expand diffs"))}`;
}

function previewFromChange(change: PatchResultChange): PreviewFile {
	return {
		operation: change.operation,
		path: change.path,
		...(change.operation === "move" ? { targetPath: change.targetPath } : {}),
		added: change.added,
		removed: change.removed,
		lines: [],
	};
}

function formatSingleResult(change: PatchResultChange): string {
	// Match Pi's edit tool: a single-file diff is shown in full, without a collapsed cap.
	const diff = renderChangeDiff(change, Number.POSITIVE_INFINITY);
	return diff.lines.join("\n");
}

function formatMultiResult(
	details: PatchResultDetails,
	theme: RenderTheme,
	expanded: boolean,
	keyHint: KeyHint,
): string {
	// The result row is self-contained: exact counts, roster, and (when expanded) diffs. The call row
	// only previews the request, so this also renders correctly in hosts that snapshot rows separately.
	const files = details.changes.map(previewFromChange);
	const lines = [multiSummary(files, details.added, details.removed, theme, true)];
	const max = expanded ? MAX_ROSTER_EXPANDED : MAX_ROSTER_COLLAPSED;
	const visible = details.changes.slice(0, max);
	let remaining = MAX_DIFF_EXPANDED;
	let truncated = false;
	for (const [index, change] of visible.entries()) {
		lines.push(rosterLine(files[index] as PreviewFile, theme));
		if (!expanded) continue;
		if (remaining <= 0) {
			truncated = true;
			continue;
		}
		const diff = renderChangeDiff(change, Math.min(MAX_DIFF_PER_FILE, remaining));
		if (diff.lines.length > 0) lines.push(...indent(diff.lines, "    "));
		remaining -= diff.used;
		truncated ||= diff.truncated;
	}
	const hidden = details.changes.length - visible.length;
	if (hidden > 0) lines.push(hiddenFiles(hidden, theme));
	if (expanded && truncated) lines.push(outputTruncated(theme));
	const hasDiff = details.changes.some((change) => change.displayDiff.trim().length > 0);
	if (!expanded && hasDiff) lines.push(expandHint(theme, keyHint));
	return lines.join("\n");
}

export function formatPatchResult(
	details: PatchResultDetails,
	theme: RenderTheme,
	options: { expanded: boolean; keyHint: KeyHint },
): string {
	if (details.changes.length === 0) return "";
	if (details.changes.length === 1) return formatSingleResult(details.changes[0] as PatchResultChange);
	return formatMultiResult(details, theme, options.expanded, options.keyHint);
}

function textContent(content: readonly TextBlock[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}

function formatPatchMessage(content: readonly TextBlock[], theme: RenderTheme, color: "error" | "warning"): string {
	const text = textContent(content);
	return text ? theme.fg(color, sanitize(text)) : "";
}

export function formatPatchError(content: readonly TextBlock[], theme: RenderTheme): string {
	return formatPatchMessage(content, theme, "error");
}

export function formatPatchProgress(content: readonly TextBlock[], theme: RenderTheme): string {
	return formatPatchMessage(content, theme, "warning");
}
