import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { scanPatchPreview } from "../src/preview.ts";
import {
	formatPatchCall,
	formatPatchError,
	formatPatchProgress,
	formatPatchResult,
	type RenderTheme,
} from "../src/render.ts";
import type { PatchResultDetails } from "../src/types.ts";

initTheme("dark", false);

const theme: RenderTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Stands in for Pi's injected helper so tests prove the hint comes from the render context. */
const keyHint = (keybinding: string, description: string) => `<${keybinding}> ${description}`;

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
			formatPatchCall(preview, theme, { expanded: false, phase: "streaming" }),
			"apply_patch  Edited src/app.ts (+1 -1)",
		);
	});

	it("shows a multi-file roster without diffs", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one\n+two",
		);
		const text = formatPatchCall(preview, theme, { expanded: false, phase: "streaming" });
		assert.match(text, /apply_patch {2}Edited 2 files \(\+3 -1\)/);
		assert.match(text, /└ M a\.ts \(\+1 -1\)/);
		assert.match(text, /└ A b\.ts \(\+2 -0\)/);
		assert.doesNotMatch(text, /old/);
	});

	it("shows the full roster when expanded", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one",
		);
		const text = formatPatchCall(preview, theme, { expanded: true, phase: "streaming" });
		assert.match(text, /Edited 2 files/);
		assert.match(text, /└ M a\.ts/);
		assert.match(text, /└ A b\.ts/);
	});

	it("adds a glimpse only after the arguments are complete", () => {
		const preview = scanPatchPreview("*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new");
		const streaming = formatPatchCall(preview, theme, { expanded: false, phase: "streaming" });
		assert.doesNotMatch(streaming, /\+new/);
		const complete = formatPatchCall(preview, theme, { expanded: false, phase: "ready" });
		assert.match(complete, /-old/);
		assert.match(complete, /\+new/);
	});

	it("puts a multi-file glimpse under the focused roster row", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one",
		);
		const text = formatPatchCall(preview, theme, { expanded: false, phase: "ready" });
		assert.ok(text.indexOf("+one") > text.indexOf("└ A b.ts"));
		assert.doesNotMatch(text, /-old/);
	});

	it("drops the call preview roster and glimpse once execution starts", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+one",
		);
		const before = formatPatchCall(preview, theme, { expanded: false, phase: "ready" });
		assert.match(before, /└ M a\.ts/);
		assert.match(before, /\+one/);
		const after = formatPatchCall(preview, theme, {
			expanded: false,
			phase: "running",
		});
		assert.equal(after, "apply_patch");
	});

	it("keeps single-file counts and drops only the glimpse once execution starts", () => {
		const preview = scanPatchPreview("*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new");
		const after = formatPatchCall(preview, theme, {
			expanded: false,
			phase: "running",
		});
		assert.equal(after, "apply_patch  Edited src/app.ts (+1 -1)");
	});

	it("labels an all-move multi-file patch", () => {
		const preview = scanPatchPreview(
			"*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Update File: c.ts\n*** Move to: d.ts",
		);
		assert.match(formatPatchCall(preview, theme, { expanded: false, phase: "streaming" }), /Moved 2 files/);
	});

	it("omits uncertain delete totals from the multi-file call preview", () => {
		const preview = scanPatchPreview("*** Begin Patch\n*** Delete File: a.txt\n*** Update File: b.ts\n@@\n-x\n+y");
		const [header] = formatPatchCall(preview, theme, { expanded: false, phase: "streaming" }).split("\n");
		assert.equal(header, "apply_patch  Edited 2 files");
	});

	it("summarises the roster beyond the collapsed limit", () => {
		const patch = [
			"*** Begin Patch",
			...Array.from({ length: 12 }, (_, index) => `*** Add File: f${index + 1}.txt\n+x`),
			"*** End Patch",
		].join("\n");
		const text = formatPatchCall(scanPatchPreview(patch), theme, { expanded: false, phase: "streaming" });
		assert.match(text, /└ A f10\.txt/);
		assert.doesNotMatch(text, /f11\.txt/);
		assert.match(text, /… 2 more files/);
	});

	it("labels rename-only moves and deletes", () => {
		const move = scanPatchPreview("*** Begin Patch\n*** Update File: old.rs\n*** Move to: new.rs");
		assert.equal(
			formatPatchCall(move, theme, { expanded: false, phase: "streaming" }),
			"apply_patch  Moved old.rs → new.rs",
		);
		const remove = scanPatchPreview("*** Begin Patch\n*** Delete File: old.txt");
		assert.equal(
			formatPatchCall(remove, theme, { expanded: false, phase: "streaming" }),
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
			{ expanded: false, keyHint },
		);
		assert.match(text, /old/);
		assert.match(text, /new/);
		assert.doesNotMatch(text, /apply_patch/);
	});

	it("shows a single-file diff in full like Pi's edit tool", () => {
		const diff = Array.from({ length: 250 }, (_, index) => `+${index + 1} line${index + 1}`).join("\n");
		const text = formatPatchResult(
			details([
				{
					operation: "add",
					path: "big.txt",
					targetPath: "big.txt",
					displayDiff: diff,
					added: 250,
					removed: 0,
					fuzz: 0,
				},
			]),
			theme,
			{ expanded: false, keyHint },
		);
		assert.match(text, /line250/);
		assert.doesNotMatch(text, /more lines/);
	});

	it("shows the exact multi-file summary and roster without expansion", () => {
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
				operation: "delete",
				path: "old.txt",
				targetPath: "old.txt",
				displayDiff: "-1 gone",
				added: 0,
				removed: 1,
				fuzz: 0,
			},
		]);
		const collapsed = formatPatchResult(result, theme, { expanded: false, keyHint });
		assert.match(collapsed, /Edited 2 files \(\+1 -2\)/);
		assert.match(collapsed, /└ M a\.ts \(\+1 -1\)/);
		assert.match(collapsed, /└ D old\.txt \(\+0 -1\)/);
		assert.doesNotMatch(collapsed, /-1 old/);
		assert.match(collapsed, /<app\.tools\.expand> to expand diffs/);
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
		const collapsed = formatPatchResult(result, theme, { expanded: false, keyHint });
		assert.match(collapsed, /Edited 2 files \(\+2 -1\)/);
		assert.match(collapsed, /└ M a\.ts/);
		assert.match(collapsed, /└ A b\.ts/);
		assert.doesNotMatch(collapsed, /old/);
		assert.doesNotMatch(collapsed, /added/);
		assert.match(collapsed, /<app\.tools\.expand> to expand diffs/);
		const expanded = formatPatchResult(result, theme, { expanded: true, keyHint });
		assert.match(expanded, /Edited 2 files \(\+2 -1\)/);
		assert.match(expanded, /└ M a\.ts/);
		assert.match(expanded, /old/);
		assert.match(expanded, /added/);
	});

	it("summarises results beyond the collapsed roster", () => {
		const changes = Array.from({ length: 12 }, (_, index) => ({
			operation: "add" as const,
			path: `f${index + 1}.txt`,
			targetPath: `f${index + 1}.txt`,
			displayDiff: "+1 x",
			added: 1,
			removed: 0,
			fuzz: 0,
		}));
		const text = formatPatchResult(details(changes), theme, { expanded: false, keyHint });
		assert.match(text, /Added 12 files \(\+12 -0\)/);
		assert.match(text, /… 2 more files/);
		assert.doesNotMatch(text, /f11\.txt/);
	});

	it("bounds expanded diffs per file and in total", () => {
		// 5 files of 600 lines: each file shows at most 500 lines, and the total budget of 2000 lines is
		// spent by the first four, so the fifth keeps only its roster row.
		const changes = Array.from({ length: 5 }, (_, file) => ({
			operation: "add" as const,
			path: `f${file + 1}.txt`,
			targetPath: `f${file + 1}.txt`,
			displayDiff: Array.from({ length: 600 }, (_, line) => `+${line + 1} f${file + 1}-${line + 1}`).join("\n"),
			added: 600,
			removed: 0,
			fuzz: 0,
		}));
		const text = formatPatchResult(details(changes), theme, { expanded: true, keyHint });
		assert.match(text, /f1-500\b/);
		assert.doesNotMatch(text, /f1-501\b/);
		assert.match(text, /f4-500\b/);
		assert.match(text, /└ A f5\.txt/);
		assert.doesNotMatch(text, /f5-1\b/);
		assert.match(text, /… output truncated/);
	});

	it("renders errors and progress from content", () => {
		assert.equal(formatPatchError([{ type: "text", text: "Failed to find context" }], theme), "Failed to find context");
		assert.equal(formatPatchProgress([{ type: "text", text: "Applying patch…" }], theme), "Applying patch…");
	});
});
