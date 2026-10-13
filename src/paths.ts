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

function isSameEntry(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
	return left.ino === right.ino && left.dev === right.dev;
}

/**
 * Read-only, stateless probe for case-insensitive name lookup on the filesystem holding
 * `directory`.
 *
 * Returns `undefined` when it cannot decide (for example an unreadable mount root), so a caller can
 * fail closed only for a genuinely ambiguous potential conflict. It never creates a probe file and
 * never mutates anything.
 */
export async function directoryUsesCaseInsensitiveNames(directory: string): Promise<boolean | undefined> {
	try {
		let entries: string[] | undefined;
		try {
			entries = await readdir(directory);
		} catch {
			entries = undefined;
		}
		for (const entry of entries ?? []) {
			const flipped = flipCase(entry);
			if (flipped === entry) continue;
			const original = await tryLstat(path.join(directory, entry));
			if (!original) continue;
			const alternative = await tryLstat(path.join(directory, flipped));
			return alternative !== undefined && isSameEntry(original, alternative);
		}
		// Fall back to the directory's own name. Stay on the same device: across a mount boundary the
		// parent filesystem says nothing about this one.
		let current = directory;
		let currentStats = await tryLstat(current);
		while (currentStats && current !== path.dirname(current)) {
			const parent = path.dirname(current);
			const parentStats = await tryLstat(parent);
			if (!parentStats || parentStats.dev !== currentStats.dev) return undefined;
			const name = path.basename(current);
			const flipped = flipCase(name);
			if (flipped !== name) {
				const alternative = await tryLstat(path.join(parent, flipped));
				if (alternative === undefined) return false;
				return currentStats.ino === alternative.ino && currentStats.dev === alternative.dev;
			}
			current = parent;
			currentStats = parentStats;
		}
		return undefined;
	} catch {
		return undefined;
	}
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
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function resolvePatchPath(cwd: string, input: string): Promise<string> {
	let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (!value) throw new Error("Patch path is empty");
	if (value.includes("\0")) throw new Error("Patch path contains NUL");
	if (value === "~") value = os.homedir();
	else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		value = path.join(os.homedir(), value.slice(2));
	}
	if (value.startsWith("file://")) value = fileURLToPath(value);
	const absolute = path.resolve(cwd, value);
	let parent = path.dirname(absolute);
	while (true) {
		try {
			return path.join(await realpath(parent), path.relative(parent, path.dirname(absolute)), path.basename(absolute));
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
