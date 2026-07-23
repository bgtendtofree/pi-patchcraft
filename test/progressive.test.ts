import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchcraftAdapter } from "../src/progressive.ts";

describe("Patchcraft Progressive Tools adapter", () => {
	it("builds semantic titles and metrics", () => {
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch",
			}),
			{ verb: "Update", subject: "a.ts" },
		);
		assert.deepEqual(
			patchcraftAdapter.summarize?.({
				isError: false,
				details: {
					plan: { changes: [{}], added: 1, removed: 1, fuzz: 0 },
				},
			}),
			{ metrics: ["1 file", "+1", "-1"] },
		);
	});

	it("distinguishes add, delete, move, and multi-file patches", () => {
		assert.deepEqual(patchcraftAdapter.title({ patch: "*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch" }), {
			verb: "Add",
			subject: "new.ts",
		});
		assert.deepEqual(patchcraftAdapter.title({ patch: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch" }), {
			verb: "Delete",
			subject: "old.ts",
		});
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** End Patch",
			}),
			{ verb: "Move", subject: "old.ts → new.ts" },
		);
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Add File: a.ts\n+a\n*** Delete File: b.ts\n*** End Patch",
			}),
			{ verb: "Patch", subject: "2 files", context: "a.ts, b.ts" },
		);
	});

	it("omits zero-valued change metrics", () => {
		assert.deepEqual(
			patchcraftAdapter.summarize?.({
				isError: false,
				details: {
					plan: { changes: [{}], added: 2, removed: 0, fuzz: 0 },
				},
			}),
			{ metrics: ["1 file", "+2"] },
		);
	});
});
