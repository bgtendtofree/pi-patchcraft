import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPatchcraft from "../src/index.ts";
import type { PatchResultDetails } from "../src/types.ts";

interface RegisteredTool {
	name: string;
	parameters?: unknown;
	constrainedSampling?: { type: string; variants: { openai_lark?: string } };
	prepareArguments?(args: unknown): { patch: string };
	execute(
		toolCallId: string,
		params: { patch: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: string; text: string }>; details: PatchResultDetails }>;
}

interface RegisteredCommand {
	handler(
		args: string,
		ctx: {
			model?: { id: string; provider: string };
			sessionManager: { getBranch(): unknown[] };
			ui: { notify(message: string, level: string): void };
		},
	): Promise<void>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pi-patchcraft extension", () => {
	it("registers and executes apply_patch", async () => {
		let tool: RegisteredTool | undefined;
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		let activeTools = ["read", "edit", "write", "bash"];
		let toolSwitches = 0;
		const pi = {
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on(name: string, handler: (event: unknown, ctx: unknown) => void) {
				handlers.set(name, handler);
			},
			getActiveTools() {
				return [...activeTools];
			},
			setActiveTools(names: string[]) {
				toolSwitches++;
				activeTools = [...names];
			},
			registerCommand() {},
		} as unknown as ExtensionAPI;

		piPatchcraft(pi);
		assert.equal(tool?.name, "apply_patch");
		handlers.get("session_start")?.(
			{},
			{
				model: { id: "gpt-5", provider: "openai" },
				sessionManager: { getBranch: () => [] },
			},
		);
		assert.deepEqual(activeTools, ["read", "bash", "apply_patch"]);
		assert.equal(toolSwitches, 1);
		handlers.get("model_select")?.({}, { model: { id: "openai/gpt-5.6-luna", provider: "openrouter" } });
		handlers.get("before_agent_start")?.({}, { model: { id: "gpt-5", provider: "openai" } });
		assert.deepEqual(activeTools, ["read", "bash", "apply_patch"]);
		assert.equal(toolSwitches, 1);
		activeTools.splice(2, 0, "external_tool");
		handlers.get("model_select")?.({}, { model: { id: "claude-sonnet-4", provider: "anthropic" } });
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash", "external_tool"]);
		assert.equal(toolSwitches, 2);
		handlers.get("model_select")?.({}, { model: { id: "codex-platform-model", provider: "custom" } });
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash", "external_tool"]);
		assert.equal(toolSwitches, 2);

		assert.deepEqual(tool?.prepareArguments?.({ input: "patch" }), { patch: "patch" });
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-patchcraft-tool-"));
		temporaryDirectories.push(cwd);
		await writeFile(path.join(cwd, "value.txt"), "before\n");
		const result = await tool?.execute(
			"call-1",
			{
				patch: "*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
			},
			undefined,
			undefined,
			{ cwd },
		);
		assert.match(result?.content[0]?.text ?? "", /Patch applied to 1 file/);
		const details = result?.details;
		assert.ok(details && "changes" in details);
		assert.deepEqual(Object.keys(details).sort(), ["added", "changes", "fuzz", "removed"]);
		const change = details.changes[0];
		assert.deepEqual(Object.keys(change ?? {}).sort(), [
			"added",
			"displayDiff",
			"fuzz",
			"operation",
			"path",
			"removed",
			"targetPath",
		]);
		assert.equal("before" in (change ?? {}), false);
		assert.equal("after" in (change ?? {}), false);
		assert.equal(await readFile(path.join(cwd, "value.txt"), "utf8"), "after\n");
	});

	it("supports session-scoped automatic, forced-on, and forced-off modes", async () => {
		let command: RegisteredCommand | undefined;
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const entries: Array<{ type: "custom"; customType: string; data: { mode: string } }> = [];
		const notifications: string[] = [];
		let activeTools = ["read", "edit", "write", "bash"];
		const pi = {
			registerTool() {},
			registerCommand(_name: string, value: RegisteredCommand) {
				command = value;
			},
			on(name: string, handler: (event: unknown, ctx: unknown) => void) {
				handlers.set(name, handler);
			},
			getActiveTools() {
				return [...activeTools];
			},
			setActiveTools(names: string[]) {
				activeTools = [...names];
			},
			appendEntry(customType: string, data: { mode: string }) {
				entries.push({ type: "custom", customType, data });
			},
		} as unknown as ExtensionAPI;
		const context = {
			model: { id: "claude-sonnet-4", provider: "anthropic" },
			sessionManager: { getBranch: () => entries },
			ui: { notify: (message: string) => notifications.push(message) },
		};

		piPatchcraft(pi);
		handlers.get("session_start")?.({}, context);
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash"]);

		await command?.handler("on", context);
		assert.deepEqual(activeTools, ["read", "bash", "apply_patch"]);
		assert.deepEqual(entries.at(-1)?.data, { mode: "on" });

		context.model = { id: "gpt-5", provider: "openai" };
		await command?.handler("off", context);
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash"]);

		await command?.handler("auto", context);
		assert.deepEqual(activeTools, ["read", "bash", "apply_patch"]);
		await command?.handler("status", context);
		assert.match(notifications.at(-1) ?? "", /Patchcraft mode: auto/);

		entries.push({ type: "custom", customType: "patchcraft-mode", data: { mode: "off" } });
		handlers.get("session_tree")?.({}, context);
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash"]);
	});

	it("declares grammar constrained sampling for capable models", () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on() {},
			getActiveTools: () => [],
			setActiveTools() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;

		piPatchcraft(pi);

		// Pi requires exactly one required string property for grammar tools and rejects every
		// request on capable models otherwise, instead of falling back.
		const schema = tool?.parameters as {
			type?: string;
			required?: string[];
			properties?: Record<string, { type?: string }>;
		};
		assert.equal(schema?.type, "object");
		assert.deepEqual(schema?.required, ["patch"]);
		assert.equal(schema?.properties?.patch?.type, "string");

		const { variants } = tool?.constrainedSampling ?? { type: "", variants: {} };
		assert.equal(tool?.constrainedSampling?.type, "grammar");
		const grammarText = variants.openai_lark ?? "";
		assert.ok(grammarText.length > 0);
		// The grammar has to stay the patch language parser.ts accepts.
		for (const marker of [
			"*** Begin Patch",
			"*** End Patch",
			"*** Add File: ",
			"*** Delete File: ",
			"*** Update File: ",
			"*** Move to: ",
			"*** End of File",
			"@@",
		]) {
			assert.ok(grammarText.includes(marker), `grammar is missing ${marker}`);
		}
		// Additions have to allow empty lines; openai/codex#2651 fixed a /\(.+\)/ here.
		assert.ok(grammarText.includes('add_line: "+" /(.*)/ LF -> line'));
	});
});
