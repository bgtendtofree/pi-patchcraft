import { isAbsolute, relative, sep } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { parsePatch } from "./parser.ts";
import type { PatchResultDetails } from "./types.ts";

const API_KEY = Symbol.for("@bgtendtofree/pi-progressive-tools/api/v2");
const PENDING_KEY = Symbol.for("@bgtendtofree/pi-progressive-tools/pending/v2");

// Mirrors the Progressive Tools v2 protocol (@bgtendtofree/pi-progressive-tools).
// Keep in sync when the host protocol changes; cross-repo type-only assertions are
// not possible while that package is private and unpublished.
interface ProgressiveToolTitle {
	verb: string;
	subject?: string;
	context?: string;
	/** Subject shrink policy when the row is narrow. "path" prefers the file name. */
	elide?: "end" | "middle" | "path";
	accentSubject?: boolean;
}

interface ProgressiveToolResultView {
	/** Final result text, kept for previews. */
	text?: string;
	/** Original input; historical orphan results may omit it. */
	args?: unknown;
	cwd?: string;
	content?: unknown[];
	details?: unknown;
	nestedCalls?: unknown;
	isError: boolean;
	/** True while the tool still streams; terminal metrics are usually unavailable. */
	isPartial?: boolean;
}

interface ProgressiveToolSummary {
	/** Optional result-derived title; never rewrites arguments. */
	title?: ProgressiveToolTitle;
	status?: string;
	/** Highlight a non-fatal status without changing the execution phase. */
	statusTone?: "warning";
	metrics?: string[];
}

interface ProgressiveToolDetailSection {
	title?: string;
	text: string;
	format?: "diff" | "text";
}

interface ProgressiveToolDetail {
	sections: ProgressiveToolDetailSection[];
	hideMetadata?: boolean;
}

export interface ProgressiveToolAdapter {
	version: 2;
	id: string;
	toolNames: string[];
	title(args: unknown, context?: { cwd?: string }): ProgressiveToolTitle;
	summarize?(result: ProgressiveToolResultView): ProgressiveToolSummary;
	detail?(result: ProgressiveToolResultView): ProgressiveToolDetail | undefined;
}

interface ProgressiveToolsAPI {
	version: 2;
	registerAdapter(adapter: ProgressiveToolAdapter): () => void;
	renderCall(adapter: ProgressiveToolAdapter, args: unknown, theme: unknown, context: unknown): Component;
	renderResult(
		adapter: ProgressiveToolAdapter,
		result: unknown,
		options: unknown,
		theme: unknown,
		context: unknown,
	): Component;
}

type ProtocolGlobal = typeof globalThis & {
	[API_KEY]?: ProgressiveToolsAPI;
	[PENDING_KEY]?: ProgressiveToolAdapter[];
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

interface PatchHeader {
	operation: "add" | "delete" | "move" | "update";
	path: string;
	targetPath?: string;
}

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

/** The published PatchResultDetails shape; malformed or empty plans are rejected. */
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

/** Shorten a path against a known cwd; never guesses one. Mirrors the host's displayPath,
 * so Patchcraft's own summary matches the rows Progressive Tools used to build. */
function displayPath(value: string, cwd?: string): string {
	if (typeof cwd !== "string" || !isAbsolute(value)) return value;
	const local = relative(cwd, value);
	return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ? value : local || ".";
}

function changeTitle(change: PatchResultDetails["changes"][number]): string {
	const operation = change.operation[0]?.toUpperCase() + change.operation.slice(1);
	const target = change.operation === "move" ? `${change.path} → ${change.targetPath}` : change.targetPath;
	return `${operation} ${target} (+${change.added} -${change.removed})`;
}

/** Paths keep both ends when the row is narrow; the tail carries the file name. */
function pathTitle(verb: string, subject: string): ProgressiveToolTitle {
	return { verb, subject, elide: "middle", accentSubject: true };
}

function patchTitle(args: unknown): ProgressiveToolTitle {
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
	if (header.operation === "add") return pathTitle("Add", header.path);
	if (header.operation === "delete") return pathTitle("Delete", header.path);
	if (header.operation === "move") {
		return pathTitle("Move", `${header.path} → ${header.targetPath ?? "…"}`);
	}
	return pathTitle("Update", header.path);
}

export const patchcraftAdapter: ProgressiveToolAdapter = {
	version: 2,
	id: "@bgtendtofree/pi-patchcraft/apply-patch",
	toolNames: ["apply_patch"],
	title(args) {
		return patchTitle(args);
	},
	summarize(view) {
		const plan = getPatchDetails(view.details);
		if (!plan) return view.isError ? { status: "failed" } : {};
		const changes = plan.changes;
		const first = changes[0];
		if (first === undefined) return view.isError ? { status: "failed" } : {};
		const metrics: string[] = [];
		if (plan.added > 0) metrics.push(`+${plan.added}`);
		if (plan.removed > 0) metrics.push(`-${plan.removed}`);
		if (plan.fuzz > 0) metrics.push(`fuzz ${plan.fuzz}`);
		// Multi-file rows carry the remaining-file count in the subject; the numeric file
		// metric was folded into it, so summarize never repeats it.
		const suffix = changes.length > 1 ? ` +${changes.length - 1} file${changes.length > 2 ? "s" : ""}` : "";
		return {
			title: {
				verb: changes.length > 1 ? "Patch" : patchTitle(view.args).verb,
				subject: `${displayPath(first.targetPath, view.cwd)}${suffix}`,
				elide: "path",
				accentSubject: true,
			},
			metrics,
		};
	},
	detail(view) {
		const plan = getPatchDetails(view.details);
		if (!plan) return undefined;
		const sections = plan.changes.flatMap((change) =>
			typeof change.displayDiff === "string"
				? [{ title: changeTitle(change), text: change.displayDiff, format: "diff" as const }]
				: [],
		);
		if (sections.length === 0) return undefined;
		return {
			sections,
			hideMetadata: true,
		};
	},
};

export function getProgressiveToolsAPI(): ProgressiveToolsAPI | undefined {
	const api = (globalThis as ProtocolGlobal)[API_KEY];
	return api?.version === 2 ? api : undefined;
}

export function registerProgressiveAdapter(adapter: ProgressiveToolAdapter): void {
	const shared = globalThis as ProtocolGlobal;
	const api = getProgressiveToolsAPI();
	if (api) {
		api.registerAdapter(adapter);
		return;
	}
	let pending = shared[PENDING_KEY];
	if (!pending) {
		pending = [];
		shared[PENDING_KEY] = pending;
	}
	if (!pending.some((candidate) => candidate.id === adapter.id)) pending.push(adapter);
}
