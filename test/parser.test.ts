import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PatchParseError, parsePatch } from "../src/parser.ts";

describe("parsePatch", () => {
	it("parses add, update, move, and delete operations", () => {
		const operations = parsePatch(`*** Begin Patch
*** Add File: new.txt
+created
*** Update File: old.txt
*** Move to: moved.txt
@@ marker
-before
+after
*** Delete File: gone.txt
*** End Patch`);
		assert.deepEqual(operations, [
			{ type: "add", path: "new.txt", content: "created\n" },
			{
				type: "update",
				path: "old.txt",
				moveTo: "moved.txt",
				chunks: [
					{
						contexts: ["marker"],
						oldLines: ["before"],
						newLines: ["after"],
						endOfFile: false,
					},
				],
			},
			{ type: "delete", path: "gone.txt" },
		]);
	});

	it("supports heredoc wrappers and EOF markers", () => {
		const [operation] = parsePatch(`<<'PATCH'
*** Begin Patch
*** Update File: value.txt
@@
-old
+new
*** End of File
*** End Patch
PATCH`);
		assert.equal(operation?.type, "update");
		if (operation?.type !== "update") return;
		assert.equal(operation.chunks[0]?.endOfFile, true);
	});

	it("rejects empty and malformed patches", () => {
		assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), PatchParseError);
		assert.throws(
			() => parsePatch("*** Begin Patch\n*** Add File: a.txt\ninvalid\n*** End Patch"),
			/Add File lines must start/,
		);
		assert.throws(
			() => parsePatch("*** Begin Patch\n*** Frobnicate File: a.txt\n*** End Patch"),
			/Unknown patch header/,
		);
	});
});
