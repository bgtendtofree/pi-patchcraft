import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePatchPath } from "../src/paths.ts";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-patchcraft-paths-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolvePatchPath", () => {
	it("resolves a relative path through its real parent", async () => {
		const cwd = await workspace();
		assert.equal(await resolvePatchPath(cwd, "nested/new.txt"), path.join(await realpath(cwd), "nested/new.txt"));
	});

	it("strips a leading @ prefix", async () => {
		const cwd = await workspace();
		assert.equal(await resolvePatchPath(cwd, "@value.txt"), path.join(await realpath(cwd), "value.txt"));
	});

	it("expands home-relative paths", async () => {
		const cwd = await workspace();
		assert.equal(await resolvePatchPath(cwd, "~/value.txt"), path.join(await realpath(os.homedir()), "value.txt"));
		assert.equal(await resolvePatchPath(cwd, "~"), await realpath(os.homedir()));
	});

	it("accepts file:// URLs", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		assert.equal(await resolvePatchPath(cwd, pathToFileURL(target).href), path.join(await realpath(cwd), "value.txt"));
	});
});
