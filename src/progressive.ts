import type { Component } from "@earendil-works/pi-tui";
import type { PatchPlan, PatchResultDetails } from "./types.ts";

const API_KEY = Symbol.for("@bgtendtofree/pi-progressive-tools/api/v1");
const PENDING_KEY = Symbol.for("@bgtendtofree/pi-progressive-tools/pending/v1");

interface ProgressiveToolTitle {
	verb: string;
	subject?: string;
	context?: string;
}

interface ProgressiveToolResultView {
	details?: unknown;
	isError: boolean;
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
	version: 1;
	id: string;
	toolNames: string[];
	title(args: unknown): ProgressiveToolTitle;
	summarize?(result: ProgressiveToolResultView): { status?: string; metrics?: string[] };
	detail?(result: ProgressiveToolResultView): ProgressiveToolDetail | undefined;
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

function isPatchDetails(value: unknown): value is PatchPlan | PatchResultDetails {
	const record = asRecord(value);
	return Array.isArray(record.changes) && typeof record.added === "number" && typeof record.removed === "number";
}

export function getPatchDetails(value: unknown): PatchPlan | PatchResultDetails | undefined {
	const details = asRecord(value);
	if (isPatchDetails(details)) return details;
	return isPatchDetails(details.plan) ? details.plan : undefined;
}

function changeTitle(change: PatchPlan["changes"][number] | PatchResultDetails["changes"][number]): string {
	const operation = change.operation[0]?.toUpperCase() + change.operation.slice(1);
	const target = change.operation === "move" ? `${change.path} → ${change.targetPath}` : change.targetPath;
	return `${operation} ${target} (+${change.added} -${change.removed})`;
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
		const plan = getPatchDetails(view.details);
		if (!plan) return view.isError ? { status: "failed" } : {};
		const fileCount = plan.changes.length;
		const metrics = [`${fileCount} ${fileCount === 1 ? "file" : "files"}`];
		if (plan.added > 0) metrics.push(`+${plan.added}`);
		if (plan.removed > 0) metrics.push(`-${plan.removed}`);
		if (plan.fuzz > 0) metrics.push(`fuzz ${plan.fuzz}`);
		return { metrics };
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
