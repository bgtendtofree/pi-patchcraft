import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { scanPatchPreview } from "../src/preview.ts";
import {
	formatPatchCall,
	formatPatchError,
	formatPatchProgress,
	formatPatchResult,
	formatPatchSummary,
	type RenderTheme,
} from "../src/render.ts";
import type { PatchResultDetails } from "../src/types.ts";

initTheme("dark", false);

const theme: RenderTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function details(changes: PatchResultDetails["changes"]): PatchResultDetails {
	return {
		changes,
		added: changes.reduce((sum, change) => sum + change.added, 0),
		removed: changes.reduce((sum, change) => sum + change.removed, 0),
		fuzz: 0,
	};
}

describe("formatPatchCall", () => {
	it("shows a single-file summary with counts", () => {
		const preview = scanPatchPreview("*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new");
		assert.equal(
			formatPatchCall(preview, theme, { expanded: false, argsComplete: false }),
			"apply_patch  Edited src/app.ts (+1 -1)",
		);
	});

	it("shows a multi-file roster without diffs", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one\n+two",
		);
		const text = formatPatchCall(preview, theme, { expanded: false, argsComplete: false });
		assert.match(text, /apply_patch {2}Edited 2 files \(\+3 -1\)/);
		assert.match(text, /└ M a\.ts \(\+1 -1\)/);
		assert.match(text, /└ A b\.ts \(\+2 -0\)/);
		assert.doesNotMatch(text, /old/);
	});

	it("shows the full roster when expanded", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one",
		);
		const text = formatPatchCall(preview, theme, { expanded: true, argsComplete: false });
		assert.match(text, /Edited 2 files/);
		assert.match(text, /└ M a\.ts/);
		assert.match(text, /└ A b\.ts/);
	});

	it("adds a glimpse only after the arguments are complete", () => {
		const preview = scanPatchPreview("*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new");
		const streaming = formatPatchCall(preview, theme, { expanded: false, argsComplete: false });
		assert.doesNotMatch(streaming, /\+new/);
		const complete = formatPatchCall(preview, theme, { expanded: false, argsComplete: true });
		assert.match(complete, /-old/);
		assert.match(complete, /\+new/);
	});

	it("puts a multi-file glimpse under the focused roster row", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one",
		);
		const text = formatPatchCall(preview, theme, { expanded: false, argsComplete: true });
		assert.ok(text.indexOf("+one") > text.indexOf("└ A b.ts"));
		assert.doesNotMatch(text, /-old/);
	});

	it("labels rename-only moves and deletes", () => {
		const move = scanPatchPreview("*** Begin Patch\n*** Update File: old.rs\n*** Move to: new.rs");
		assert.equal(
			formatPatchCall(move, theme, { expanded: false, argsComplete: false }),
			"apply_patch  Moved old.rs → new.rs",
		);
		const remove = scanPatchPreview("*** Begin Patch\n*** Delete File: old.txt");
		assert.equal(
			formatPatchCall(remove, theme, { expanded: false, argsComplete: false }),
			"apply_patch  Deleted old.txt",
		);
	});
});

describe("formatPatchResult", () => {
	it("renders a single-file diff", () => {
		const text = formatPatchResult(
			details([
				{
					operation: "update",
					path: "a.ts",
					targetPath: "a.ts",
					displayDiff: "-1 old\n+1 new",
					added: 1,
					removed: 1,
					fuzz: 0,
				},
			]),
			theme,
			{ expanded: false },
		);
		assert.match(text, /old/);
		assert.match(text, /new/);
		assert.doesNotMatch(text, /apply_patch/);
	});

	it("keeps multi-file diffs collapsed until expanded", () => {
		const result = details([
			{
				operation: "update",
				path: "a.ts",
				targetPath: "a.ts",
				displayDiff: "-1 old\n+1 new",
				added: 1,
				removed: 1,
				fuzz: 0,
			},
			{
				operation: "add",
				path: "b.ts",
				targetPath: "b.ts",
				displayDiff: "+1 added",
				added: 1,
				removed: 0,
				fuzz: 0,
			},
		]);
		const collapsed = formatPatchResult(result, theme, { expanded: false });
		assert.doesNotMatch(collapsed, /old/);
		assert.doesNotMatch(collapsed, /└/);
		const expanded = formatPatchResult(result, theme, { expanded: true });
		assert.match(expanded, /└ M a\.ts/);
		assert.match(expanded, /old/);
		assert.match(expanded, /added/);
	});

	it("formats the exact summary from executed details", () => {
		const text = formatPatchSummary(
			details([
				{
					operation: "update",
					path: "a.ts",
					targetPath: "a.ts",
					displayDiff: "-1 old\n+1 new",
					added: 1,
					removed: 1,
					fuzz: 0,
				},
				{
					operation: "delete",
					path: "old.txt",
					targetPath: "old.txt",
					displayDiff: "-1 gone",
					added: 0,
					removed: 1,
					fuzz: 0,
				},
			]),
			theme,
			{ expanded: false },
		);
		assert.match(text, /Edited 2 files \(\+1 -2\)/);
		assert.match(text, /└ D old\.txt \(\+0 -1\)/);
	});

	it("renders errors and progress from content", () => {
		assert.equal(formatPatchError([{ type: "text", text: "Failed to find context" }], theme), "Failed to find context");
		assert.equal(formatPatchProgress([{ type: "text", text: "Applying patch…" }], theme), "Applying patch…");
	});
});
