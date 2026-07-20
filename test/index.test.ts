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
		} as unknown as ExtensionAPI;

		piPatchcraft(pi);
		assert.equal(tool?.name, "apply_patch");
		handlers.get("session_start")?.({}, { model: { id: "gpt-5", provider: "openai" } });
		assert.deepEqual(activeTools, ["read", "bash", "apply_patch"]);
		activeTools.splice(2, 0, "external_tool");
		handlers.get("model_select")?.({}, { model: { id: "claude-sonnet-4", provider: "anthropic" } });
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
});
