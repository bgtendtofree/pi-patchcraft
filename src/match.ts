import type { PatchChunk } from "./types.ts";

interface Match {
	index: number;
	fuzz: 0 | 1 | 100 | 10000;
}

interface SplitContent {
	lines: string[];
	lineEnding: "\n" | "\r\n" | "\r";
	hasFinalLineEnding: boolean;
}

/** Fuzz weights match openai/codex: exact, trailing whitespace, surrounding whitespace, normalized. */
const FUZZ_EXACT = 0;
const FUZZ_TRAILING_WHITESPACE = 1;
const FUZZ_SURROUNDING_WHITESPACE = 100;
const FUZZ_NORMALIZED = 10000;

const BOM = "\uFEFF";

/** Split a leading UTF-8 BOM from file content, mirroring Pi's edit tool. */
export function splitBom(text: string): { bom: string; text: string } {
	return text.startsWith(BOM) ? { bom: BOM, text: text.slice(1) } : { bom: "", text };
}

function normalizeLine(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findSequence(lines: string[], pattern: string[], start: number, eof: boolean): Match | undefined {
	if (pattern.length === 0) return { index: start, fuzz: FUZZ_EXACT };
	const last = lines.length - pattern.length;
	const first = eof ? Math.max(0, last) : start;
	const variants: Array<{ fuzz: Match["fuzz"]; prepare: (value: string) => string }> = [
		{ fuzz: FUZZ_EXACT, prepare: (value) => value },
		{ fuzz: FUZZ_TRAILING_WHITESPACE, prepare: (value) => value.trimEnd() },
		{ fuzz: FUZZ_SURROUNDING_WHITESPACE, prepare: (value) => value.trim() },
		{ fuzz: FUZZ_NORMALIZED, prepare: normalizeLine },
	];

	for (const variant of variants) {
		const expected = pattern.map(variant.prepare);
		for (let index = first; index <= last; index++) {
			if (expected.every((value, offset) => variant.prepare(lines[index + offset] ?? "") === value)) {
				return { index, fuzz: variant.fuzz };
			}
		}
	}
	return undefined;
}

function splitContent(content: string): SplitContent {
	const matchedLineEnding = content.match(/\r\n|\r|\n/)?.[0];
	const lineEnding = matchedLineEnding === "\r\n" || matchedLineEnding === "\r" ? matchedLineEnding : "\n";
	const hasFinalLineEnding = /(?:\r\n|\r|\n)$/.test(content);
	const lines = content === "" ? [] : content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (hasFinalLineEnding) lines.pop();
	return { lines, lineEnding, hasFinalLineEnding };
}

/** Apply parsed chunks to file content. Content must already have its BOM removed. */
export function applyChunks(
	content: string,
	filePath: string,
	chunks: PatchChunk[],
): { content: string; fuzz: number } {
	const { lines, lineEnding, hasFinalLineEnding } = splitContent(content);
	const replacements: Array<{ start: number; oldLength: number; newLines: string[]; order: number }> = [];
	let cursor = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const context of chunk.contexts) {
			const contextMatch = findSequence(lines, [context], cursor, false);
			if (!contextMatch) throw new Error(`Failed to find context '${context}' in ${filePath}`);
			cursor = contextMatch.index + 1;
			fuzz += contextMatch.fuzz;
		}

		if (chunk.oldLines.length === 0) {
			const insertionPoint = chunk.endOfFile || chunk.contexts.length === 0 ? lines.length : cursor;
			replacements.push({
				start: insertionPoint,
				oldLength: 0,
				newLines: chunk.newLines,
				order: replacements.length,
			});
			continue;
		}

		const match = findSequence(lines, chunk.oldLines, cursor, chunk.endOfFile);
		if (!match) {
			throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		}
		replacements.push({
			start: match.index,
			oldLength: chunk.oldLines.length,
			newLines: chunk.newLines,
			order: replacements.length,
		});
		cursor = match.index + chunk.oldLines.length;
		fuzz += match.fuzz;
	}

	const next = [...lines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start || right.order - left.order)) {
		next.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	const finalLineEnding = hasFinalLineEnding ? lineEnding : "";
	return { content: `${next.join(lineEnding)}${finalLineEnding}`, fuzz };
}
