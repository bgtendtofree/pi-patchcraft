import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class PatchPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchPathError";
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function findExistingAncestor(candidate: string, root: string): Promise<string> {
	let current = candidate;
	while (isInside(root, current)) {
		try {
			await stat(current);
			return current;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new PatchPathError(`Patch path escapes workspace: ${candidate}`);
}

export async function resolvePatchPath(cwd: string, input: string): Promise<string> {
	const value = input.startsWith("@") ? input.slice(1) : input;
	if (!value) throw new PatchPathError("Patch path is empty");
	if (value.includes("\0")) throw new PatchPathError("Patch path contains NUL");
	if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
		throw new PatchPathError(`Absolute patch paths are not allowed: ${input}`);
	}

	const root = await realpath(cwd);
	const candidate = path.resolve(root, value);
	if (!isInside(root, candidate)) throw new PatchPathError(`Patch path escapes workspace: ${input}`);

	const ancestor = await findExistingAncestor(path.dirname(candidate), root);
	const realAncestor = await realpath(ancestor);
	if (!isInside(root, realAncestor)) throw new PatchPathError(`Patch path escapes workspace through symlink: ${input}`);

	try {
		const targetStats = await lstat(candidate);
		if (targetStats.isSymbolicLink()) {
			const realTarget = await realpath(candidate);
			if (!isInside(root, realTarget)) {
				throw new PatchPathError(`Patch path escapes workspace through symlink: ${input}`);
			}
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}

	return candidate;
}
