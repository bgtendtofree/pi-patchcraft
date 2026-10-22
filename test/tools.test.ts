import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPatchcraftModel, reconcileActiveTools } from "../src/tools.ts";

describe("isPatchcraftModel", () => {
	it("matches GPT/Codex-family ids, including provider-prefixed and virtual ids", () => {
		assert.equal(isPatchcraftModel("gpt-5"), true);
		assert.equal(isPatchcraftModel("openai/gpt-5.6-luna"), true);
	});

	it("rejects other models and missing ids", () => {
		assert.equal(isPatchcraftModel("claude-sonnet-4"), false);
		assert.equal(isPatchcraftModel("codex-platform-model"), false);
		assert.equal(isPatchcraftModel(undefined), false);
	});

	it("also enables Codex Responses models without a gpt- prefix", () => {
		assert.equal(isPatchcraftModel("codex-platform-model", "openai-codex-responses"), true);
		assert.equal(isPatchcraftModel("gpt-5", "anthropic-messages"), true);
	});
});

describe("reconcileActiveTools", () => {
	it("replaces edit/write with apply_patch while enabled", () => {
		assert.deepEqual(
			reconcileActiveTools({
				baseline: ["read", "edit", "write", "bash"],
				current: ["read", "edit", "write", "bash"],
				usePatchcraft: true,
			}),
			["read", "bash", "apply_patch"],
		);
	});

	it("restores the baseline editing tools when disabled", () => {
		assert.deepEqual(
			reconcileActiveTools({
				baseline: ["read", "edit", "write", "bash"],
				current: ["read", "bash", "apply_patch"],
				usePatchcraft: false,
			}),
			["read", "edit", "write", "bash"],
		);
	});

	it("never restores edit/write omitted from the baseline", () => {
		assert.deepEqual(
			reconcileActiveTools({
				baseline: ["read", "bash"],
				current: ["read", "bash", "apply_patch"],
				usePatchcraft: false,
			}),
			["read", "bash"],
		);
	});

	it("preserves user- and extension-provided tools not in the baseline", () => {
		assert.deepEqual(
			reconcileActiveTools({
				baseline: ["read", "edit", "bash", "codemode"],
				current: ["read", "edit", "bash", "codemode", "external_tool"],
				usePatchcraft: true,
			}),
			["read", "bash", "codemode", "external_tool", "apply_patch"],
		);
	});
});
