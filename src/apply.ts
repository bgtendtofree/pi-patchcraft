import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyChunks, splitBom } from "./match.ts";
import { parsePatch } from "./parser.ts";
import {
	directoryUsesCaseInsensitiveNames,
	directoryUsesNormalizationInsensitiveNames,
	resolveExistingIdentity,
	resolvePatchPathDetailed,
} from "./paths.ts";
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

function isAncestorPath(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return false;
	const relative = path.relative(ancestor, descendant);
	if (relative.length === 0 || path.isAbsolute(relative)) return false;
	// `..child.txt` is an ordinary basename; only `..` and a `../` prefix leave the directory.
	return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

interface NameLookupSensitivity {
	caseInsensitive: Promise<boolean | undefined>;
	normalizationInsensitive: Promise<boolean | undefined>;
}

interface ResolvedSensitivity {
	caseInsensitive: boolean | undefined;
	normalizationInsensitive: boolean | undefined;
}

async function lookupSensitivity(
	directory: string,
	cache: Map<string, NameLookupSensitivity>,
): Promise<ResolvedSensitivity> {
	let entry = cache.get(directory);
	if (!entry) {
		entry = {
			caseInsensitive: directoryUsesCaseInsensitiveNames(directory),
			normalizationInsensitive: directoryUsesNormalizationInsensitiveNames(directory),
		};
		cache.set(directory, entry);
	}
	return {
		caseInsensitive: await entry.caseInsensitive,
		normalizationInsensitive: await entry.normalizationInsensitive,
	};
}

/**
 * Fold a name the way the filesystem equates spellings. An axis is folded unless the probe proved
 * the filesystem is sensitive for it. An unknown axis stays folded, so a possible collision fails
 * closed instead of borrowing the other axis' answer (case-sensitive APFS is still normalization-
 * insensitive, and the reverse is possible too).
 */
function foldName(value: string, sensitivity: ResolvedSensitivity): string {
	let folded = value;
	if (sensitivity.caseInsensitive !== false) folded = folded.toLowerCase();
	if (sensitivity.normalizationInsensitive !== false) folded = folded.normalize("NFC");
	return folded;
}

/** Maximally folded key: equal only when the two paths could be one file on either axis. */
function foldAll(value: string): string {
	return value.toLowerCase().normalize("NFC");
}

/**
 * Distinct spellings that would be one file on a case-insensitive or Unicode-normalization-insensitive
 * filesystem, and a touched file that is an ancestor directory of another touched file, must be
 * rejected before any mutation. Existing files already collapse through realpath identity; this
 * covers not-yet-created Add targets, move destinations, and their absent parents.
 *
 * Case and normalization are decided independently. A probe that cannot decide an axis that would
 * equate a pair fails closed for that pair; a probe that proves sensitivity keeps genuinely distinct
 * spellings apart. Only pairs are probed, so a lone new file never lists its directory.
 */
async function assertNoNameAliasConflicts(changes: PlannedFileChange[]): Promise<void> {
	const touched = new Set<string>();
	for (const change of changes) {
		touched.add(change.absolutePath);
		touched.add(change.absoluteTargetPath);
	}
	const paths = [...touched];
	const cache = new Map<string, NameLookupSensitivity>();
	for (let left = 0; left < paths.length; left++) {
		for (let right = 0; right < paths.length; right++) {
			if (left === right) continue;
			const ancestor = paths[left];
			const descendant = paths[right];
			if (ancestor === undefined || descendant === undefined) continue;
			if (isAncestorPath(ancestor, descendant)) {
				throw new Error(`Patch contains conflicting operations for ${descendant}`);
			}
			// Cheap candidate filter before any filesystem probe: only a pair that could be one file, or a
			// parent/child, under either axis needs a probe. An ordinary multi-file Add or Move never
			// lists a directory, so execute-only parents still accept normal patches.
			const foldedAllAncestor = foldAll(ancestor);
			const foldedAllDescendant = foldAll(descendant);
			if (foldedAllAncestor !== foldedAllDescendant && !isAncestorPath(foldedAllAncestor, foldedAllDescendant)) {
				continue;
			}
			const directory = await existingDirectoryFor(path.dirname(ancestor));
			const sensitivity = await lookupSensitivity(directory, cache);
			const foldedAncestor = foldName(ancestor, sensitivity);
			const foldedDescendant = foldName(descendant, sensitivity);
			if (foldedAncestor === foldedDescendant || isAncestorPath(foldedAncestor, foldedDescendant)) {
				throw new Error(`Patch contains conflicting operations for ${descendant}`);
			}
		}
	}
}

export async function planPatch(cwd: string, patchText: string, signal?: AbortSignal): Promise<PatchPlan> {
	signal?.throwIfAborted();
	const operations = parsePatch(patchText);
	const changes: PlannedFileChange[] = [];

	for (const operation of operations) {
		signal?.throwIfAborted();
		const resolved = await resolvePatchPathDetailed(cwd, operation.path);
		const absolutePath = resolved.absolute;
		const lexicalPath = resolved.lexical;
		const state = await readState(absolutePath);
		// Identity is separate from the operational path: existing files use realpath, missing files
		// keep their exact spelling. Potential case and normalization aliases are handled in one pass
		// after planning, so a normal add never causes a directory listing.
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
					lexicalPath,
					lexicalTargetPath: lexicalPath,
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
					lexicalPath,
					lexicalTargetPath: lexicalPath,
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
		let lexicalTargetPath = lexicalPath;
		let identityTargetPath = identityPath;
		if (operation.moveTo !== undefined) {
			const resolvedTarget = await resolvePatchPathDetailed(cwd, targetPath);
			// `absolutePath` is the parent-resolved source spelling. Only a literal rename-to-self keeps
			// the in-place behavior; any other spelling of an existing file is still a rejected target,
			// including case-insensitive or normalization aliases of the source itself.
			if (resolvedTarget.absolute !== absolutePath) {
				if (await readState(resolvedTarget.absolute)) throw new Error(`Move target already exists: ${targetPath}`);
				absoluteTargetPath = resolvedTarget.absolute;
				lexicalTargetPath = resolvedTarget.lexical;
				identityTargetPath = resolvedTarget.absolute;
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
				lexicalPath,
				lexicalTargetPath,
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
	await assertNoNameAliasConflicts(changes);
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

async function writeAtomic(
	absolutePath: string,
	content: Buffer,
	mode?: number,
	onRenamed?: () => void,
): Promise<void> {
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
		// Record the mutation immediately after the rename settles, before any later await can throw.
		onRenamed?.();
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

interface MutationState {
	targetWritten: boolean;
	sourceRemoved: boolean;
}

interface AppliedChange extends MutationState {
	change: PlannedFileChange;
}

async function applyChange(change: PlannedFileChange, state: MutationState): Promise<void> {
	if (change.operation === "delete") {
		await unlink(change.absolutePath);
		state.sourceRemoved = true;
		return;
	}
	if (!change.after) throw new Error(`Missing planned content for ${change.targetPath}`);
	await writeAtomic(change.absoluteTargetPath, change.after, change.mode, () => {
		state.targetWritten = true;
	});
	if (change.operation === "move" && change.absoluteTargetPath !== change.absolutePath) {
		await unlink(change.absolutePath);
		state.sourceRemoved = true;
	}
}

/**
 * Undo only the filesystem steps that actually completed. A failed write that never renamed the
 * target left it untouched, so restoring it would needlessly replace the inode and break hardlinks.
 */
async function rollbackChange(applied: AppliedChange): Promise<void> {
	const { change, targetWritten, sourceRemoved } = applied;
	if (change.operation === "delete") {
		if (sourceRemoved && change.before !== undefined) {
			await writeAtomic(change.absolutePath, change.before, change.mode);
		}
		return;
	}
	if (change.absoluteTargetPath === change.absolutePath) {
		if (!targetWritten) return;
		if (change.before === undefined) await rm(change.absoluteTargetPath, { force: true });
		else await writeAtomic(change.absolutePath, change.before, change.mode);
		return;
	}
	// Move: the source unlink may have failed, leaving the source intact, in which case only the
	// destination copy must go and no source rewrite is needed. If the source was removed it may be
	// gone and the destination can be the only surviving copy, so restore the source before removing
	// the destination; a failed restore must never delete that destination.
	if (sourceRemoved) {
		if (change.before !== undefined) await writeAtomic(change.absolutePath, change.before, change.mode);
		await rm(change.absoluteTargetPath, { force: true });
		return;
	}
	if (targetWritten) await rm(change.absoluteTargetPath, { force: true });
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
 * path (`realpath` fails), so an absent source or target must lock its submitted lexical spelling,
 * not the canonical parent-resolved path. Existing files key on realpath, which `identityPath` holds.
 */
function mutationQueueKeys(change: PlannedFileChange): string[] {
	const source = change.before === undefined ? change.lexicalPath : change.identityPath;
	if (change.absoluteTargetPath === change.absolutePath) return [source];
	return [source, change.lexicalTargetPath];
}

/**
 * Resolve the exact keys Pi's mutation queue will use. An existing path keys on its realpath and a
 * still-missing path on its lexical spelling. Using that key directly keeps concurrent plans in
 * agreement on lock order, so a symlink alias cannot yield two keys for one native queue and a
 * missing target that appears after planning (drift) cannot invert another plan's lock order.
 */
async function resolveQueueKeys(plan: PatchPlan): Promise<string[]> {
	const keys = new Set<string>();
	for (const change of plan.changes) {
		for (const key of mutationQueueKeys(change)) {
			keys.add((await resolveExistingIdentity(key)) ?? key);
		}
	}
	return [...keys].sort();
}

export async function applyPatchPlan(plan: PatchPlan, signal?: AbortSignal): Promise<void> {
	const paths = await resolveQueueKeys(plan);

	await withQueues(paths, 0, async () => {
		signal?.throwIfAborted();
		await validatePlanState(plan);
		const applied: AppliedChange[] = [];
		let current: AppliedChange | undefined;
		try {
			for (const change of plan.changes) {
				// Check before marking a change in flight: an abort here has nothing to roll back.
				signal?.throwIfAborted();
				current = { change, targetWritten: false, sourceRemoved: false };
				await applyChange(change, current);
				// The filesystem operation has settled; an abort during it must still undo this change.
				signal?.throwIfAborted();
				applied.push(current);
				current = undefined;
			}
		} catch (error) {
			const rollbackFailures: string[] = [];
			if (current) {
				try {
					await rollbackChange(current);
				} catch (rollbackError) {
					rollbackFailures.push(`${current.change.targetPath}: ${describeError(rollbackError)}`);
				}
			}
			for (const item of [...applied].reverse()) {
				try {
					await rollbackChange(item);
				} catch (rollbackError) {
					rollbackFailures.push(`${item.change.targetPath}: ${describeError(rollbackError)}`);
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
