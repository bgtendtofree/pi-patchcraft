import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, initTheme, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import piPatchcraft from "../src/index.ts";
import type { PatchResultDetails } from "../src/types.ts";

interface RegisteredTool {
	name: string;
	parameters?: unknown;
	outputSchema?: { properties?: Record<string, unknown> };
	constrainedSampling?: { type: string; variants: { openai_lark?: string } };
	annotations?: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
	renderShell?: string;
	renderCall?(args: { patch: string }, theme: Theme, context: { isError: boolean }): Component;
	renderResult?(
		result: { content: Array<{ type: string; text?: string }>; details: PatchResultDetails | undefined },
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: { isError: boolean },
	): Component;
	prepareArguments?(args: unknown): { patch: string };
	execute(
		toolCallId: string,
		params: { patch: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: PatchResultDetails;
		structuredContent?: PatchResultDetails;
	}>;
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
const renderTheme = {
	fg(color: string, text: string) {
		if (color === "error") return `\x1b[31m${text}\x1b[39m`;
		if (color === "warning") return `\x1b[33m${text}\x1b[39m`;
		return text;
	},
	bg(color: string, text: string) {
		assert.equal(color, "toolErrorBg");
		return `\x1b[41m${text}\x1b[49m`;
	},
	bold: (text: string) => text,
} as unknown as Theme;
const renderDetails: PatchResultDetails = {
	changes: [
		{
			operation: "move",
			path: "old.ts",
			targetPath: "new.ts",
			added: 1,
			removed: 1,
			fuzz: 0,
			displayDiff: "-1 old\n+1 new",
		},
	],
	added: 1,
	removed: 1,
	fuzz: 0,
};

function extensionHarness(tools: string[], sessionManager = SessionManager.inMemory()) {
	let tool: RegisteredTool | undefined;
	let command: RegisteredCommand | undefined;
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const context = {
		model: { id: "gpt-5", provider: "openai" },
		sessionManager,
		ui: { notify() {} },
	};
	const harness = {
		tools: [...tools],
		context,
		get tool() {
			assert.ok(tool);
			return tool;
		},
		async mode(value: string) {
			assert.ok(command);
			await command.handler(value, context);
		},
		emit(name: string, reason = "startup") {
			assert.ok(handlers.has(name));
			handlers.get(name)?.({ type: name, reason }, context);
		},
	};
	piPatchcraft({
		registerTool(value: RegisteredTool) {
			tool = value;
		},
		registerCommand(_name: string, value: RegisteredCommand) {
			command = value;
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(name, handler);
		},
		getActiveTools: () => [...harness.tools],
		setActiveTools(names: string[]) {
			// Baseline must exist before the first tool mutation.
			assert.ok(
				context.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "patchcraft-baseline-tools"),
			);
			harness.tools = [...names];
		},
		appendEntry(customType: string, data: unknown) {
			context.sessionManager.appendCustomEntry(customType, data);
		},
	} as unknown as ExtensionAPI);
	return harness;
}

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
			appendEntry() {},
		} as unknown as ExtensionAPI;

		piPatchcraft(pi);
		assert.equal(tool?.name, "apply_patch");
		assert.deepEqual(tool?.annotations, {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
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
		// Codemode scripts receive structuredContent, so it has to mirror the details shape and the
		// declared outputSchema exactly.
		assert.deepEqual(result?.structuredContent, details);
		assert.deepEqual(Object.keys(result?.structuredContent ?? {}).sort(), ["added", "changes", "fuzz", "removed"]);
		assert.deepEqual(Object.keys(tool?.outputSchema?.properties ?? {}).sort(), ["added", "changes", "fuzz", "removed"]);
		assert.equal(await readFile(path.join(cwd, "value.txt"), "utf8"), "after\n");
		assert.ok(tool);
		await assert.rejects(tool.execute("empty", { patch: "" }, undefined, undefined, { cwd }), /patch is required/);
		await assert.rejects(tool.execute("invalid", { patch: "invalid" }, undefined, undefined, { cwd }));
		assert.equal(await readFile(path.join(cwd, "value.txt"), "utf8"), "after\n");
	});

	it("supports session-scoped automatic, forced-on, and forced-off modes", async () => {
		let command: RegisteredCommand | undefined;
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
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
			appendEntry(customType: string, data: unknown) {
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

	it("persists baseline before replacement and restores it across reload and disk resume", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-patchcraft-session-"));
		temporaryDirectories.push(cwd);
		const session = SessionManager.create(cwd, cwd);
		const original = extensionHarness(["read", "edit", "write", "bash", "external"], session);
		original.emit("session_start");
		assert.deepEqual(original.tools, ["read", "bash", "external", "apply_patch"]);
		session.appendMessage({ role: "user", content: "test", timestamp: Date.now() });

		const reloaded = extensionHarness(original.tools, session);
		reloaded.emit("session_start", "reload");
		assert.deepEqual(reloaded.tools, original.tools);
		assert.equal(session.getBranch().filter((entry) => entry.type === "custom").length, 1);
		await reloaded.mode("on");

		const sessionFile = session.getSessionFile();
		assert.ok(sessionFile);
		const resumed = extensionHarness(["bash", "apply_patch", "new_external"], SessionManager.open(sessionFile, cwd));
		resumed.context.model = { id: "claude-sonnet-4", provider: "anthropic" };
		resumed.emit("session_start", "resume");
		assert.deepEqual(resumed.tools, ["bash", "new_external", "apply_patch"]);
		await resumed.mode("off");
		assert.deepEqual(resumed.tools, ["edit", "write", "bash", "new_external"]);
		assert.equal(
			resumed.context.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "patchcraft-baseline-tools").length,
			1,
		);
	});

	it("never enables edit/write omitted from the baseline", async () => {
		for (const editingTools of [[], ["edit"], ["write"]]) {
			const baseline = ["read", ...editingTools, "bash"];
			const initial = extensionHarness(baseline);
			initial.emit("session_start");
			const resumed = extensionHarness(initial.tools, initial.context.sessionManager);
			resumed.emit("session_start", "resume");
			resumed.context.model = { id: "claude-sonnet-4", provider: "anthropic" };
			resumed.emit("model_select");
			assert.deepEqual(resumed.tools, baseline);
			await resumed.mode("on");
			await resumed.mode("off");
			assert.deepEqual(resumed.tools, baseline);
		}
	});

	it("resets mode and baseline for a new session", async () => {
		const harness = extensionHarness(["read", "edit", "bash"]);
		harness.emit("session_start");
		await harness.mode("on");
		harness.context.sessionManager = SessionManager.inMemory();
		harness.context.model = { id: "claude-sonnet-4", provider: "anthropic" };
		harness.tools = ["read", "write", "bash", "other"];
		harness.emit("session_start", "new");
		assert.deepEqual(harness.tools, ["read", "write", "bash", "other"]);
		await harness.mode("on");
		await harness.mode("off");
		assert.deepEqual(harness.tools, ["read", "write", "bash", "other"]);
	});

	it("restores only active-branch baseline and mode through tree navigation and fork", async () => {
		const session = SessionManager.inMemory();
		const root = session.appendCustomEntry("test-root", {});
		const first = extensionHarness(["read", "edit", "bash"], session);
		first.emit("session_start");
		await first.mode("on");
		const firstLeaf = session.getLeafId();
		assert.ok(firstLeaf);

		session.branch(root);
		const sibling = extensionHarness(["read", "write", "bash"], session);
		sibling.context.model = { id: "claude-sonnet-4", provider: "anthropic" };
		sibling.emit("session_start");
		await sibling.mode("off");
		const siblingLeaf = session.getLeafId();
		assert.ok(siblingLeaf);

		// Pi restores this branch's transcript loadout before emitting session_tree.
		first.tools = ["read", "write", "bash", "external"];
		first.emit("session_tree");
		assert.deepEqual(first.tools, ["read", "write", "bash", "external"]);
		await first.mode("on");
		await first.mode("off");
		assert.deepEqual(first.tools, ["read", "write", "bash", "external"]);

		session.branch(firstLeaf);
		first.tools = ["read", "bash", "apply_patch", "external"];
		first.emit("session_tree");
		assert.deepEqual(first.tools, ["read", "bash", "external", "apply_patch"]);
		session.createBranchedSession(firstLeaf);
		const forked = extensionHarness(first.tools, session);
		forked.context.model = { id: "claude-sonnet-4", provider: "anthropic" };
		forked.emit("session_start", "fork");
		assert.deepEqual(forked.tools, first.tools);
		await forked.mode("off");
		assert.deepEqual(forked.tools, ["read", "edit", "bash", "external"]);
	});

	it("captures current tools conservatively when branch baseline metadata is missing or invalid", async () => {
		const session = SessionManager.inMemory();
		for (const data of [undefined, null, { tools: "edit" }, { tools: ["edit", 1] }]) {
			session.appendCustomEntry("patchcraft-baseline-tools", data);
		}
		session.appendCustomEntry("patchcraft-mode", { mode: "on" });
		const legacy = extensionHarness(["read", "bash", "apply_patch", "external"], session);
		legacy.emit("session_start", "resume");
		await legacy.mode("off");
		assert.deepEqual(legacy.tools, ["read", "bash", "external"]);

		// Navigating before metadata must not reuse the previous branch's in-memory baseline.
		session.resetLeaf();
		legacy.tools = ["read", "write", "bash"];
		legacy.emit("session_tree");
		await legacy.mode("off");
		assert.deepEqual(legacy.tools, ["read", "write", "bash"]);
	});

	it("uses the selected virtual model id, with an explicit on override", async () => {
		const harness = extensionHarness(["read", "edit", "write", "bash"]);
		harness.context.model = { id: "auto", provider: "openai-codex" };
		harness.emit("session_start");
		assert.deepEqual(harness.tools, ["read", "edit", "write", "bash"]);
		await harness.mode("on");
		assert.deepEqual(harness.tools, ["read", "bash", "apply_patch"]);
	});

	it("renders standalone success titles and expanded diffs without Progressive Tools", () => {
		initTheme("dark", false);
		const { tool } = extensionHarness([]);
		assert.equal(tool.renderShell, "self");
		assert.ok(tool.renderCall);
		assert.ok(tool.renderResult);
		const title = tool.renderCall(
			{ patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch" },
			renderTheme,
			{ isError: false },
		);
		assert.equal(stripVTControlCharacters(title.render(80).join("\n")).trim(), "Move old.ts → new.ts");
		const result = { content: [{ type: "text", text: "Patch applied." }], details: renderDetails };
		assert.deepEqual(
			tool.renderResult(result, { expanded: false, isPartial: false }, renderTheme, { isError: false }).render(80),
			[],
		);
		const expanded = stripVTControlCharacters(
			tool
				.renderResult(result, { expanded: true, isPartial: false }, renderTheme, { isError: false })
				.render(80)
				.join("\n"),
		);
		assert.match(expanded, /Move old\.ts → new\.ts \(\+1 -1\)/);
		assert.match(expanded, /old/);
		assert.match(expanded, /new/);
	});

	it("renders complete standalone errors collapsed and expanded, even without details", () => {
		const { tool } = extensionHarness([]);
		assert.ok(tool.renderResult);
		for (const expanded of [false, true]) {
			for (const details of [undefined, renderDetails]) {
				const result = {
					content: [
						{ type: "text", text: "Cannot apply patch" },
						{ type: "image" },
						{ type: "text", text: "Rollback failed: denied" },
					],
					details,
				};
				const output = tool
					.renderResult(result, { expanded, isPartial: false }, renderTheme, { isError: true })
					.render(80)
					.join("\n");
				assert.ok(output.includes("\x1b[31m"));
				assert.ok(output.includes("\x1b[41m"));
				const plain = stripVTControlCharacters(output);
				assert.match(plain, /Cannot apply patch/);
				assert.match(plain, /Rollback failed: denied/);
				assert.doesNotMatch(plain, /move old\.ts/);
			}
		}
		const fallback = tool.renderResult(
			{ content: [], details: undefined },
			{ expanded: true, isPartial: false },
			renderTheme,
			{ isError: true },
		);
		assert.equal(stripVTControlCharacters(fallback.render(80).join("\n")).trim(), "Patch failed.");
	});

	it("renders standalone partial updates and default progress text", () => {
		const { tool } = extensionHarness([]);
		assert.ok(tool.renderResult);
		for (const expanded of [false, true]) {
			for (const text of ["Validating patch…", "Applying patch to 1 file(s)…", undefined]) {
				const content = text ? [{ type: "text", text }] : [];
				const output = tool
					.renderResult({ content, details: undefined }, { expanded, isPartial: true }, renderTheme, { isError: false })
					.render(80)
					.join("\n");
				assert.ok(output.includes("\x1b[33m"));
				assert.equal(stripVTControlCharacters(output).trim(), text ?? "Applying patch…");
			}
		}
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
