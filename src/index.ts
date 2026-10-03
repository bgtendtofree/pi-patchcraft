import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatchPlan, planPatch } from "./apply.ts";
import { APPLY_PATCH_LARK_GRAMMAR } from "./grammar.ts";
import { renderPatchCall, renderPatchResult } from "./render.ts";
import { type PatchPlan, type PatchResultDetails, patchResultSchema } from "./types.ts";

const patchParameters = Type.Object({
	patch: Type.String({
		description: "The entire contents of the apply_patch command",
	}),
});

const managedTools = new Set(["apply_patch", "edit", "write"]);
const modeEntryType = "patchcraft-mode";
const baselineEntryType = "patchcraft-baseline-tools";

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

function resultDetails(plan: PatchPlan): PatchResultDetails {
	return {
		changes: plan.changes.map(({ operation, path, targetPath, displayDiff, added, removed, fuzz }) => ({
			operation,
			path,
			targetPath,
			displayDiff,
			added,
			removed,
			fuzz,
		})),
		added: plan.added,
		removed: plan.removed,
		fuzz: plan.fuzz,
	};
}

export default function piPatchcraft(pi: ExtensionAPI): void {
	let baselineTools: string[] | undefined;
	let mode: PatchcraftMode = "auto";

	function wantsPatchcraft(ctx: ExtensionContext): boolean {
		if (mode === "on") return true;
		if (mode === "off") return false;
		const id = ctx.model?.id.toLowerCase() ?? "";
		return id.split("/").pop()?.startsWith("gpt-") ?? false;
	}

	function restoreState(ctx: ExtensionContext): void {
		mode = "auto";
		baselineTools = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === modeEntryType) {
				const saved = entry.data as PatchcraftModeState | undefined;
				if (saved?.mode === "auto" || saved?.mode === "on" || saved?.mode === "off") mode = saved.mode;
			}
			if (entry.customType === baselineEntryType) {
				const saved = entry.data as { tools?: unknown } | undefined;
				if (Array.isArray(saved?.tools) && saved.tools.every((name): name is string => typeof name === "string")) {
					baselineTools = [...new Set(saved.tools)];
				}
			}
		}
	}

	function modeStatus(ctx: ExtensionContext): string {
		const enabled = wantsPatchcraft(ctx);
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		return `Patchcraft mode: ${mode}\nEffective: ${enabled ? "enabled" : "disabled"}\nModel: ${model}`;
	}

	function syncTools(ctx: ExtensionContext): void {
		if (!baselineTools) {
			// Pi restores the already-replaced loadout on resume/reload. Persist before replacing it.
			// ponytail: legacy sessions have no provenance; keep current tools rather than guess edit/write.
			const tools = pi.getActiveTools();
			pi.appendEntry(baselineEntryType, { tools });
			baselineTools = tools;
		}
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
		if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);
	}

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
		description: "Apply a Codex-format patch to add, update, move, or delete files.",
		promptSnippet: "Add, update, move, or delete files with apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits when available, combining related multi-file changes in one patch.",
		],
		parameters: patchParameters,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		// Codemode scripts receive this shape instead of the text content.
		outputSchema: patchResultSchema,
		prepareArguments: normalizeArguments,
		executionMode: "sequential",
		// Capable models write the patch as raw text instead of a JSON-escaped string. Pi falls back
		// to the JSON-schema function tool on providers without grammar constrained sampling.
		constrainedSampling: { type: "grammar", variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR } },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.patch) throw new Error("patch is required");
			onUpdate?.({
				content: [{ type: "text", text: "Validating patch…" }],
				details: undefined,
			});
			const plan = await planPatch(ctx.cwd, params.patch, signal);
			onUpdate?.({
				content: [{ type: "text", text: `Applying patch to ${plan.changes.length} file(s)…` }],
				details: undefined,
			});
			await applyPatchPlan(plan, signal);
			return {
				content: [
					{
						type: "text",
						text: [
							`Patch applied to ${plan.changes.length} file(s).`,
							...plan.changes.map((change) =>
								change.operation === "move"
									? `move: ${change.path} -> ${change.targetPath}`
									: `${change.operation}: ${change.targetPath}`,
							),
						].join("\n"),
					},
				],
				details: resultDetails(plan),
				structuredContent: resultDetails(plan),
			};
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderPatchCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderPatchResult(
				{ content: result.content, details: result.details as PatchResultDetails | undefined },
				options,
				theme,
				context,
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
		syncTools(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
		syncTools(ctx);
	});
	pi.on("model_select", (_event, ctx) => syncTools(ctx));
	pi.on("before_agent_start", (_event, ctx) => syncTools(ctx));
}
