import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchcraftAdapter } from "../src/progressive.ts";

describe("Patchcraft Progressive Tools adapter", () => {
	it("builds semantic titles and metrics", () => {
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch",
			}),
			{ verb: "Patch", subject: "a.ts" },
		);
		assert.deepEqual(
			patchcraftAdapter.summarize?.({
				text: "done",
				isError: false,
				details: {
					result: { files: [{ operation: "update", path: "a.ts", targetPath: "a.ts" }], added: 1, removed: 1, fuzz: 0 },
				},
			}),
			{ metrics: ["1 files", "+1", "-1"] },
		);
	});
});
