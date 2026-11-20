import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { checkCore, coreBinary, planPatch } from "./client.ts";
import { APPLY_PATCH_LARK_GRAMMAR } from "./grammar.ts";
import { scanPatchPreview } from "./preview.ts";
import {
	APPLY_PATCH_DESCRIPTION,
	APPLY_PATCH_PARAMETER_DESCRIPTION,
	APPLY_PATCH_PROMPT_GUIDELINES,
	APPLY_PATCH_PROMPT_SNIPPET,
} from "./prompt.ts";
import { formatPatchCall, formatPatchError, formatPatchProgress, formatPatchResult } from "./render.ts";
import { isPatchcraftModel, reconcileActiveTools } from "./tools.ts";
import { type PatchResultDetails, patchResultSchema } from "./types.ts";

const patchParameters = Type.Object({
	patch: Type.String({
		description: APPLY_PATCH_PARAMETER_DESCRIPTION,
	}),
});

const modeEntryType = "patchcraft-mode";
const baselineEntryType = "patchcraft-baseline-tools";

type PatchcraftMode = "auto" | "off" | "on";

interface PatchcraftModeState {
	mode: PatchcraftMode;
}

export default function piPatchcraft(pi: ExtensionAPI): void {
	let baselineTools: string[] | undefined;
	let mode: PatchcraftMode = "auto";
	let core: { binary: string; cwd: string; check: Promise<string | undefined> } | undefined;
	let warned: string | undefined;
	let generation = 0;
	let syncing: Promise<unknown> = Promise.resolve();

	function wantsPatchcraft(ctx: ExtensionContext): boolean {
		if (mode === "on") return true;
		if (mode === "off") return false;
		return isPatchcraftModel(ctx.model?.id, ctx.model?.api);
	}

	function restoreState(ctx: ExtensionContext, resetWarnings = false): void {
		generation++;
		if (resetWarnings) warned = undefined;
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

	function coreProblem(cwd: string): Promise<string | undefined> {
		const binary = coreBinary();
		if (core?.binary !== binary || core.cwd !== cwd) core = { binary, cwd, check: checkCore(binary, cwd) };
		return core.check;
	}

	function modeStatus(ctx: ExtensionContext, problem: string | undefined): string {
		// Report the loadout Pi actually has, not just the selected mode.
		const enabled = pi.getActiveTools().includes("apply_patch") && !problem;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		return `Patchcraft mode: ${mode}\nEffective: ${enabled ? "enabled" : "disabled"}\nModel: ${model}${problem ? `\n${problem}` : ""}`;
	}

	function syncTools(ctx: ExtensionContext, notify = true): Promise<string | undefined> {
		const currentGeneration = generation;
		const result = syncing.then(() => syncToolsNow(ctx, notify, currentGeneration));
		syncing = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function syncToolsNow(
		ctx: ExtensionContext,
		notify: boolean,
		currentGeneration: number,
	): Promise<string | undefined> {
		if (currentGeneration !== generation) return undefined;
		if (!baselineTools) {
			// Pi restores the already-replaced loadout on resume/reload. Persist before replacing it.
			// Without saved baseline metadata, capture current tools rather than guess edit/write.
			const tools = pi.getActiveTools();
			pi.appendEntry(baselineEntryType, { tools });
			baselineTools = tools;
		}
		const problem = wantsPatchcraft(ctx) ? await coreProblem(ctx.cwd) : undefined;
		if (currentGeneration !== generation) return undefined;
		const current = pi.getActiveTools();
		const next = reconcileActiveTools({
			baseline: baselineTools,
			current,
			usePatchcraft: wantsPatchcraft(ctx) && !problem,
		});
		if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);
		if (problem && notify && problem !== warned) ctx.ui.notify(`Patchcraft disabled. ${problem}`, "warning");
		warned = problem;
		return problem;
	}

	pi.registerCommand("patchcraft", {
		description: "Show or change apply_patch tool mode",
		async handler(args, ctx) {
			const value = args.trim().toLowerCase();
			if (value === "" || value === "status") {
				const problem = wantsPatchcraft(ctx) ? await coreProblem(ctx.cwd) : undefined;
				ctx.ui.notify(`${modeStatus(ctx, problem)}\nUsage: /patchcraft auto|on|off`, problem ? "warning" : "info");
				return;
			}
			if (value !== "auto" && value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /patchcraft auto|on|off", "warning");
				return;
			}
			mode = value;
			pi.appendEntry<PatchcraftModeState>(modeEntryType, { mode });
			if (mode !== "off") core = undefined;
			const problem = await syncTools(ctx, false);
			ctx.ui.notify(modeStatus(ctx, problem), problem ? "warning" : "info");
		},
	});
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
		promptGuidelines: APPLY_PATCH_PROMPT_GUIDELINES,
		parameters: patchParameters,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		// Codemode scripts receive this shape instead of the text content.
		outputSchema: patchResultSchema,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(
				formatPatchCall(scanPatchPreview(typeof args?.patch === "string" ? args.patch : ""), theme, {
					expanded: context.expanded,
					argsComplete: context.argsComplete,
					executionStarted: context.executionStarted,
				}),
			);
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			if (context.isError) {
				component.setText(formatPatchError(result.content, theme) || theme.fg("error", "apply_patch failed"));
				return component;
			}
			if (options.isPartial) {
				component.setText(formatPatchProgress(result.content, theme) || theme.fg("warning", "Applying patch…"));
				return component;
			}
			const details = result.details as PatchResultDetails | undefined;
			component.setText(
				details
					? formatPatchResult(details, theme, { expanded: options.expanded, keyHint: context.keyHint })
					: formatPatchProgress(result.content, theme),
			);
			return component;
		},
		// Capable models write the patch as raw text instead of a JSON-escaped string. Pi falls back
		// to the JSON-schema function tool on providers without grammar constrained sampling.
		constrainedSampling: { type: "grammar", variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR } },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: "Validating patch…" }],
				details: undefined,
			});
			const plan = await planPatch(ctx.cwd, params.patch, signal);
			try {
				onUpdate?.({
					content: [{ type: "text", text: `Applying patch to ${plan.changes.length} file(s)…` }],
					details: undefined,
				});
				await plan.apply(signal);
			} finally {
				await plan.close();
			}
			const { changes, added, removed, fuzz } = plan;
			const details = { changes, added, removed, fuzz };
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
				details,
				structuredContent: details,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx, true);
		await syncTools(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
		await syncTools(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		await syncTools(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncTools(ctx);
	});
}
