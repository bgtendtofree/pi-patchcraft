import type { PatchChunk } from "./types.ts";

type LineEnding = "\n" | "\r\n" | "\r";

interface SourceLine {
	text: string;
	ending: LineEnding | null;
}

interface SourceFile {
	lines: SourceLine[];
	preferredEnding: LineEnding;
}

interface Match {
	index: number;
	fuzz: 0 | 1 | 100 | 10000;
}

interface Replacement {
	startIndex: number;
	oldLength: number;
	newLines: string[];
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
		.trim()
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findSequence(
	lines: readonly string[],
	pattern: readonly string[],
	start: number,
	eof: boolean,
): Match | undefined {
	if (pattern.length === 0) return { index: start, fuzz: FUZZ_EXACT };
	if (pattern.length > lines.length) return undefined;
	const last = lines.length - pattern.length;
	const first = eof ? Math.max(last, start) : start;
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

/**
 * Split content into logical lines while retaining each line ending, matching Codex
 * `SourceFile::parse`. The first ending found becomes the preferred style for inserted lines; a file
 * with no ending uses LF.
 */
function parseSource(contents: string): SourceFile {
	const lines: SourceLine[] = [];
	let preferredEnding: LineEnding | undefined;
	let lineStart = 0;
	let cursor = 0;

	while (cursor < contents.length) {
		const character = contents[cursor];
		let ending: LineEnding | undefined;
		let endingLength = 0;
		if (character === "\r" && contents[cursor + 1] === "\n") {
			ending = "\r\n";
			endingLength = 2;
		} else if (character === "\r") {
			ending = "\r";
			endingLength = 1;
		} else if (character === "\n") {
			ending = "\n";
			endingLength = 1;
		} else {
			cursor += 1;
			continue;
		}
		preferredEnding ??= ending;
		lines.push({ text: contents.slice(lineStart, cursor), ending });
		cursor += endingLength;
		lineStart = cursor;
	}

	if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart), ending: null });
	return { lines, preferredEnding: preferredEnding ?? "\n" };
}

function computeReplacements(
	originalLines: readonly string[],
	filePath: string,
	chunks: readonly PatchChunk[],
): { replacements: Replacement[]; fuzz: number } {
	const replacements: Replacement[] = [];
	let lineIndex = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const context of chunk.contexts) {
			const contextMatch = findSequence(originalLines, [context], lineIndex, false);
			if (!contextMatch) throw new Error(`Failed to find context '${context}' in ${filePath}`);
			lineIndex = contextMatch.index + 1;
			fuzz += contextMatch.fuzz;
		}

		// Codex appends context-less additions at end of file; a `@@` context only advances the cursor.
		if (chunk.oldLines.length === 0) {
			replacements.push({ startIndex: originalLines.length, oldLength: 0, newLines: [...chunk.newLines] });
			continue;
		}

		let pattern: readonly string[] = chunk.oldLines;
		let newLines: readonly string[] = chunk.newLines;
		let match = findSequence(originalLines, pattern, lineIndex, chunk.endOfFile);
		if (!match && pattern.at(-1) === "") {
			// The trailing empty string stands for the final newline, which the line list does not hold.
			pattern = pattern.slice(0, -1);
			if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
			match = findSequence(originalLines, pattern, lineIndex, chunk.endOfFile);
		}
		if (!match) throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		fuzz += match.fuzz;

		// Keep context lines untouched so their exact text and terminator survive mixed line endings.
		let oldStart = 0;
		let newStart = 0;
		for (const [oldContext, newContext] of chunk.contextLineIndices) {
			if (oldContext >= pattern.length || newContext >= newLines.length) break;
			if (oldStart !== oldContext || newStart !== newContext) {
				replacements.push({
					startIndex: match.index + oldStart,
					oldLength: oldContext - oldStart,
					newLines: newLines.slice(newStart, newContext),
				});
			}
			oldStart = oldContext + 1;
			newStart = newContext + 1;
		}
		if (oldStart !== pattern.length || newStart !== newLines.length) {
			replacements.push({
				startIndex: match.index + oldStart,
				oldLength: pattern.length - oldStart,
				newLines: newLines.slice(newStart),
			});
		}
		lineIndex = match.index + pattern.length;
	}

	replacements.sort((left, right) => left.startIndex - right.startIndex);
	return { replacements, fuzz };
}

function applyReplacements(source: SourceFile, replacements: readonly Replacement[]): void {
	const sourceLines = source.lines;
	const next: SourceLine[] = [];
	let sourceIndex = 0;

	for (const { startIndex, oldLength, newLines } of replacements) {
		while (sourceIndex < startIndex) {
			const line = sourceLines[sourceIndex];
			if (line) next.push(line);
			sourceIndex += 1;
		}
		sourceIndex += oldLength;
		for (const text of newLines) next.push({ text, ending: source.preferredEnding });
	}
	while (sourceIndex < sourceLines.length) {
		const line = sourceLines[sourceIndex];
		if (line) next.push(line);
		sourceIndex += 1;
	}

	// Every resulting line gets an ending, matching apply-patch's historical trailing-newline behavior.
	for (const line of next) line.ending ??= source.preferredEnding;
	source.lines = next;
}

function serializeSource(source: SourceFile): string {
	let contents = "";
	for (const line of source.lines) contents += line.text + (line.ending ?? "");
	return contents;
}

/** Apply parsed chunks to file content, matching Codex line-ending and trailing-newline handling. */
export function applyChunks(
	content: string,
	filePath: string,
	chunks: readonly PatchChunk[],
): { content: string; fuzz: number } {
	const source = parseSource(content);
	const originalLines = source.lines.map((line) => line.text);
	const { replacements, fuzz } = computeReplacements(originalLines, filePath, chunks);
	applyReplacements(source, replacements);
	return { content: serializeSource(source), fuzz };
}
