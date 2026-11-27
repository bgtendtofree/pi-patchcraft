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
			},
			{
				operation: "move",
				path: "b.txt",
				targetPath: "c.txt",
			},
		]);
		assert.equal(preview.truncated, false);
	});

	it("ignores text outside the envelope and malformed lines", () => {
		assert.deepEqual(scanPatchPreview("not a patch"), {
			files: [],
			truncated: false,
		});
		const preview = scanPatchPreview(`*** Begin Patch
garbage
*** Delete File: gone.txt
-ignored
*** End Patch
*** Add File: after.txt
+ignored`);
		assert.deepEqual(preview.files, [{ operation: "delete", path: "gone.txt" }]);
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
	});
});
