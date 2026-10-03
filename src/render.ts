import { basename, dirname, sep } from "node:path";
import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, sliceByColumn, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	getPatchDetails,
	type PatchRowSummary,
	type PatchRowTitle,
	patchDetailSections,
	patchSummary,
	patchTitle,
} from "./row.ts";
import type { PatchResultDetails } from "./types.ts";

/** Columns kept between a row's title and its metrics. */
const METRIC_GAP = 2;
/** Diff lines shown per change in the expanded body. */
const DIFF_LINE_LIMIT = 20;

/** Per-row renderer state shared by the call and result renders of one tool call. */
export interface PatchRowState {
	header?: PatchRowHeader;
}

/** The subset of Pi's ToolRenderContext the row reads. */
export interface PatchRenderContext {
	state?: PatchRowState;
	args?: unknown;
	cwd?: string;
	isError?: boolean;
}

interface PatchResultView {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

/**
 * The one-line row: title on the left, status and metrics right-aligned. It is created by
 * `renderPatchCall` and updated in place by `renderPatchResult`, so a completed patch keeps
 * a single row instead of stacking a second title line.
 */
export class PatchRowHeader implements Component {
	private theme: Theme;
	private title: PatchRowTitle;
	private summary: PatchRowSummary | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] = [];

	constructor(theme: Theme, title: PatchRowTitle) {
		this.theme = theme;
		this.title = title;
	}

	configure(theme: Theme, title: PatchRowTitle, summary?: PatchRowSummary): void {
		this.theme = theme;
		this.title = title;
		this.summary = summary;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const verb = theme.fg("toolTitle", theme.bold(this.title.verb));
		const suffix = this.title.subjectSuffix ? theme.fg("accent", this.title.subjectSuffix) : "";
		const context = this.title.context ? theme.fg("dim", `in ${this.title.context}`) : "";
		const tail = [suffix, context].filter(Boolean).join(" ");
		const right = this.renderMetrics();
		const available = width - (right ? visibleWidth(right) + METRIC_GAP : 0);
		const parts = [verb];
		const subject = this.title.subject;
		if (subject !== undefined) {
			const gaps = 1 + (tail ? 1 : 0);
			const budget = available - visibleWidth(verb) - visibleWidth(tail) - gaps;
			parts.push(theme.fg("accent", this.elideSubject(subject, budget)));
		}
		if (tail) parts.push(tail);
		this.cachedLines = [truncateToWidth(this.join(width, parts.filter(Boolean).join(" "), right), width, "…")];
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
	}

	/** Only the subject shrinks: the verb, suffix, context, and right-aligned summary keep their place. */
	private elideSubject(subject: string, budget: number): string {
		if (budget <= 0) return "";
		if (visibleWidth(subject) <= budget) return subject;
		if (this.title.subjectKind === "path") return compactPath(subject, budget);
		return truncateToWidth(subject, budget, "…");
	}

	/** Right-align the summary, or butt it against a title too wide to spare the gap. */
	private join(width: number, left: string, right: string): string {
		if (!right) return left;
		const available = width - visibleWidth(left) - visibleWidth(right) - METRIC_GAP;
		if (available >= 0) return `${left}${" ".repeat(available + METRIC_GAP)}${right}`;
		return `${truncateToWidth(left, Math.max(0, width - visibleWidth(right) - METRIC_GAP), "…")}${" ".repeat(METRIC_GAP)}${right}`;
	}

	private renderMetrics(): string {
		const theme = this.theme;
		const summary = this.summary;
		if (!summary) return "";
		const status = summary.status ? theme.fg(summary.status === "failed" ? "error" : "muted", summary.status) : "";
		const metrics = summary.metrics.map((metric) => theme.fg("dim", metric));
		return [status, ...metrics].filter(Boolean).join(theme.fg("dim", " · "));
	}
}

function asPatchRowState(state: unknown): PatchRowState {
	return typeof state === "object" && state !== null ? (state as PatchRowState) : {};
}

/**
 * Path-aware elision for a subject: keep the file name and the nearest directory, prefix the
 * rest with `…`, and fall back to the file name when even that does not fit.
 */
export function compactPath(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	const name = basename(value);
	const parent = basename(dirname(value));
	const suffix = parent && parent !== "." ? `${parent}${sep}${name}` : name;
	const tail = visibleWidth(suffix) + 2 <= width ? suffix : name;
	const headWidth = width - visibleWidth(tail) - 2;
	if (headWidth < 0) return truncateToWidth(name, width, "…");
	return `${sliceByColumn(value, 0, headWidth, true)}…${sep}${tail}`;
}

/**
 * The call row. A header is reused from `context.state` across renders so the result can
 * update the same row instead of adding another; without a state object it still returns
 * a working header.
 */
export function renderPatchCall(args: unknown, theme: Theme, context: PatchRenderContext = {}): Component {
	const state = asPatchRowState(context.state);
	const title = patchTitle(args);
	const header = state.header ?? new PatchRowHeader(theme, title);
	state.header = header;
	header.configure(theme, title);
	return header;
}

/**
 * The result row. It updates the call header with the result-derived title, status, and
 * metrics, and returns the body: the error text, the streaming notice, or the expanded
 * diff sections. Collapsed success renders no body.
 */
export function renderPatchResult(
	result: PatchResultView,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: PatchRenderContext = {},
): Component {
	const state = asPatchRowState(context.state);
	const summary = patchSummary({
		details: result.details,
		args: context.args,
		isError: context.isError === true,
		...(context.cwd === undefined ? {} : { cwd: context.cwd }),
	});
	const header = state.header ?? new PatchRowHeader(theme, summary.title);
	state.header = header;
	header.configure(theme, summary.title, summary);

	if (context.isError) return errorBody(result, theme);
	if (options.isPartial) return partialBody(result, theme);
	if (!options.expanded) return new Container();
	const plan = getPatchDetails(result.details);
	return plan ? detailBody(plan, theme) : new Container();
}

function errorBody(result: PatchResultView, theme: Theme): Text {
	const text = (result.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return new Text(theme.fg("error", text || "Patch failed."), 0, 0, (line) => theme.bg("toolErrorBg", line));
}

function partialBody(result: PatchResultView, theme: Theme): Text {
	const text = result.content?.find((part) => part.type === "text")?.text ?? "Applying patch…";
	return new Text(theme.fg("warning", text), 0, 0);
}

function detailBody(plan: PatchResultDetails, theme: Theme): Component {
	const lines: string[] = [];
	let omitted = 0;
	for (const section of patchDetailSections(plan)) {
		lines.push(theme.fg("accent", section.title));
		const diff = renderDiff(section.text)
			.split("\n")
			.filter((line) => line.length > 0);
		lines.push(...diff.slice(0, DIFF_LINE_LIMIT));
		omitted += Math.max(0, diff.length - DIFF_LINE_LIMIT);
	}
	if (omitted > 0) lines.push(theme.fg("dim", `… ${omitted} more line${omitted === 1 ? "" : "s"}`));
	return lines.length > 0 ? new Text(lines.join("\n"), 0, 0) : new Container();
}
