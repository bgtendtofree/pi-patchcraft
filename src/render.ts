/** Codex-style summary and diff presentation for apply_patch. Execution never imports this module. */
import os from "node:os";
import { type KeybindingHints, renderDiff, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type PreviewFile, scanPatchPreview } from "./preview.ts";
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
const MAX_DIFF_COLLAPSED = 20;

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

function pathLabel(file: PreviewFile): string {
	const source = displayPath(file.path);
	return file.operation === "move" && file.targetPath ? `${source} → ${displayPath(file.targetPath)}` : source;
}

function countsLabel(theme: RenderTheme, added: number, removed: number): string {
	return `${theme.fg("muted", "(")}${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}${theme.fg("muted", ")")}`;
}

function actionLabel(file: Pick<PatchResultChange, "operation" | "added" | "removed">): string {
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

function countsSuffix(file: PatchResultChange, theme: RenderTheme): string {
	if (file.added === 0 && file.removed === 0 && (file.operation === "move" || file.operation === "delete")) return "";
	return ` ${countsLabel(theme, file.added, file.removed)}`;
}

function multiAction(files: readonly PatchResultChange[]): string {
	if (files.length > 0 && files.every((file) => file.operation === "add")) return "Added";
	if (files.length > 0 && files.every((file) => file.operation === "delete")) return "Deleted";
	if (files.length > 0 && files.every((file) => file.operation === "move" && file.added === 0 && file.removed === 0)) {
		return "Moved";
	}
	return "Edited";
}

function multiSummary(files: readonly PatchResultChange[], added: number, removed: number, theme: RenderTheme): string {
	const action = theme.fg("toolTitle", `${multiAction(files)} ${files.length} files`);
	const empty =
		added === 0 && removed === 0 && files.every((file) => file.operation === "move" || file.operation === "delete");
	return !empty ? `${action} ${countsLabel(theme, added, removed)}` : action;
}

function rosterLine(file: PatchResultChange, theme: RenderTheme): string {
	return `  ${theme.fg("muted", "└")} ${theme.fg(markColor(file), markLabel(file))} ${theme.fg("accent", pathLabel(file))}${countsSuffix(file, theme)}`;
}

function hiddenFiles(count: number, theme: RenderTheme): string {
	return `  ${theme.fg("muted", `… ${count} more files`)}`;
}

export function formatPatchCall(patch: string | undefined, theme: RenderTheme, expanded: boolean): string {
	const heading = title(theme);
	if (typeof patch !== "string") return heading;
	const { files, truncated } = scanPatchPreview(patch);
	const max = expanded ? MAX_ROSTER_EXPANDED : MAX_ROSTER_COLLAPSED;
	const lines = [heading];
	for (const file of files.slice(0, max)) {
		lines.push(`  ${theme.fg(markColor(file), markLabel(file))} ${theme.fg("accent", pathLabel(file))}`);
	}
	if (files.length > max) lines.push(hiddenFiles(files.length - max, theme));
	if (truncated) lines.push(`  ${theme.fg("muted", "(large patch; preview truncated)")}`);
	return lines.join("\n");
}

interface RenderedDiff {
	lines: string[];
	used: number;
	truncated: boolean;
}

function renderChangeDiff(change: PatchResultChange, maxLines?: number): RenderedDiff {
	const diff = sanitize(change.displayDiff).trimEnd();
	if (!diff) return { lines: [], used: 0, truncated: false };
	if (maxLines === undefined) {
		const lines = renderDiff(diff).split("\n");
		return { lines, used: lines.length, truncated: false };
	}
	const visible = diff.split("\n", maxLines + 1);
	const truncated = visible.length > maxLines;
	if (truncated) visible.pop();
	return { lines: renderDiff(visible.join("\n")).split("\n"), used: visible.length, truncated };
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

function formatMultiResult(
	details: PatchResultDetails,
	theme: RenderTheme,
	expanded: boolean,
	keyHint: KeyHint,
): string {
	// The result row is self-contained: exact counts, roster, and (when expanded) diffs. The call row
	// only previews the request, so this also renders correctly in hosts that snapshot rows separately.
	const files = details.changes;
	const lines = [multiSummary(files, details.added, details.removed, theme)];
	const max = expanded ? MAX_ROSTER_EXPANDED : MAX_ROSTER_COLLAPSED;
	const visible = details.changes.slice(0, max);
	let remaining = MAX_DIFF_EXPANDED;
	let truncated = false;
	for (const change of visible) {
		lines.push(rosterLine(change, theme));
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
	if (details.changes.length === 1) {
		const change = details.changes[0] as PatchResultChange;
		const header = `${actionLabel(change)} ${theme.fg("accent", pathLabel(change))}${countsSuffix(change, theme)}`;
		const result = renderChangeDiff(change, options.expanded ? undefined : MAX_DIFF_COLLAPSED);
		return [header, ...result.lines, ...(result.truncated ? [expandHint(theme, options.keyHint)] : [])].join("\n");
	}
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
