import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePatch } from "../src/parser.ts";

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
						contextLineIndices: [],
						oldLines: ["before"],
						newLines: ["after"],
						endOfFile: false,
					},
				],
			},
			{ type: "delete", path: "gone.txt" },
		]);
	});

	it("records context line indices", () => {
		const [operation] = parsePatch(`*** Begin Patch
*** Update File: value.txt
@@
 keep
-old
+new
*** End Patch`);
		assert.equal(operation?.type, "update");
		if (operation?.type !== "update") return;
		assert.deepEqual(operation.chunks[0], {
			contexts: [],
			contextLineIndices: [[0, 0]],
			oldLines: ["keep", "old"],
			newLines: ["keep", "new"],
			endOfFile: false,
		});
	});

	it("keeps a space-only context line before the first change", () => {
		const [operation] = parsePatch("*** Begin Patch\n*** Update File: value.txt\n \n-old\n+new\n*** End Patch");
		assert.equal(operation?.type, "update");
		if (operation?.type !== "update") return;
		assert.deepEqual(operation.chunks[0], {
			contexts: [],
			contextLineIndices: [[0, 0]],
			oldLines: ["", "old"],
			newLines: ["", "new"],
			endOfFile: false,
		});
	});

	it("supports EOF markers", () => {
		const [operation] = parsePatch(`*** Begin Patch
*** Update File: value.txt
@@
-old
+new
*** End of File
*** End Patch`);
		assert.equal(operation?.type, "update");
		if (operation?.type !== "update") return;
		assert.equal(operation.chunks[0]?.endOfFile, true);
	});

	it("trims trailing whitespace from a header path like Codex", () => {
		const [operation] = parsePatch("*** Begin Patch\n*** Add File: new.txt \n+created\n*** End Patch");
		assert.deepEqual(operation, { type: "add", path: "new.txt", content: "created\n" });
	});

	it("rejects empty and malformed patches", () => {
		assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /Patch is empty/);
		assert.throws(
			() => parsePatch("<<'PATCH'\n*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\nPATCH"),
			/Invalid patch format/,
		);
		assert.throws(
			() => parsePatch("*** Begin Patch\n*** Add File: a.txt\ninvalid\n*** End Patch"),
			/Add File lines must start/,
		);
		assert.throws(
			() => parsePatch("*** Begin Patch\n*** Update File: a.txt\ngarbage\n*** End Patch"),
			/Invalid update line/,
		);
		assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n*** End Patch"), /has no content lines/);
		assert.throws(
			() => parsePatch("*** Begin Patch\n*** Frobnicate File: a.txt\n*** End Patch"),
			/Unknown patch header/,
		);
		assert.throws(
			() => parsePatch("*** Begin Patch\n*** Update File: a.txt\n@@invalid\n-old\n+new\n*** End Patch"),
			/Invalid update marker/,
		);
	});
});
