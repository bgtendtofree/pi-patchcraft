import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatchPlan, planPatch } from "./apply.ts";
import { getProgressiveToolsAPI, patchcraftAdapter, registerProgressiveAdapter } from "./progressive.ts";
import { renderPatchCall, renderPatchResult } from "./render.ts";
import type { ApplyPatchDetails } from "./types.ts";

const patchParameters = Type.Object({
	patch: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
});

const managedTools = new Set(["apply_patch", "edit", "write"]);
const modeEntryType = "patchcraft-mode";

type PatchcraftMode = "auto" | "off" | "on";

interface PatchcraftModeState {
	mode: PatchcraftMode;
}

function normalizeArguments(args: unknown): { patch: string } {
	if (typeof args === "string") return { patch: args };
	if (typeof args !== "object" || args === null) return { patch: "" };
	const values = args as { patch?: unknown; input?: unknown; patchText?: unknown };
	for (const value of [values.patch, values.input, values.patchText]) {
		if (typeof value === "string") return { patch: value };
	}
	return { patch: "" };
}

function autoWantsPatchcraft(ctx: ExtensionContext): boolean {
	const id = ctx.model?.id.toLowerCase() ?? "";
	return id.startsWith("gpt-");
}

export default function piPatchcraft(pi: ExtensionAPI): void {
	let baselineTools: string[] | undefined;
	let mode: PatchcraftMode = "auto";

	function wantsPatchcraft(ctx: ExtensionContext): boolean {
		if (mode === "on") return true;
		if (mode === "off") return false;
		return autoWantsPatchcraft(ctx);
	}

	function restoreMode(ctx: ExtensionContext): void {
		mode = "auto";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== modeEntryType) continue;
			const saved = entry.data as PatchcraftModeState | undefined;
			if (saved?.mode === "auto" || saved?.mode === "on" || saved?.mode === "off") mode = saved.mode;
		}
	}

	function modeStatus(ctx: ExtensionContext): string {
		const enabled = wantsPatchcraft(ctx);
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		return `Patchcraft mode: ${mode}\nEffective: ${enabled ? "enabled" : "disabled"}\nModel: ${model}`;
	}

	function syncTools(ctx: ExtensionContext): void {
		baselineTools ??= pi.getActiveTools();
		const current = pi.getActiveTools();
		const usePatchcraft = wantsPatchcraft(ctx);
		const desiredManaged = new Set<string>();
		if (usePatchcraft) desiredManaged.add("apply_patch");
		else {
			if (baselineTools.includes("edit")) desiredManaged.add("edit");
			if (baselineTools.includes("write")) desiredManaged.add("write");
		}

		const currentUnmanaged = current.filter((name) => !managedTools.has(name));
		const currentUnmanagedSet = new Set(currentUnmanaged);
		const next = baselineTools.filter(
			(name) =>
				(managedTools.has(name) && desiredManaged.has(name)) ||
				(!managedTools.has(name) && currentUnmanagedSet.has(name)),
		);
		for (const name of currentUnmanaged) {
			if (!next.includes(name)) next.push(name);
		}
		if (usePatchcraft && !next.includes("apply_patch")) next.push("apply_patch");
		pi.setActiveTools(next);
	}

	registerProgressiveAdapter(patchcraftAdapter);
	pi.registerCommand("patchcraft", {
		description: "Show or change apply_patch tool mode",
		async handler(args, ctx) {
			const value = args.trim().toLowerCase();
			if (value === "" || value === "status") {
				ctx.ui.notify(`${modeStatus(ctx)}\nUsage: /patchcraft auto|on|off`, "info");
				return;
			}
			if (value !== "auto" && value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /patchcraft auto|on|off", "warning");
				return;
			}
			mode = value;
			pi.appendEntry<PatchcraftModeState>(modeEntryType, { mode });
			syncTools(ctx);
			ctx.ui.notify(modeStatus(ctx), "info");
		},
	});
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description: "Apply a Codex-format patch to add, update, move, or delete files inside the workspace.",
		promptSnippet: "Add, update, move, or delete files with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits when available, combining related multi-file changes in one patch.",
		],
		parameters: patchParameters,
		prepareArguments: normalizeArguments,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.patch) throw new Error("patch is required");
			onUpdate?.({
				content: [{ type: "text", text: "Validating patch…" }],
				details: { stage: "validating" } satisfies ApplyPatchDetails,
			});
			const plan = await planPatch(ctx.cwd, params.patch, signal);
			onUpdate?.({
				content: [{ type: "text", text: `Applying patch to ${plan.changes.length} file(s)…` }],
				details: { stage: "applying", plan } satisfies ApplyPatchDetails,
			});
			const result = await applyPatchPlan(plan, signal);
			return {
				content: [
					{
						type: "text",
						text: [
							`Patch applied to ${result.files.length} file(s).`,
							...result.files.map((file) =>
								file.operation === "move"
									? `move: ${file.path} -> ${file.targetPath}`
									: `${file.operation}: ${file.targetPath}`,
							),
						].join("\n"),
					},
				],
				details: { stage: "done", plan, result } satisfies ApplyPatchDetails,
			};
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const api = getProgressiveToolsAPI();
			return api ? api.renderCall(patchcraftAdapter, args, theme, context) : renderPatchCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			const api = getProgressiveToolsAPI();
			return api
				? api.renderResult(patchcraftAdapter, result, options, theme, context)
				: renderPatchResult(
						{ content: result.content, details: result.details as ApplyPatchDetails | undefined },
						options,
						theme,
						context,
					);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		baselineTools = pi.getActiveTools();
		restoreMode(ctx);
		syncTools(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreMode(ctx);
		syncTools(ctx);
	});
	pi.on("model_select", (_event, ctx) => syncTools(ctx));
	pi.on("before_agent_start", (_event, ctx) => syncTools(ctx));
}
