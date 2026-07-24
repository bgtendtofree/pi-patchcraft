import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parsePatch } from "./parser.ts";
import { resolvePatchPath } from "./paths.ts";
import type { PatchChunk, PatchPlan, PlannedFileChange } from "./types.ts";

export class PatchApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchApplicationError";
	}
}

interface Match {
	index: number;
	fuzz: 0 | 1 | 100 | 10000;
}

interface FileState {
	content: Buffer;
	mode: number;
}

interface SplitContent {
	lines: string[];
	lineEnding: "\n" | "\r\n" | "\r";
	hasFinalLineEnding: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new PatchApplicationError("Operation aborted");
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
	if (pattern.length === 0) return { index: start, fuzz: 0 };
	const last = lines.length - pattern.length;
	const first = eof ? Math.max(0, last) : start;
	const variants: Array<{ fuzz: Match["fuzz"]; prepare: (value: string) => string }> = [
		{ fuzz: 0, prepare: (value) => value },
		{ fuzz: 1, prepare: (value) => value.trimEnd() },
		{ fuzz: 100, prepare: (value) => value.trim() },
		{ fuzz: 10000, prepare: normalizeLine },
	];

	for (const variant of variants) {
		const expected = pattern.map(variant.prepare);
		for (let index = first; index <= last; index++) {
			let matches = true;
			for (let offset = 0; offset < expected.length; offset++) {
				if (variant.prepare(lines[index + offset] ?? "") !== expected[offset]) {
					matches = false;
					break;
				}
			}
			if (matches) return { index, fuzz: variant.fuzz };
		}
	}
	return undefined;
}

function splitContent(content: string): SplitContent {
	const matchedLineEnding = content.match(/\r\n|\r|\n/)?.[0];
	const lineEnding = matchedLineEnding === "\r\n" || matchedLineEnding === "\r" ? matchedLineEnding : "\n";
	const hasFinalLineEnding = /(?:\r\n|\r|\n)$/.test(content);
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (hasFinalLineEnding) lines.pop();
	return { lines, lineEnding, hasFinalLineEnding };
}

function applyChunks(content: string, filePath: string, chunks: PatchChunk[]): { content: string; fuzz: number } {
	const { lines, lineEnding, hasFinalLineEnding } = splitContent(content);
	const replacements: Array<{ start: number; oldLength: number; newLines: string[]; order: number }> = [];
	let cursor = 0;
	let fuzz = 0;

	for (const chunk of chunks) {
		for (const context of chunk.contexts) {
			const contextMatch = findSequence(lines, [context], cursor, false);
			if (!contextMatch) throw new PatchApplicationError(`Failed to find context '${context}' in ${filePath}`);
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
			throw new PatchApplicationError(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
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

async function readState(absolutePath: string): Promise<FileState | undefined> {
	try {
		const stats = await lstat(absolutePath);
		if (!stats.isFile()) throw new PatchApplicationError(`Patch target is not a regular file: ${absolutePath}`);
		return { content: await readFile(absolutePath), mode: stats.mode };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function createChange(input: Omit<PlannedFileChange, "diff" | "displayDiff" | "added" | "removed">): PlannedFileChange {
	const before = input.before?.toString("utf8") ?? "";
	const after = input.after?.toString("utf8") ?? "";
	const diff = generateUnifiedPatch(input.path, before, after);
	const displayDiff = generateDiffString(before, after).diff;
	return { ...input, diff, displayDiff, ...countDiff(diff) };
}

function assertUniqueChanges(changes: PlannedFileChange[]): void {
	const touched = new Set<string>();
	for (const change of changes) {
		for (const candidate of new Set([change.absolutePath, change.absoluteTargetPath])) {
			if (touched.has(candidate))
				throw new PatchApplicationError(`Patch contains conflicting operations for ${candidate}`);
			touched.add(candidate);
		}
	}
}

export async function planPatch(cwd: string, patchText: string, signal?: AbortSignal): Promise<PatchPlan> {
	throwIfAborted(signal);
	const operations = parsePatch(patchText);
	const changes: PlannedFileChange[] = [];

	for (const operation of operations) {
		throwIfAborted(signal);
		const absolutePath = await resolvePatchPath(cwd, operation.path);
		const state = await readState(absolutePath);

		if (operation.type === "add") {
			if (state) throw new PatchApplicationError(`Add File target already exists: ${operation.path}`);
			changes.push(
				createChange({
					operation: "add",
					path: operation.path,
					targetPath: operation.path,
					absolutePath,
					absoluteTargetPath: absolutePath,
					before: undefined,
					after: Buffer.from(operation.content),
					mode: undefined,
					fuzz: 0,
				}),
			);
			continue;
		}

		if (!state) throw new PatchApplicationError(`Patch target does not exist: ${operation.path}`);
		if (operation.type === "delete") {
			changes.push(
				createChange({
					operation: "delete",
					path: operation.path,
					targetPath: operation.path,
					absolutePath,
					absoluteTargetPath: absolutePath,
					before: state.content,
					after: undefined,
					mode: state.mode,
					fuzz: 0,
				}),
			);
			continue;
		}

		const updated =
			operation.chunks.length === 0
				? { content: state.content.toString("utf8"), fuzz: 0 }
				: applyChunks(state.content.toString("utf8"), operation.path, operation.chunks);
		const targetPath = operation.moveTo ?? operation.path;
		const absoluteTargetPath = await resolvePatchPath(cwd, targetPath);
		if (absoluteTargetPath !== absolutePath && (await readState(absoluteTargetPath))) {
			throw new PatchApplicationError(`Move target already exists: ${targetPath}`);
		}
		const after = Buffer.from(updated.content);
		if (absoluteTargetPath === absolutePath && after.equals(state.content)) {
			throw new PatchApplicationError(`Update produced no changes: ${operation.path}`);
		}
		changes.push(
			createChange({
				operation: operation.moveTo === undefined ? "update" : "move",
				path: operation.path,
				targetPath,
				absolutePath,
				absoluteTargetPath,
				before: state.content,
				after,
				mode: state.mode,
				fuzz: updated.fuzz,
			}),
		);
	}

	assertUniqueChanges(changes);
	return {
		changes,
		added: changes.reduce((sum, change) => sum + change.added, 0),
		removed: changes.reduce((sum, change) => sum + change.removed, 0),
		fuzz: changes.reduce((sum, change) => sum + change.fuzz, 0),
	};
}

async function writeAtomic(absolutePath: string, content: Buffer, mode?: number): Promise<void> {
	await mkdir(path.dirname(absolutePath), { recursive: true });
	const temporary = path.join(
		path.dirname(absolutePath),
		`.${path.basename(absolutePath)}.patchcraft-${process.pid}-${Math.random().toString(16).slice(2)}`,
	);
	await writeFile(temporary, content);
	try {
		if (mode !== undefined) await chmod(temporary, mode);
		await rename(temporary, absolutePath);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function applyChange(change: PlannedFileChange): Promise<void> {
	if (change.operation === "delete") {
		await unlink(change.absolutePath);
		return;
	}
	if (!change.after) throw new PatchApplicationError(`Missing planned content for ${change.targetPath}`);
	await writeAtomic(change.absoluteTargetPath, change.after, change.mode);
	if (change.operation === "move" && change.absoluteTargetPath !== change.absolutePath)
		await unlink(change.absolutePath);
}

async function rollbackChange(change: PlannedFileChange): Promise<void> {
	if (change.before === undefined) {
		await rm(change.absoluteTargetPath, { force: true });
		return;
	}
	await writeAtomic(change.absolutePath, change.before, change.mode);
	if (change.absoluteTargetPath !== change.absolutePath) await rm(change.absoluteTargetPath, { force: true });
}

async function withQueues<T>(paths: string[], index: number, callback: () => Promise<T>): Promise<T> {
	const filePath = paths[index];
	if (filePath === undefined) return callback();
	return withFileMutationQueue(filePath, () => withQueues(paths, index + 1, callback));
}

async function validatePlanState(plan: PatchPlan): Promise<void> {
	for (const change of plan.changes) {
		const source = await readState(change.absolutePath);
		if (change.before === undefined) {
			if (source !== undefined) throw new PatchApplicationError(`Patch target changed before apply: ${change.path}`);
		} else if (!source?.content.equals(change.before)) {
			throw new PatchApplicationError(`Patch source changed before apply: ${change.path}`);
		}
		if (change.absoluteTargetPath !== change.absolutePath && (await readState(change.absoluteTargetPath))) {
			throw new PatchApplicationError(`Patch target changed before apply: ${change.targetPath}`);
		}
	}
}

export async function applyPatchPlan(plan: PatchPlan, signal?: AbortSignal): Promise<void> {
	const paths = [...new Set(plan.changes.flatMap((change) => [change.absolutePath, change.absoluteTargetPath]))].sort();

	await withQueues(paths, 0, async () => {
		throwIfAborted(signal);
		await validatePlanState(plan);
		const applied: PlannedFileChange[] = [];
		let current: PlannedFileChange | undefined;
		try {
			for (const change of plan.changes) {
				current = change;
				throwIfAborted(signal);
				await applyChange(change);
				applied.push(change);
				current = undefined;
			}
		} catch (error) {
			const rollbackFailures: string[] = [];
			if (current) {
				try {
					await rollbackChange(current);
				} catch (rollbackError) {
					rollbackFailures.push(
						`${current.targetPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			for (const change of [...applied].reverse()) {
				try {
					await rollbackChange(change);
				} catch (rollbackError) {
					rollbackFailures.push(
						`${change.targetPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			const original = error instanceof Error ? error.message : String(error);
			const suffix =
				rollbackFailures.length === 0
					? "All applied changes were rolled back."
					: `Rollback failed:\n${rollbackFailures.join("\n")}`;
			throw new PatchApplicationError(`Patch application failed: ${original}\n${suffix}`);
		}
	});
}
