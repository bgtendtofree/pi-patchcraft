import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
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
	it("shows only file operations and bounds the collapsed roster", () => {
		const patch = [
			"*** Begin Patch",
			...Array.from({ length: 12 }, (_, i) => `*** Add File: f${i}\n+body`),
			"*** End Patch",
		].join("\n");
		const collapsed = formatPatchCall(patch, theme, false);
		assert.match(collapsed, /A f9/);
		assert.match(collapsed, /2 more files/);
		assert.doesNotMatch(collapsed, /body|f10/);
		assert.match(formatPatchCall(patch, theme, true), /A f11/);
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

	it("folds a long single-file diff until expanded", () => {
		const diff = Array.from({ length: 250 }, (_, index) => `+${index + 1} line${index + 1}`).join("\n");
		const result = details([
			{
				operation: "add",
				path: "big.txt",
				targetPath: "big.txt",
				displayDiff: diff,
				added: 250,
				removed: 0,
				fuzz: 0,
			},
		]);
		const text = formatPatchResult(result, theme, { expanded: false, keyHint });
		assert.match(text, /line20\b/);
		assert.doesNotMatch(text, /line21\b/);
		assert.match(text, /to expand diffs/);
		assert.match(formatPatchResult(result, theme, { expanded: true, keyHint }), /line250/);
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
