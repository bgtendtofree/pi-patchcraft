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

interface PatchHeader {
	operation: "add" | "delete" | "move" | "update";
	path: string;
	targetPath?: string;
}

function patchHeaders(value: unknown): PatchHeader[] {
	const values = asRecord(value);
	const patch = [values.patch, values.input, values.patchText].find((candidate) => typeof candidate === "string");
	if (typeof patch !== "string") return [];
	const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const headers: PatchHeader[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("*** Add File: ")) {
			headers.push({ operation: "add", path: line.slice("*** Add File: ".length) });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			headers.push({ operation: "delete", path: line.slice("*** Delete File: ".length) });
			continue;
		}
		if (!line.startsWith("*** Update File: ")) continue;
		const path = line.slice("*** Update File: ".length);
		const next = lines[index + 1] ?? "";
		if (next.startsWith("*** Move to: ")) {
			headers.push({ operation: "move", path, targetPath: next.slice("*** Move to: ".length) });
			continue;
		}
		headers.push({ operation: "update", path });
	}
	return headers;
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
		if (header.operation === "add") return { verb: "Add", subject: header.path };
		if (header.operation === "delete") return { verb: "Delete", subject: header.path };
		if (header.operation === "move") {
			return { verb: "Move", subject: `${header.path} → ${header.targetPath ?? "…"}` };
		}
		return { verb: "Update", subject: header.path };
	},
	summarize(view) {
		const details = asRecord(view.details);
		const result = details.result;
		const plan = details.plan;
		const data = isPatchResult(result) ? result : isPatchPlan(plan) ? plan : undefined;
		if (!data) return view.isError ? { status: "failed" } : {};
		const fileCount = "files" in data ? data.files.length : data.changes.length;
		const metrics = [`${fileCount} ${fileCount === 1 ? "file" : "files"}`];
		if (data.added > 0) metrics.push(`+${data.added}`);
		if (data.removed > 0) metrics.push(`-${data.removed}`);
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
