import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piPatchcraft from "../src/index.ts";

interface RegisteredTool {
	name: string;
	prepareArguments?(args: unknown): { patch: string };
	execute(
		toolCallId: string,
		params: { patch: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: string; text: string }> }>;
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
		activeTools.splice(2, 0, "external_tool");
		handlers.get("model_select")?.({}, { model: { id: "claude-sonnet-4", provider: "anthropic" } });
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash", "external_tool"]);
		handlers.get("model_select")?.({}, { model: { id: "codex-platform-model", provider: "custom" } });
		assert.deepEqual(activeTools, ["read", "edit", "write", "bash", "external_tool"]);

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
});
