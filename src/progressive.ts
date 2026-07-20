import type { Component } from "@earendil-works/pi-tui";
import type { PatchPlan, PatchResult } from "./types.ts";

const API_KEY = Symbol.for("@bgtendtofree/pi-progressive-tools/api/v1");
const PENDING_KEY = Symbol.for("@bgtendtofree/pi-progressive-tools/pending/v1");

interface ProgressiveToolTitle {
	verb: string;
	subject?: string;
	context?: string;
}

interface ProgressiveToolResultView {
	text: string;
	content?: unknown[];
	details?: unknown;
	isError: boolean;
}

export interface ProgressiveToolAdapter {
	version: 1;
	id: string;
	toolNames: string[];
	title(args: unknown): ProgressiveToolTitle;
	summarize?(result: ProgressiveToolResultView): { status?: string; metrics?: string[] };
}

interface ProgressiveToolsAPI {
	version: 1;
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

function patchPaths(value: unknown): string[] {
	const values = asRecord(value);
	const patch = [values.patch, values.input, values.patchText].find((candidate) => typeof candidate === "string");
	if (typeof patch !== "string") return [];
	return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1] ?? "");
}

function isPatchPlan(value: unknown): value is PatchPlan {
	const record = asRecord(value);
	return Array.isArray(record.changes) && typeof record.added === "number" && typeof record.removed === "number";
}

function isPatchResult(value: unknown): value is PatchResult {
	const record = asRecord(value);
	return Array.isArray(record.files) && typeof record.added === "number" && typeof record.removed === "number";
}

export const patchcraftAdapter: ProgressiveToolAdapter = {
	version: 1,
	id: "@bgtendtofree/pi-patchcraft/apply-patch",
	toolNames: ["apply_patch"],
	title(args) {
		const paths = patchPaths(args);
		if (paths.length === 0) return { verb: "Patch", subject: "…" };
		if (paths.length === 1) return { verb: "Patch", subject: paths[0] ?? "…" };
		return { verb: "Patch", subject: `${paths.length} files`, context: paths.slice(0, 2).join(", ") };
	},
	summarize(view) {
		const details = asRecord(view.details);
		const result = details.result;
		const plan = details.plan;
		const data = isPatchResult(result) ? result : isPatchPlan(plan) ? plan : undefined;
		if (!data) return view.isError ? { status: "failed" } : {};
		const metrics = [
			`${"files" in data ? data.files.length : data.changes.length} files`,
			`+${data.added}`,
			`-${data.removed}`,
		];
		if (data.fuzz > 0) metrics.push(`fuzz ${data.fuzz}`);
		return { metrics };
	},
};

export function getProgressiveToolsAPI(): ProgressiveToolsAPI | undefined {
	const api = (globalThis as ProtocolGlobal)[API_KEY];
	return api?.version === 1 ? api : undefined;
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
