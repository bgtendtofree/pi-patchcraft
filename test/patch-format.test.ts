import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPLY_PATCH_LARK_GRAMMAR } from "../src/grammar.ts";
import { normalizeMarkerLine, PATCH_MARKERS, parseFileHeader, parseMoveTarget } from "../src/patch-format.ts";

describe("patch-format", () => {
	it("keeps marker spellings aligned with the pinned Codex grammar", () => {
		for (const marker of Object.values(PATCH_MARKERS)) {
			assert.ok(APPLY_PATCH_LARK_GRAMMAR.includes(marker), `grammar is missing ${JSON.stringify(marker)}`);
		}
	});

	it("parses padded file headers and move targets", () => {
		assert.deepEqual(parseFileHeader("*** Add File: padded.txt  "), { operation: "add", path: "padded.txt" });
		assert.deepEqual(parseFileHeader("*** Update File: nested.txt"), { operation: "update", path: "nested.txt" });
		assert.equal(parseFileHeader("  *** Update File: nested.txt"), undefined);
		assert.equal(parseFileHeader("*** Add File:   "), undefined);
		assert.equal(parseMoveTarget("*** Move to: next.txt  "), "next.txt");
		assert.equal(parseMoveTarget(" *** Move to: nested.txt"), undefined);
	});

	it("normalizes markers by the open hunk mode", () => {
		assert.equal(normalizeMarkerLine("  *** Add File: padded.txt  ", "add"), "*** Add File: padded.txt");
		assert.equal(normalizeMarkerLine("  *** Update File: nested.txt  ", "update"), "  *** Update File: nested.txt");
		assert.equal(normalizeMarkerLine("  *** Update File: nested.txt  ", undefined), "*** Update File: nested.txt");
	});
});
