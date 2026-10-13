import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChunks, splitBom } from "../src/match.ts";
import type { PatchChunk } from "../src/types.ts";

function chunk(overrides: Partial<PatchChunk> = {}): PatchChunk {
	return { contexts: [], oldLines: [], newLines: [], endOfFile: false, ...overrides };
}

describe("applyChunks", () => {
	it("replaces an exact match with no fuzz", () => {
		const result = applyChunks("before\nafter\n", "value.txt", [
			chunk({ oldLines: ["before"], newLines: ["changed"] }),
		]);
		assert.deepEqual(result, { content: "changed\nafter\n", fuzz: 0 });
	});

	it("records each fuzz tier: trailing, surrounding, and normalized whitespace", () => {
		const trailing = applyChunks("value  \n", "value.txt", [chunk({ oldLines: ["value"], newLines: ["x"] })]);
		assert.equal(trailing.fuzz, 1);
		const surrounding = applyChunks("  value  \n", "value.txt", [chunk({ oldLines: ["value"], newLines: ["x"] })]);
		assert.equal(surrounding.fuzz, 100);
		const normalized = applyChunks("  VALUE — x  \n", "value.txt", [
			chunk({ oldLines: ["VALUE - x"], newLines: ["y"] }),
		]);
		assert.equal(normalized.fuzz, 10000);
	});

	it("resolves a context marker before the change", () => {
		const result = applyChunks("a\nmarker\nb\n", "value.txt", [
			chunk({ contexts: ["marker"], oldLines: ["b"], newLines: ["c"] }),
		]);
		assert.equal(result.content, "a\nmarker\nc\n");
	});

	it("inserts pure additions at end of file when requested", () => {
		const result = applyChunks("a\nb\n", "value.txt", [chunk({ newLines: ["tail"], endOfFile: true })]);
		assert.equal(result.content, "a\nb\ntail\n");
	});

	it("throws when expected lines are missing", () => {
		assert.throws(
			() => applyChunks("a\n", "value.txt", [chunk({ oldLines: ["missing"], newLines: ["x"] })]),
			/Failed to find expected lines/,
		);
	});

	it("throws when a context marker is missing", () => {
		assert.throws(
			() => applyChunks("a\n", "value.txt", [chunk({ contexts: ["missing"], newLines: ["x"] })]),
			/Failed to find context/,
		);
	});
});

describe("splitBom", () => {
	it("strips and reports a leading BOM", () => {
		assert.deepEqual(splitBom("\uFEFFvalue"), { bom: "\uFEFF", text: "value" });
	});

	it("leaves content without a BOM untouched", () => {
		assert.deepEqual(splitBom("value"), { bom: "", text: "value" });
	});
});
