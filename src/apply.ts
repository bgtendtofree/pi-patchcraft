import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyChunks, splitBom } from "./match.ts";
import { parsePatch } from "./parser.ts";
import { directoryUsesCaseInsensitiveNames, resolveExistingIdentity, resolvePatchPath } from "./paths.ts";
import type { PatchPlan, PlannedFileChange } from "./types.ts";

interface FileState {
	content: Buffer;
	mode: number;
}

async function readState(absolutePath: string): Promise<FileState | undefined> {
	try {
		const stats = await lstat(absolutePath);
		if (!stats.isFile()) throw new Error(`Patch target is not a regular file: ${absolutePath}`);
		return { content: await readFile(absolutePath), mode: stats.mode };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function createChange(input: Omit<PlannedFileChange, "displayDiff" | "added" | "removed">): PlannedFileChange {
	const before = input.before?.toString("utf8") ?? "";
	const after = input.after?.toString("utf8") ?? "";
	const displayDiff = generateDiffString(before, after).diff;
	return {
		...input,
		displayDiff,
		added: (displayDiff.match(/^\+/gm) ?? []).length,
		removed: (displayDiff.match(/^-/gm) ?? []).length,
	};
}

function assertUniqueChanges(changes: PlannedFileChange[]): void {
	const touched = new Set<string>();
	for (const change of changes) {
		for (const candidate of new Set([change.identityPath, change.identityTargetPath])) {
			if (touched.has(candidate)) throw new Error(`Patch contains conflicting operations for ${candidate}`);
			touched.add(candidate);
		}
	}
}

async function existingDirectoryFor(startPath: string): Promise<string> {
	let current = startPath;
	while (true) {
		try {
			await lstat(current);
			return current;
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
			const parent = path.dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

/**
 * Distinct spellings that would be one file on a case-insensitive filesystem must be rejected.
 * Only envelopes with such a candidate group are probed, so a lone new file never lists its
 * directory and an execute-only directory still accepts normal adds. A probe that cannot decide
 * fails closed for that potential conflict.
 */
async function assertNoCaseAliasConflicts(changes: PlannedFileChange[]): Promise<void> {
	const groups = new Map<string, string[]>();
	for (const change of changes) {
		for (const value of [change.absolutePath, change.absoluteTargetPath]) {
			const key = value.toLowerCase();
			const list = groups.get(key);
			if (!list) groups.set(key, [value]);
			else if (!list.includes(value)) list.push(value);
		}
	}
	const probes = new Map<string, Promise<boolean | undefined>>();
	for (const originals of groups.values()) {
		if (originals.length < 2) continue;
		for (const original of originals) {
			const directory = await existingDirectoryFor(path.dirname(original));
			let probe = probes.get(directory);
			if (!probe) {
				probe = directoryUsesCaseInsensitiveNames(directory);
				probes.set(directory, probe);
			}
			if ((await probe) !== false) throw new Error(`Patch contains conflicting operations for ${original}`);
		}
	}
}

export async function planPatch(cwd: string, patchText: string, signal?: AbortSignal): Promise<PatchPlan> {
	signal?.throwIfAborted();
	const operations = parsePatch(patchText);
	const changes: PlannedFileChange[] = [];

	for (const operation of operations) {
		signal?.throwIfAborted();
		const absolutePath = await resolvePatchPath(cwd, operation.path);
		const state = await readState(absolutePath);
		// Identity is separate from the operational path: existing files use realpath, missing files
		// keep their exact spelling. Potential case aliases are handled in one pass after planning, so
		// a normal add never causes a directory listing.
		const identityPath = state ? ((await resolveExistingIdentity(absolutePath)) ?? absolutePath) : absolutePath;

		if (operation.type === "add") {
			// Codex creates or overwrites an Add File target; a pre-existing file is captured for rollback.
			changes.push(
				createChange({
					operation: "add",
					path: operation.path,
					targetPath: operation.path,
					absolutePath,
					absoluteTargetPath: absolutePath,
					identityPath,
					identityTargetPath: identityPath,
					before: state?.content,
					after: Buffer.from(operation.content),
					mode: state?.mode,
					fuzz: 0,
				}),
			);
			continue;
		}

		if (!state) throw new Error(`Patch target does not exist: ${operation.path}`);
		if (operation.type === "delete") {
			changes.push(
				createChange({
					operation: "delete",
					path: operation.path,
					targetPath: operation.path,
					absolutePath,
					absoluteTargetPath: absolutePath,
					identityPath,
					identityTargetPath: identityPath,
					before: state.content,
					after: undefined,
					mode: state.mode,
					fuzz: 0,
				}),
			);
			continue;
		}

		// Buffers can hold arbitrary bytes. Text matching would replace invalid sequences with U+FFFD
		// and corrupt untouched content, so reject unsupported encodings before any mutation.
		if (!isUtf8(state.content)) throw new Error(`Patch source is not valid UTF-8: ${operation.path}`);

		// Strip a leading BOM before matching, like Pi's edit tool: models never emit it in a patch.
		const { bom, text } = splitBom(state.content.toString("utf8"));
		const updated = applyChunks(text, operation.path, operation.chunks);

		const targetPath = operation.moveTo ?? operation.path;
		let absoluteTargetPath = absolutePath;
		let identityTargetPath = identityPath;
		if (operation.moveTo !== undefined) {
			const resolvedTarget = await resolvePatchPath(cwd, targetPath);
			// `absolutePath` is the parent-resolved source spelling. Only a literal rename-to-self keeps
			// the in-place behavior; any other spelling of an existing file is still a rejected target,
			// including case-insensitive aliases of the source itself.
			if (resolvedTarget !== absolutePath) {
				if (await readState(resolvedTarget)) throw new Error(`Move target already exists: ${targetPath}`);
				absoluteTargetPath = resolvedTarget;
				identityTargetPath = resolvedTarget;
			}
		}
		const after = Buffer.from(`${bom}${updated.content}`);
		if (absoluteTargetPath === absolutePath && after.equals(state.content)) {
			throw new Error(`Update produced no changes: ${operation.path}`);
		}
		changes.push(
			createChange({
				operation: operation.moveTo === undefined ? "update" : "move",
				path: operation.path,
				targetPath,
				absolutePath,
				absoluteTargetPath,
				identityPath,
				identityTargetPath,
				before: state.content,
				after,
				mode: state.mode,
				fuzz: updated.fuzz,
			}),
		);
	}

	assertUniqueChanges(changes);
	await assertNoCaseAliasConflicts(changes);
	return {
		changes,
		added: changes.reduce((sum, change) => sum + change.added, 0),
		removed: changes.reduce((sum, change) => sum + change.removed, 0),
		fuzz: changes.reduce((sum, change) => sum + change.fuzz, 0),
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * A rename only needs write permission on the directory, so it would replace a read-only file that
 * Pi's edit/write and Codex refuse. Require the same write permission an in-place write would need.
 */
async function assertReplaceable(absolutePath: string): Promise<void> {
	try {
		await access(absolutePath, constants.W_OK);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw error;
	}
}

async function writeAtomic(absolutePath: string, content: Buffer, mode?: number): Promise<void> {
	await assertReplaceable(absolutePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	// Short, target-independent name: a long target basename must not overflow the name limit.
	// Exclusive creation (wx) keeps a target-restrictive mode and never replaces a file this operation
	// did not create.
	const temporary = path.join(path.dirname(absolutePath), `.patchcraft-${process.pid}-${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", mode ?? 0o666);
	let closed = false;
	try {
		await handle.writeFile(content);
		if (mode !== undefined) await handle.chmod(mode);
		await handle.close();
		closed = true;
		await rename(temporary, absolutePath);
	} catch (error) {
		const cleanupFailures: string[] = [];
		if (!closed) {
			try {
				await handle.close();
			} catch (closeError) {
				cleanupFailures.push(`close: ${describeError(closeError)}`);
			}
		}
		try {
			await rm(temporary, { force: true });
		} catch (cleanupError) {
			cleanupFailures.push(`remove ${temporary}: ${describeError(cleanupError)}`);
		}
		if (cleanupFailures.length > 0) {
			throw new Error(`${describeError(error)}\nFailed to clean up temporary file: ${cleanupFailures.join("; ")}`);
		}
		throw error;
	}
}

async function applyChange(change: PlannedFileChange): Promise<void> {
	if (change.operation === "delete") {
		await unlink(change.absolutePath);
		return;
	}
	if (!change.after) throw new Error(`Missing planned content for ${change.targetPath}`);
	await writeAtomic(change.absoluteTargetPath, change.after, change.mode);
	if (change.operation === "move" && change.absoluteTargetPath !== change.absolutePath)
		await unlink(change.absolutePath);
}

async function rollbackChange(change: PlannedFileChange): Promise<void> {
	if (change.before === undefined) {
		await rm(change.absoluteTargetPath, { force: true });
		return;
	}
	// Restore first, then remove the destination. A failed restore must never delete the destination:
	// after a completed move the destination can be the only surviving copy of the content.
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
			if (source !== undefined) throw new Error(`Patch target changed before apply: ${change.path}`);
		} else {
			if (!source?.content.equals(change.before)) {
				throw new Error(`Patch source changed before apply: ${change.path}`);
			}
			// Do not overwrite permissions the user changed after planning; reject instead of restoring.
			if (change.mode !== undefined && source.mode !== undefined && (source.mode & 0o7777) !== (change.mode & 0o7777)) {
				throw new Error(`Patch source permissions changed before apply: ${change.path}`);
			}
		}
		if (change.absoluteTargetPath !== change.absolutePath && (await readState(change.absoluteTargetPath))) {
			throw new Error(`Patch target changed before apply: ${change.targetPath}`);
		}
	}
}

/**
 * Keys Pi's mutation queue will use. For a target that does not exist Pi keys on the exact resolved
 * path (`realpath` fails), so identity case-folding must not be used there. Existing files key on
 * realpath, which `identityPath` already holds.
 */
function mutationQueueKeys(change: PlannedFileChange): string[] {
	const source = change.before === undefined ? change.absolutePath : change.identityPath;
	if (change.absoluteTargetPath === change.absolutePath) return [source];
	return [source, change.absoluteTargetPath];
}

export async function applyPatchPlan(plan: PatchPlan, signal?: AbortSignal): Promise<void> {
	const paths = [...new Set(plan.changes.flatMap(mutationQueueKeys))].sort();

	await withQueues(paths, 0, async () => {
		signal?.throwIfAborted();
		await validatePlanState(plan);
		const applied: PlannedFileChange[] = [];
		let current: PlannedFileChange | undefined;
		try {
			for (const change of plan.changes) {
				// Check before marking a change in flight: an abort here has nothing to roll back.
				signal?.throwIfAborted();
				current = change;
				await applyChange(change);
				// The filesystem operation has settled; an abort during it must still undo this change.
				signal?.throwIfAborted();
				applied.push(change);
				current = undefined;
			}
		} catch (error) {
			const rollbackFailures: string[] = [];
			if (current) {
				try {
					await rollbackChange(current);
				} catch (rollbackError) {
					rollbackFailures.push(`${current.targetPath}: ${describeError(rollbackError)}`);
				}
			}
			for (const change of [...applied].reverse()) {
				try {
					await rollbackChange(change);
				} catch (rollbackError) {
					rollbackFailures.push(`${change.targetPath}: ${describeError(rollbackError)}`);
				}
			}
			const original = error instanceof Error ? error.message : String(error);
			const suffix =
				rollbackFailures.length === 0
					? "All applied changes were rolled back."
					: `Rollback failed:\n${rollbackFailures.join("\n")}`;
			throw new Error(`Patch application failed: ${original}\n${suffix}`);
		}
	});
}
