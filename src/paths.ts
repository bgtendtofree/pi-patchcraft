import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function tryLstat(target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	try {
		return await lstat(target);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function flipCase(value: string): string {
	return value.replace(/[a-zA-Z]/g, (character) =>
		character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
	);
}

/**
 * Name spellings a case-insensitive filesystem may equate. Kept separate from Unicode
 * normalization: a case-sensitive APFS is still normalization-insensitive, and vice versa.
 */
function caseVariants(name: string): string[] {
	const variants = new Set<string>();
	const lower = name.toLowerCase();
	if (lower !== name) variants.add(lower);
	const flipped = flipCase(name);
	if (flipped !== name) variants.add(flipped);
	return [...variants];
}

/** Name spellings a Unicode-normalization-insensitive filesystem may equate (NFC covers canonical equivalence). */
function normalizationVariants(name: string): string[] {
	const variants = new Set<string>();
	for (const form of ["NFC", "NFD"] as const) {
		const normalized = name.normalize(form);
		if (normalized !== name) variants.add(normalized);
	}
	return [...variants];
}

function isSameEntry(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
	return left.ino === right.ino && left.dev === right.dev;
}

/**
 * Read-only, stateless probe for one name-lookup axis on the filesystem holding `directory`. A name
 * is equated only when a variant resolves to the same inode, so a filesystem that truly distinguishes
 * a spelling reports `false`. Returns `undefined` when no existing name exercises the axis, so a
 * caller can fail closed instead of borrowing the other axis' answer. Never creates a file.
 */
async function probeNameAliasing(
	directory: string,
	variants: (name: string) => string[],
): Promise<boolean | undefined> {
	try {
		let entries: string[] | undefined;
		try {
			entries = await readdir(directory);
		} catch {
			entries = undefined;
		}
		for (const entry of entries ?? []) {
			const names = variants(entry);
			if (names.length === 0) continue;
			const original = await tryLstat(path.join(directory, entry));
			if (!original) continue;
			// One decisive observation settles the whole directory.
			for (const variant of names) {
				const alternative = await tryLstat(path.join(directory, variant));
				if (alternative !== undefined && isSameEntry(original, alternative)) return true;
			}
			return false;
		}
		// Fall back to the directory's own name. Stay on the same device: across a mount boundary the
		// parent filesystem says nothing about this one. A variant that does not alias proves the
		// filesystem is sensitive for that spelling; a name with no variant leaves the axis unknown.
		let current = directory;
		let currentStats = await tryLstat(current);
		while (currentStats && current !== path.dirname(current)) {
			const parent = path.dirname(current);
			const parentStats = await tryLstat(parent);
			if (!parentStats || parentStats.dev !== currentStats.dev) return undefined;
			for (const variant of variants(path.basename(current))) {
				const alternative = await tryLstat(path.join(parent, variant));
				if (alternative === undefined) return false;
				if (currentStats.ino === alternative.ino && currentStats.dev === alternative.dev) return true;
			}
			current = parent;
			currentStats = parentStats;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Case-insensitive name lookup only; `undefined` when no existing name exercises case. */
export async function directoryUsesCaseInsensitiveNames(directory: string): Promise<boolean | undefined> {
	return probeNameAliasing(directory, caseVariants);
}

/** Unicode-normalization-insensitive name lookup only; `undefined` when no existing name exercises it. */
export async function directoryUsesNormalizationInsensitiveNames(directory: string): Promise<boolean | undefined> {
	return probeNameAliasing(directory, normalizationVariants);
}

/**
 * Canonical identity for an existing path, or `undefined` when it does not exist.
 *
 * Used for conflict checks and mutation-queue keys so case-insensitive filesystem aliases of one
 * existing file collapse to a single identity instead of two separate locks.
 */
export async function resolveExistingIdentity(absolutePath: string): Promise<string | undefined> {
	try {
		return await realpath(absolutePath);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

export interface ResolvedPatchPath {
	/** Canonical path: the deepest existing ancestor's realpath plus the missing suffix. */
	absolute: string;
	/** Lexical path (`path.resolve(cwd, value)`) before any parent realpath, i.e. the submitted spelling. */
	lexical: string;
}

/**
 * Resolve both the canonical and the submitted (lexical) spelling of a patch path.
 *
 * Pi's mutation queue keys a not-yet-created target on its lexical resolved path (`realpath`
 * fails), so Patchcraft must remember the same spelling to share that queue instead of locking on a
 * canonical path Pi never uses for a missing file.
 */
export async function resolvePatchPathDetailed(cwd: string, input: string): Promise<ResolvedPatchPath> {
	let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (!value) throw new Error("Patch path is empty");
	if (value.includes("\0")) throw new Error("Patch path contains NUL");
	if (value === "~") value = os.homedir();
	else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		value = path.join(os.homedir(), value.slice(2));
	}
	if (value.startsWith("file://")) value = fileURLToPath(value);
	const lexical = path.resolve(cwd, value);
	let parent = path.dirname(lexical);
	while (true) {
		try {
			return {
				absolute: path.join(
					await realpath(parent),
					path.relative(parent, path.dirname(lexical)),
					path.basename(lexical),
				),
				lexical,
			};
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
				throw error;
			}
			const next = path.dirname(parent);
			if (next === parent) throw error;
			parent = next;
		}
	}
}

export async function resolvePatchPath(cwd: string, input: string): Promise<string> {
	return (await resolvePatchPathDetailed(cwd, input)).absolute;
}
