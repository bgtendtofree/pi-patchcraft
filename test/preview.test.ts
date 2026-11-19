import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanPatchPreview } from "../src/preview.ts";

describe("scanPatchPreview", () => {
	it("scans a partial patch without throwing", () => {
		const preview = scanPatchPreview(`*** Begin Patch
*** Add File: a.txt
+one
+two
*** Update File: b.txt
*** Move to: c.txt
@@
-old
+new
*** Update File: b.txt
+again`);
		assert.deepEqual(preview.files, [
			{
				operation: "add",
				path: "a.txt",
				added: 2,
				removed: 0,
				lines: [
					{ type: "add", text: "one" },
					{ type: "add", text: "two" },
				],
			},
			{
				operation: "move",
				path: "b.txt",
				targetPath: "c.txt",
				added: 2,
				removed: 1,
				lines: [
					{ type: "delete", text: "old" },
					{ type: "add", text: "new" },
					{ type: "add", text: "again" },
				],
			},
		]);
		assert.equal(preview.added, 4);
		assert.equal(preview.removed, 1);
		assert.equal(preview.truncated, false);
	});

	it("ignores text outside the envelope and malformed lines", () => {
		assert.deepEqual(scanPatchPreview("not a patch"), {
			files: [],
			added: 0,
			removed: 0,
			truncated: false,
			warnings: [],
		});
		const preview = scanPatchPreview(`*** Begin Patch
garbage
*** Delete File: gone.txt
-ignored
*** End Patch
*** Add File: after.txt
+ignored`);
		assert.deepEqual(preview.files, [{ operation: "delete", path: "gone.txt", added: 0, removed: 0, lines: [] }]);
	});

	it("caps the roster and marks the preview truncated", () => {
		const lines = ["*** Begin Patch"];
		for (let index = 0; index < 501; index++) lines.push(`*** Add File: f${index}.txt`, "+x");
		const preview = scanPatchPreview(lines.join("\n"));
		assert.equal(preview.files.length, 500);
		assert.equal(preview.truncated, true);
	});

	it("caps the scanned bytes", () => {
		const preview = scanPatchPreview(`*** Begin Patch\n*** Add File: a.txt\n+${"x".repeat(300 * 1024)}`);
		assert.equal(preview.files.length, 1);
		assert.equal(preview.truncated, true);
	});

	it("matches padded top-level headers and keeps indented update markers as context", () => {
		const padded = scanPatchPreview("*** Begin Patch\n  *** Add File: padded.txt  \n+first\n*** End Patch");
		assert.equal(padded.files[0]?.path, "padded.txt");
		assert.equal(padded.files[0]?.added, 1);

		const topUpdate = scanPatchPreview("*** Begin Patch\n  *** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch");
		assert.equal(topUpdate.files[0]?.operation, "update");
		assert.equal(topUpdate.files[0]?.path, "foo.txt");

		const nested = scanPatchPreview(`*** Begin Patch
*** Update File: a.txt
@@
-old a
+new a
 *** Update File: b.txt
@@
-old b
+new b
*** End Patch`);
		assert.equal(nested.files.length, 1);
		assert.equal(nested.files[0]?.path, "a.txt");
		assert.deepEqual(nested.files[0]?.lines, [
			{ type: "delete", text: "old a" },
			{ type: "add", text: "new a" },
			{ type: "context", text: "*** Update File: b.txt" },
			{ type: "delete", text: "old b" },
			{ type: "add", text: "new b" },
		]);
	});

	it("warns about duplicate paths and hunks the core rejects", () => {
		const duplicate = scanPatchPreview(`*** Begin Patch
*** Update File: a.txt
@@
-a
+b
*** Update File: a.txt
@@
-c
+d
*** End Patch`);
		assert.equal(duplicate.files.length, 1);
		assert.deepEqual(
			duplicate.warnings.map((warning) => warning.code),
			["duplicate-path"],
		);
		assert.match(duplicate.warnings[0]?.message ?? "", /combine hunks/);

		const moveOnly = scanPatchPreview("*** Begin Patch\n*** Update File: old.rs\n*** Move to: new.rs\n*** End Patch");
		assert.deepEqual(
			moveOnly.warnings.map((warning) => warning.code),
			["move-only"],
		);

		const empty = scanPatchPreview("*** Begin Patch\n*** Update File: empty.txt\n*** End Patch");
		assert.deepEqual(
			empty.warnings.map((warning) => warning.code),
			["empty-update"],
		);

		const noOp = scanPatchPreview("*** Begin Patch\n*** Update File: same.txt\n@@\n context\n*** End Patch");
		assert.deepEqual(
			noOp.warnings.map((warning) => warning.code),
			["no-op-update"],
		);

		const contextMove = scanPatchPreview(
			"*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n context\n*** End Patch",
		);
		assert.deepEqual(contextMove.warnings, []);
	});
});
