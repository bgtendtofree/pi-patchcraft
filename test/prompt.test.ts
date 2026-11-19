import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	APPLY_PATCH_DESCRIPTION,
	APPLY_PATCH_PARAMETER_DESCRIPTION,
	APPLY_PATCH_PROMPT_GUIDELINES,
	APPLY_PATCH_PROMPT_SNIPPET,
} from "../src/prompt.ts";

describe("apply_patch prompt", () => {
	it("keeps every guideline attributable to apply_patch", () => {
		assert.ok(APPLY_PATCH_PROMPT_GUIDELINES.length <= 5);
		for (const guideline of APPLY_PATCH_PROMPT_GUIDELINES) {
			assert.match(guideline, /\bapply_patch\b/);
			assert.doesNotMatch(guideline, /\bthis tool\b/i);
		}
	});

	it("stays compatible with both grammar and JSON tool paths", () => {
		const text = [
			APPLY_PATCH_DESCRIPTION,
			APPLY_PATCH_PARAMETER_DESCRIPTION,
			APPLY_PATCH_PROMPT_SNIPPET,
			...APPLY_PATCH_PROMPT_GUIDELINES,
		].join("\n");
		assert.doesNotMatch(text, /freeform|wrap (?:the )?patch in JSON/i);
	});

	it("keeps the tool-list snippet on one line", () => {
		assert.ok(APPLY_PATCH_PROMPT_SNIPPET.length > 0);
		assert.doesNotMatch(APPLY_PATCH_PROMPT_SNIPPET, /\n/);
	});
});
