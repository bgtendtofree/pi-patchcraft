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
			{ operation: "add", path: "a.txt", added: 2, removed: 0 },
			{ operation: "move", path: "b.txt", targetPath: "c.txt", added: 2, removed: 1 },
		]);
		assert.equal(preview.added, 4);
		assert.equal(preview.removed, 1);
		assert.equal(preview.truncated, false);
	});

	it("ignores text outside the envelope and malformed lines", () => {
		assert.deepEqual(scanPatchPreview("not a patch"), { files: [], added: 0, removed: 0, truncated: false });
		const preview = scanPatchPreview(`*** Begin Patch
garbage
*** Delete File: gone.txt
-ignored
*** End Patch
*** Add File: after.txt
+ignored`);
		assert.deepEqual(preview.files, [{ operation: "delete", path: "gone.txt", added: 0, removed: 0 }]);
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
});
