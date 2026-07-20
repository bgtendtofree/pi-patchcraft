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

function normalizeArguments(args: unknown): { patch: string } {
	if (typeof args === "string") return { patch: args };
	if (typeof args !== "object" || args === null) return { patch: "" };
	const values = args as { patch?: unknown; input?: unknown; patchText?: unknown };
	for (const value of [values.patch, values.input, values.patchText]) {
		if (typeof value === "string") return { patch: value };
	}
	return { patch: "" };
}

function wantsPatchcraft(ctx: ExtensionContext): boolean {
	const id = ctx.model?.id.toLowerCase() ?? "";
	return id.includes("codex") || id.startsWith("gpt-");
}

export default function piPatchcraft(pi: ExtensionAPI): void {
	let baselineTools: string[] | undefined;

	function syncTools(ctx: ExtensionContext): void {
		baselineTools ??= pi.getActiveTools();
		const base = baselineTools.filter((name) => name !== "apply_patch");
		if (!wantsPatchcraft(ctx)) {
			pi.setActiveTools(base);
			return;
		}
		pi.setActiveTools([...base.filter((name) => name !== "edit" && name !== "write"), "apply_patch"]);
	}

	registerProgressiveAdapter(patchcraftAdapter);
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description:
			"Use apply_patch to edit files with one Codex-format patch from *** Begin Patch through *** End Patch. Supports Add, Delete, Update, and optional Move to operations using relative workspace paths.",
		promptSnippet: "Edit files with Codex-format apply_patch",
		promptGuidelines: [
			"Use apply_patch for file edits when apply_patch is active; combine related multi-file changes in one patch.",
			"In apply_patch, use relative paths and prefix every added line, including new-file contents, with +.",
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
		syncTools(ctx);
	});
	pi.on("model_select", (_event, ctx) => syncTools(ctx));
	pi.on("before_agent_start", (_event, ctx) => syncTools(ctx));
}
