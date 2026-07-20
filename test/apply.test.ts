import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyPatchPlan, planPatch } from "../src/apply.ts";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-patchcraft-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("patch planning and application", () => {
	it("applies a multi-file patch", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "update.txt"), "before\n");
		await writeFile(path.join(cwd, "delete.txt"), "gone\n");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: update.txt
@@
-before
+after
*** Delete File: delete.txt
*** End Patch`,
		);
		assert.equal(plan.changes.length, 3);
		assert.equal(plan.added, 2);
		assert.equal(plan.removed, 2);

		const result = await applyPatchPlan(plan);
		assert.equal(result.files.length, 3);
		assert.equal(await readFile(path.join(cwd, "nested/new.txt"), "utf8"), "created\n");
		assert.equal(await readFile(path.join(cwd, "update.txt"), "utf8"), "after\n");
		await assert.rejects(readFile(path.join(cwd, "delete.txt")));
	});

	it("supports contextual fuzzy matching and moves", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "old.txt"), "class A {\n  name = “old”  \n}\n");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Update File: old.txt
*** Move to: nested/new.txt
@@ class A {
-  name = "old"
+  name = "new"
*** End Patch`,
		);
		assert.equal(plan.fuzz, 10000);
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "nested/new.txt"), "utf8"), 'class A {\n  name = "new"\n}\n');
		await assert.rejects(readFile(path.join(cwd, "old.txt")));
	});

	it("inserts pure additions after context instead of at end of file", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\nmarker\nafter\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@ marker\n+inserted\n*** End Patch",
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(target, "utf8"), "before\nmarker\ninserted\nafter\n");
	});

	it("preserves patch order for pure additions at the same position", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "base\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n+first\n@@\n+second\n*** End Patch",
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(target, "utf8"), "base\nfirst\nsecond\n");
	});

	it("preserves line endings and final newline state", async () => {
		const cwd = await workspace();
		const crlfTarget = path.join(cwd, "crlf.txt");
		const noFinalNewlineTarget = path.join(cwd, "no-final-newline.txt");
		await writeFile(crlfTarget, "before\r\nafter\r\n");
		await writeFile(noFinalNewlineTarget, "before\nafter");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Update File: crlf.txt
@@
-before
+changed
*** Update File: no-final-newline.txt
@@
-after
+changed
*** End Patch`,
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(crlfTarget, "utf8"), "changed\r\nafter\r\n");
		assert.equal(await readFile(noFinalNewlineTarget, "utf8"), "before\nchanged");
	});

	it("rejects traversal and symlink escapes", async () => {
		const cwd = await workspace();
		const outside = await workspace();
		await symlink(outside, path.join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch"),
			/escapes workspace/,
		);
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Add File: link/outside.txt\n+x\n*** End Patch"),
			/escapes workspace through symlink/,
		);
	});

	it("rejects precondition failures and conflicting paths", async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "dir"));
		await writeFile(path.join(cwd, "existing.txt"), "x\n");
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Add File: existing.txt\n+y\n*** End Patch"),
			/already exists/,
		);
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"),
			/does not exist/,
		);
		await assert.rejects(planPatch(cwd, "*** Begin Patch\n*** Delete File: dir\n*** End Patch"), /not a regular file/);
	});

	it("detects source changes between planning and apply", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		await writeFile(target, "concurrent\n");
		await assert.rejects(applyPatchPlan(plan), /changed before apply/);
		assert.equal(await readFile(target, "utf8"), "concurrent\n");
	});
});
