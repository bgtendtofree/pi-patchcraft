import { isAbsolute, relative, sep } from "node:path";
import { parsePatch } from "./parser.ts";
import type { PatchResultDetails } from "./types.ts";

/** What the row says before any result exists: the operation and its target. */
export interface PatchRowTitle {
	verb: string;
	subject?: string;
	/** `path` keeps the file name and nearest directories when the row is narrow. */
	subjectKind?: "path";
	/** Non-path text kept after the subject, for example ` +3 files` or `→ new.ts`. */
	subjectSuffix?: string;
	context?: string;
}

/** The row after a result: a result-derived title, metrics, and an optional status. */
export interface PatchRowSummary {
	title: PatchRowTitle;
	metrics: string[];
	status?: string;
}

/** One expanded body block: a change title and the diff Patchcraft already computed. */
export interface PatchDetailSection {
	title: string;
	text: string;
}

/** The result fields the row reads. Streaming callers pass only `isError`. */
export interface PatchRowView {
	details?: unknown;
	args?: unknown;
	cwd?: string;
	isError: boolean;
}

interface PatchHeader {
	operation: "add" | "delete" | "move" | "update";
	path: string;
	targetPath?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Parse the call arguments into the rows the patch will touch; malformed text yields none. */
function patchHeaders(value: unknown): PatchHeader[] {
	const values = asRecord(value);
	const patch = [values.patch, values.input, values.patchText].find((candidate) => typeof candidate === "string");
	if (typeof patch !== "string") return [];
	try {
		return parsePatch(patch).map((operation): PatchHeader => {
			if (operation.type !== "update") return { operation: operation.type, path: operation.path };
			if (operation.moveTo === undefined) return { operation: "update", path: operation.path };
			return { operation: "move", path: operation.path, targetPath: operation.moveTo };
		});
	} catch {
		return [];
	}
}

const PATCH_OPERATIONS = new Set(["add", "delete", "update", "move"]);

function isPlannedChange(value: unknown): boolean {
	const change = asRecord(value);
	return (
		typeof change.operation === "string" &&
		PATCH_OPERATIONS.has(change.operation) &&
		typeof change.path === "string" &&
		typeof change.targetPath === "string" &&
		change.targetPath.length > 0
	);
}

/** The result details shape; malformed or empty plans are rejected, never trusted. */
export function getPatchDetails(value: unknown): PatchResultDetails | undefined {
	const record = asRecord(value);
	if (
		!Array.isArray(record.changes) ||
		record.changes.length === 0 ||
		typeof record.added !== "number" ||
		typeof record.removed !== "number" ||
		typeof record.fuzz !== "number" ||
		!record.changes.every(isPlannedChange)
	) {
		return undefined;
	}
	return value as PatchResultDetails;
}

/** Shorten a path against a known cwd; never guesses one. */
function displayPath(value: string, cwd?: string): string {
	if (typeof cwd !== "string" || !isAbsolute(value)) return value;
	const local = relative(cwd, value);
	return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ? value : local || ".";
}

/** A change title for the expanded body, e.g. `Update src/a.ts (+1 -1)`. */
export function changeTitle(change: PatchResultDetails["changes"][number]): string {
	const operation = change.operation.charAt(0).toUpperCase() + change.operation.slice(1);
	const target = change.operation === "move" ? `${change.path} → ${change.targetPath}` : change.targetPath;
	return `${operation} ${target} (+${change.added} -${change.removed})`;
}

/** The call-time title: first target file, or a file count for multi-file patches. */
export function patchTitle(args: unknown): PatchRowTitle {
	const headers = patchHeaders(args);
	if (headers.length === 0) return { verb: "Patch", subject: "…" };
	if (headers.length > 1) {
		return {
			verb: "Patch",
			subject: `${headers.length} files`,
			context: headers
				.slice(0, 2)
				.map((header) => header.targetPath ?? header.path)
				.join(", "),
		};
	}

	const header = headers[0];
	if (!header) return { verb: "Patch", subject: "…" };
	if (header.operation === "add") return { verb: "Add", subject: header.path, subjectKind: "path" };
	if (header.operation === "delete") return { verb: "Delete", subject: header.path, subjectKind: "path" };
	if (header.operation === "move") {
		return {
			verb: "Move",
			subject: header.path,
			subjectKind: "path",
			subjectSuffix: `→ ${header.targetPath ?? "…"}`,
		};
	}
	return { verb: "Update", subject: header.path, subjectKind: "path" };
}

/** The one metric vocabulary: added, removed, and fuzz, zero values suppressed. */
export function patchMetrics(plan: PatchResultDetails): string[] {
	const metrics: string[] = [];
	if (plan.added > 0) metrics.push(`+${plan.added}`);
	if (plan.removed > 0) metrics.push(`-${plan.removed}`);
	if (plan.fuzz > 0) metrics.push(`fuzz ${plan.fuzz}`);
	return metrics;
}

/**
 * The result row. A valid plan names its first target plus ` +N files` and carries the
 * metrics; a missing or malformed plan falls back to the call-time title. An error is
 * always `failed`, even when details are unusable.
 */
export function patchSummary(view: PatchRowView): PatchRowSummary {
	const fallback = patchTitle(view.args);
	const failure = view.isError ? { status: "failed" } : {};
	const plan = getPatchDetails(view.details);
	const first = plan?.changes[0];
	if (!plan || !first) return { title: fallback, metrics: [], ...failure };

	const suffix =
		plan.changes.length > 1 ? `+${plan.changes.length - 1} file${plan.changes.length > 2 ? "s" : ""}` : undefined;
	return {
		title: {
			verb: plan.changes.length > 1 ? "Patch" : fallback.verb,
			subject: displayPath(first.targetPath, view.cwd),
			subjectKind: "path",
			...(suffix === undefined ? {} : { subjectSuffix: suffix }),
		},
		metrics: patchMetrics(plan),
		...failure,
	};
}

/** Expanded body sections, one per change carrying a diff. */
export function patchDetailSections(plan: PatchResultDetails): PatchDetailSection[] {
	return plan.changes.flatMap((change) =>
		typeof change.displayDiff === "string" && change.displayDiff.length > 0
			? [{ title: changeTitle(change), text: change.displayDiff }]
			: [],
	);
}
