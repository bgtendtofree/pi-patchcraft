import assert from "node:assert/strict";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { planPatch as openPlan } from "../src/client.ts";

const temporaryDirectories: string[] = [];
const plans: Awaited<ReturnType<typeof openPlan>>[] = [];

async function planPatch(cwd: string, patch: string) {
	const plan = await openPlan(cwd, patch);
	plans.push(plan);
	return plan;
}

function applyPatchPlan(plan: Awaited<ReturnType<typeof openPlan>>, signal?: AbortSignal) {
	return plan.apply(signal);
}

async function workspace(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-patchcraft-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(plans.splice(0).map((plan) => plan.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function isCaseInsensitive(directory: string): Promise<boolean> {
	await writeFile(path.join(directory, "case-probe.txt"), "probe\n");
	try {
		await stat(path.join(directory, "CASE-PROBE.TXT"));
		return true;
	} catch {
		return false;
	}
}

/** Probe on a throwaway workspace so a normalization probe never pollutes the test directory. */
async function isNormalizationInsensitive(): Promise<boolean> {
	const directory = await workspace();
	await writeFile(path.join(directory, "caf\u00e9-probe.txt"), "probe\n");
	try {
		await stat(path.join(directory, "cafe\u0301-probe.txt"));
		return true;
	} catch {
		return false;
	}
}

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
		assert.match(plan.changes[1]?.displayDiff ?? "", /-1 before/);
		assert.match(plan.changes[1]?.displayDiff ?? "", /\+1 after/);

		await applyPatchPlan(plan);
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

	it("appends context-less additions at end of file like Codex", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\nmarker\nafter\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@ marker\n+inserted\n*** End Patch",
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(target, "utf8"), "before\nmarker\nafter\ninserted\n");
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

	it("inserts into an empty file and adds a trailing newline like Codex", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "empty.txt");
		await writeFile(target, "");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Update File: empty.txt\n@@\n+hello\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal(await readFile(target, "utf8"), "hello\n");
	});

	it("preserves line endings and adds a trailing newline like Codex", async () => {
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
		assert.equal(await readFile(noFinalNewlineTarget, "utf8"), "before\nchanged\n");
	});

	it("treats a leading BOM as part of the first line, like Codex", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "bom.txt");
		await writeFile(target, "\uFEFFbefore\nafter\n");
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Update File: bom.txt\n@@\n-before\n+changed\n*** End Patch"),
			/Failed to find expected lines/,
		);
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: bom.txt\n@@\n-\uFEFFbefore\n+\uFEFFchanged\n*** End Patch",
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(target, "utf8"), "\uFEFFchanged\nafter\n");
	});

	it("supports absolute, parent, and symlink paths like Pi file tools", async () => {
		const cwd = await workspace();
		const outside = await workspace();
		await symlink(outside, path.join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
		const absolute = path.join(outside, "absolute.txt");
		const parentName = `${path.basename(cwd)}-parent.txt`;
		const parent = path.join(path.dirname(cwd), parentName);
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: ${absolute}
+absolute
*** Add File: ../${parentName}
+parent
*** Add File: link/symlink.txt
+symlink
*** End Patch`,
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(absolute, "utf8"), "absolute\n");
		assert.equal(await readFile(parent, "utf8"), "parent\n");
		assert.equal(await readFile(path.join(outside, "symlink.txt"), "utf8"), "symlink\n");
		await rm(parent);
	});

	it("rejects operations targeting the same file through a symlinked parent", async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "real"));
		await symlink(path.join(cwd, "real"), path.join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
		const patch = `*** Begin Patch
*** Add File: real/nested/new.txt
+first
*** Add File: alias/nested/new.txt
+second
*** End Patch`;
		await assert.rejects(planPatch(cwd, patch), /conflicting operations/);
		await assert.rejects(readFile(path.join(cwd, "real/nested/new.txt")));
	});

	it("follows file symlinks for Add and Update and preserves the link", {
		skip: process.platform === "win32",
	}, async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "real.txt");
		const linkPath = path.join(cwd, "link.txt");
		await writeFile(target, "before\n");
		await symlink("real.txt", linkPath);

		const update = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: link.txt\n@@\n-before\n+after\n*** End Patch",
		);
		await applyPatchPlan(update);
		assert.equal(await readFile(target, "utf8"), "after\n");
		assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
		assert.equal(await readlink(linkPath), "real.txt");

		const overwrite = await planPatch(cwd, "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch");
		await applyPatchPlan(overwrite);
		assert.equal(await readFile(target, "utf8"), "created\n");
		assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
	});

	it("creates the target of a dangling file symlink on Add", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		const linkPath = path.join(cwd, "link.txt");
		await symlink("missing.txt", linkPath);
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "missing.txt"), "utf8"), "created\n");
		assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
		assert.equal(await readlink(linkPath), "missing.txt");
	});

	it("resolves .. in a symlink target against the real directory chain", {
		skip: process.platform === "win32",
	}, async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "elsewhere/inner"), { recursive: true });
		await symlink(
			path.join(cwd, "elsewhere/inner"),
			path.join(cwd, "jump"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await writeFile(path.join(cwd, "target.txt"), "old\n");
		await writeFile(path.join(cwd, "elsewhere/target.txt"), "old\n");
		await symlink("jump/../target.txt", path.join(cwd, "link.txt"));
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Update File: link.txt\n@@\n-old\n+new\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "target.txt"), "utf8"), "old\n");
		assert.equal(await readFile(path.join(cwd, "elsewhere/target.txt"), "utf8"), "new\n");
		assert.equal(await readFile(path.join(cwd, "link.txt"), "utf8"), "new\n");
		assert.equal((await lstat(path.join(cwd, "link.txt"))).isSymbolicLink(), true);
	});

	it("rejects a symlink target that traverses a non-directory", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "regular-file"), "file\n");
		await writeFile(path.join(cwd, "target.txt"), "old\n");
		await symlink("regular-file/../target.txt", path.join(cwd, "link.txt"));
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch"),
			/ENOTDIR|not a directory/,
		);
		assert.equal(await readFile(path.join(cwd, "target.txt"), "utf8"), "old\n");
	});

	it("rejects a regular-file symlink target ending in a slash", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "target.txt"), "old\n");
		await symlink("target.txt/", path.join(cwd, "link.txt"));
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Update File: link.txt\n@@\n-old\n+new\n*** End Patch"),
			/ENOTDIR|not a directory/,
		);
		assert.equal(await readFile(path.join(cwd, "target.txt"), "utf8"), "old\n");
	});

	it("rejects a dangling symlink target that requires a directory", {
		skip: process.platform === "win32",
	}, async () => {
		const cwd = await workspace();
		await symlink("missing/", path.join(cwd, "link.txt"));
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch"),
			/requires a directory/,
		);
		await assert.rejects(stat(path.join(cwd, "missing")));
	});

	it("rejects a dangling symlink target with .. after a missing component", {
		skip: process.platform === "win32",
	}, async () => {
		const cwd = await workspace();
		await symlink("missing/../new.txt", path.join(cwd, "link.txt"));
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch"),
			/\.\." after a missing component/,
		);
		await assert.rejects(readFile(path.join(cwd, "new.txt")));
		await assert.rejects(stat(path.join(cwd, "missing")));
	});

	it("rejects conflicts through a dangling link target under a symlinked parent", {
		skip: process.platform === "win32",
	}, async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "real"));
		await symlink(path.join(cwd, "real"), path.join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
		await writeFile(path.join(cwd, "source.txt"), "precious\n");
		await symlink("alias/new.txt", path.join(cwd, "link.txt"));

		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Update File: source.txt
*** Move to: real/new.txt
@@
 precious
*** Add File: link.txt
+second
*** End Patch`,
			),
			/conflicting operations/,
		);
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: link.txt
+first
*** Add File: real/new.txt
+second
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "precious\n");
		await assert.rejects(readFile(path.join(cwd, "real/new.txt")));

		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "real/new.txt"), "utf8"), "created\n");
		assert.equal((await lstat(path.join(cwd, "link.txt"))).isSymbolicLink(), true);
	});

	it("refuses Delete and Move through a file symlink", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "real.txt");
		const linkPath = path.join(cwd, "link.txt");
		await writeFile(target, "value\n");
		await symlink("real.txt", linkPath);
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Delete File: link.txt\n*** End Patch"),
			/Delete File does not follow symbolic links/,
		);
		await assert.rejects(
			planPatch(
				cwd,
				"*** Begin Patch\n*** Update File: link.txt\n*** Move to: moved.txt\n@@\n-value\n+changed\n*** End Patch",
			),
			/Move does not follow symbolic links/,
		);
		assert.equal(await readFile(target, "utf8"), "value\n");
		assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
	});

	it("rejects a file symlink retargeted between planning and apply", {
		skip: process.platform === "win32",
	}, async () => {
		const cwd = await workspace();
		const first = path.join(cwd, "first.txt");
		const second = path.join(cwd, "second.txt");
		const linkPath = path.join(cwd, "link.txt");
		await writeFile(first, "first\n");
		await writeFile(second, "second\n");
		await symlink("first.txt", linkPath);
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: link.txt\n@@\n-first\n+changed\n*** End Patch",
		);
		await rm(linkPath);
		await symlink("second.txt", linkPath);
		await assert.rejects(applyPatchPlan(plan), /source link changed before apply/);
		assert.equal(await readFile(first, "utf8"), "first\n");
		assert.equal(await readFile(second, "utf8"), "second\n");
	});

	it("rejects oversized patches and sources before mutation", async () => {
		const cwd = await workspace();
		const hugePatch = `*** Begin Patch\n*** Add File: huge.txt\n+${"a".repeat(1024 * 1024)}\n*** End Patch`;
		await assert.rejects(planPatch(cwd, hugePatch), /Patch is too large/);
		await assert.rejects(readFile(path.join(cwd, "huge.txt")));

		const target = path.join(cwd, "large.txt");
		await writeFile(target, "value\n");
		await truncate(target, 64 * 1024 * 1024 + 1);
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Update File: large.txt\n@@\n-value\n+changed\n*** End Patch"),
			/Patch source is too large/,
		);
	});

	it("rejects duplicate resolved paths and repeated headers like Codex", async () => {
		const cwd = await workspace();
		// openai/codex#37867: `duplicate.txt` and `./duplicate.txt` resolve to the same file.
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: duplicate.txt
+first
*** Add File: ./duplicate.txt
+second
*** End Patch`,
			),
			/conflicting operations/,
		);
		await writeFile(path.join(cwd, "update.txt"), "before\n");
		// Codex rejects a second `*** Update File:` header for the same path; multiple hunks belong
		// in one Update File block as stacked `@@` chunks.
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Update File: update.txt
@@
-before
+one
*** Update File: update.txt
@@
-before
+two
*** End Patch`,
			),
			/conflicting operations.*one \*\*\* Update File: header/,
		);
		assert.equal(await readFile(path.join(cwd, "update.txt"), "utf8"), "before\n");
	});

	it("creates or overwrites a file with Add File like Codex, capturing old content", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "existing.txt");
		await writeFile(target, "old\n");
		const overwrite = await planPatch(cwd, "*** Begin Patch\n*** Add File: existing.txt\n+new\n*** End Patch");
		assert.match(overwrite.changes[0]?.displayDiff ?? "", /-1 old/);
		assert.equal(await readFile(target, "utf8"), "old\n");
		await applyPatchPlan(overwrite);
		assert.equal(await readFile(target, "utf8"), "new\n");

		const create = await planPatch(cwd, "*** Begin Patch\n*** Add File: fresh.txt\n+fresh\n*** End Patch");
		assert.equal(create.changes[0]?.removed, 0);
		await applyPatchPlan(create);
		assert.equal(await readFile(path.join(cwd, "fresh.txt"), "utf8"), "fresh\n");
	});

	it("rejects precondition failures and conflicting paths", async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "dir"));
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

	it("detects add targets created between planning and apply", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "new.txt");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: new.txt\n+planned\n*** End Patch");
		await writeFile(target, "concurrent\n");
		await assert.rejects(applyPatchPlan(plan), /target changed before apply/);
		assert.equal(await readFile(target, "utf8"), "concurrent\n");
	});

	it("detects move targets created between planning and apply", async () => {
		const cwd = await workspace();
		const source = path.join(cwd, "source.txt");
		const target = path.join(cwd, "target.txt");
		await writeFile(source, "source\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n@@\n source\n*** End Patch",
		);
		await writeFile(target, "concurrent\n");
		await assert.rejects(applyPatchPlan(plan), /target changed before apply/);
		assert.equal(await readFile(source, "utf8"), "source\n");
		assert.equal(await readFile(target, "utf8"), "concurrent\n");
	});

	it("detects deleted sources between planning and apply", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "delete.txt");
		await writeFile(target, "planned\n");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Delete File: delete.txt\n*** End Patch");
		await rm(target);
		await assert.rejects(applyPatchPlan(plan), /source changed before apply/);
	});

	it("preserves executable mode when updating files", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "script.sh");
		await writeFile(target, "old\n");
		await chmod(target, 0o755);
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Update File: script.sh\n@@\n-old\n+new\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal((await stat(target)).mode & 0o777, 0o755);
	});

	it("preserves executable mode when moving files", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		const source = path.join(cwd, "source.sh");
		const target = path.join(cwd, "target.sh");
		await writeFile(source, "echo test\n");
		await chmod(source, 0o755);
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: source.sh\n*** Move to: target.sh\n@@\n echo test\n*** End Patch",
		);
		await applyPatchPlan(plan);
		assert.equal((await stat(target)).mode & 0o777, 0o755);
		await assert.rejects(stat(source));
	});

	it("preserves a restrictive mode when updating", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "secret.txt");
		await writeFile(target, "old\n");
		await chmod(target, 0o600);
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Update File: secret.txt\n@@\n-old\n+new\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal((await stat(target)).mode & 0o777, 0o600);
		assert.equal(await readFile(target, "utf8"), "new\n");
	});

	it("rejects case-insensitive aliases of one existing file before locking", async (t) => {
		const cwd = await workspace();
		if (!(await isCaseInsensitive(cwd))) {
			t.skip("case-sensitive filesystem");
			return;
		}
		await writeFile(path.join(cwd, "a.txt"), "old\n");
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Update File: a.txt
@@
-old
+one
*** Update File: A.txt
@@
-old
+two
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "old\n");
	});

	it("rejects a move to another case spelling of one existing file", async (t) => {
		const cwd = await workspace();
		if (!(await isCaseInsensitive(cwd))) {
			t.skip("case-sensitive filesystem");
			return;
		}
		await writeFile(path.join(cwd, "a.txt"), "old\n");
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Update File: A.txt
*** Move to: a.txt
@@
-old
+new
*** End Patch`,
			),
			/Move target already exists/,
		);
		assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "old\n");
		assert.equal((await readdir(cwd)).filter((name) => name.toLowerCase() === "a.txt").length, 1);
	});

	it("rejects case-insensitive aliases of a not-yet-created target", async (t) => {
		const cwd = await workspace();
		if (!(await isCaseInsensitive(cwd))) {
			t.skip("case-sensitive filesystem");
			return;
		}
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: fresh.txt
+first
*** Add File: FRESH.txt
+second
*** End Patch`,
			),
			/conflicting operations/,
		);
		// Planning is read-only detection: it must not have created or mutated anything.
		assert.deepEqual(await readdir(cwd), ["case-probe.txt"]);
	});

	it("rejects a move destination that aliases a pending new target", async (t) => {
		const cwd = await workspace();
		if (!(await isCaseInsensitive(cwd))) {
			t.skip("case-sensitive filesystem");
			return;
		}
		const source = path.join(cwd, "source.txt");
		await writeFile(source, "old\n");
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: fresh.txt
+first
*** Update File: source.txt
*** Move to: FRESH.txt
@@
 old
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.equal(await readFile(source, "utf8"), "old\n");
		assert.deepEqual(
			(await readdir(cwd)).filter((name) => name.toLowerCase() === "fresh.txt"),
			[],
		);
	});

	it("keeps distinct case spellings on a case-sensitive filesystem", async (t) => {
		const cwd = await workspace();
		if (await isCaseInsensitive(cwd)) {
			t.skip("case-insensitive filesystem");
			return;
		}
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: a.txt
+lower
*** Add File: A.txt
+upper
*** End Patch`,
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "lower\n");
		assert.equal(await readFile(path.join(cwd, "A.txt"), "utf8"), "upper\n");
	});

	it("rejects Unicode normalization aliases of not-yet-created move destinations", async (t) => {
		const cwd = await workspace();
		if (!(await isNormalizationInsensitive())) {
			t.skip("normalization-sensitive filesystem");
			return;
		}
		await writeFile(path.join(cwd, "first.txt"), "FIRST\n");
		await writeFile(path.join(cwd, "second.txt"), "SECOND\n");
		// The destinations live in a directory that does not exist yet; both spellings normalize to
		// one file on this filesystem, so accepting them would silently drop the first move's content.
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Update File: first.txt
*** Move to: nested/caf\u00e9.txt
@@
 FIRST
*** Update File: second.txt
*** Move to: nested/cafe\u0301.txt
@@
 SECOND
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.equal(await readFile(path.join(cwd, "first.txt"), "utf8"), "FIRST\n");
		assert.equal(await readFile(path.join(cwd, "second.txt"), "utf8"), "SECOND\n");
		assert.deepEqual(await readdir(cwd), ["first.txt", "second.txt"]);
	});

	it("rejects Unicode normalization aliases of not-yet-created Add targets", async (t) => {
		const cwd = await workspace();
		if (!(await isNormalizationInsensitive())) {
			t.skip("normalization-sensitive filesystem");
			return;
		}
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: caf\u00e9.txt
+first
*** Add File: cafe\u0301.txt
+second
*** End Patch`,
			),
			/conflicting operations/,
		);
		// Planning is read-only detection: it must not have created anything.
		assert.deepEqual(await readdir(cwd), []);
	});

	it("rejects Unicode normalization aliases of one existing file", async (t) => {
		const cwd = await workspace();
		if (!(await isNormalizationInsensitive())) {
			t.skip("normalization-sensitive filesystem");
			return;
		}
		await writeFile(path.join(cwd, "caf\u00e9.txt"), "old\n");
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Update File: caf\u00e9.txt
@@
-old
+one
*** Update File: cafe\u0301.txt
@@
-old
+two
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.equal(await readFile(path.join(cwd, "caf\u00e9.txt"), "utf8"), "old\n");
	});

	it("keeps distinct Unicode spellings when normalization sensitivity is proven", async (t) => {
		const cwd = await workspace();
		if (await isNormalizationInsensitive()) {
			t.skip("normalization-insensitive filesystem");
			return;
		}
		// Give the read-only probe a non-ASCII entry so normalization sensitivity is decidable instead
		// of unknown; an unknown axis must fail closed and would reject these distinct names.
		await writeFile(path.join(cwd, "probe-caf\u00e9.txt"), "probe\n");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: caf\u00e9.txt
+composed
*** Add File: cafe\u0301.txt
+decomposed
*** End Patch`,
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "caf\u00e9.txt"), "utf8"), "composed\n");
		assert.equal(await readFile(path.join(cwd, "cafe\u0301.txt"), "utf8"), "decomposed\n");
	});

	it("rejects a touched file that is an ancestor directory of another file before writing", async () => {
		const cwd = await workspace();
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: folder
+data
*** Add File: folder/child.txt
+child
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.deepEqual(await readdir(cwd), []);
	});

	it("rejects an ancestor conflict for a `..`-prefixed basename", async () => {
		const cwd = await workspace();
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: folder
+data
*** Add File: folder/..child.txt
+child
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.deepEqual(await readdir(cwd), []);
	});

	it("keeps distinct sibling names that share a raw prefix", async () => {
		const cwd = await workspace();
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: foo
+one
*** Add File: foobar/x.txt
+two
*** End Patch`,
		);
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(cwd, "foo"), "utf8"), "one\n");
		assert.equal(await readFile(path.join(cwd, "foobar/x.txt"), "utf8"), "two\n");
	});

	it("rejects a case alias of an ancestor directory on an insensitive filesystem", async (t) => {
		const cwd = await workspace();
		if (!(await isCaseInsensitive(cwd))) {
			t.skip("case-sensitive filesystem");
			return;
		}
		await assert.rejects(
			planPatch(
				cwd,
				`*** Begin Patch
*** Add File: Folder
+data
*** Add File: folder/child.txt
+child
*** End Patch`,
			),
			/conflicting operations/,
		);
		assert.deepEqual(await readdir(cwd), ["case-probe.txt"]);
	});

	it("shares Pi's mutation queue for a not-yet-existing file under a symlink cwd", async () => {
		const root = await workspace();
		const real = path.join(root, "real");
		const cwd = path.join(root, "logical");
		await mkdir(real);
		await symlink(real, cwd, process.platform === "win32" ? "junction" : "dir");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: Fresh.txt\n+value\n*** End Patch");
		// Pi keys the native queue on the submitted lexical path when the target is missing, not the
		// canonical parent-resolved path. Holding the same spelling must serialize Patchcraft behind it.
		const target = path.join(cwd, "Fresh.txt");
		let completedWhileHeld = false;
		let applying: Promise<void> | undefined;
		await withFileMutationQueue(target, async () => {
			let done = false;
			applying = applyPatchPlan(plan).then(() => {
				done = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			completedWhileHeld = done;
		});
		assert.ok(applying);
		await applying;
		assert.equal(completedWhileHeld, false);
		assert.equal(await readFile(path.join(cwd, "Fresh.txt"), "utf8"), "value\n");
	});

	it("shares Pi's mutation queue through a symlinked parent for a missing target", async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "real"));
		await symlink(path.join(cwd, "real"), path.join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: alias/new.txt\n+value\n*** End Patch");
		// The canonical parent-resolved plan path differs from the submitted spelling; the submitted
		// lexical path is what Pi's queue and a concurrent writer actually use.
		const submitted = path.join(cwd, "alias/new.txt");
		let completedWhileHeld = false;
		let applying: Promise<void> | undefined;
		await withFileMutationQueue(submitted, async () => {
			let done = false;
			applying = applyPatchPlan(plan).then(() => {
				done = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			completedWhileHeld = done;
		});
		assert.ok(applying);
		await applying;
		assert.equal(completedWhileHeld, false);
		assert.equal(await readFile(path.join(cwd, "real/new.txt"), "utf8"), "value\n");
	});

	it("settles concurrent drifted plans that would otherwise invert lock order", async () => {
		const cwd = await workspace();
		await mkdir(path.join(cwd, "realA"));
		await mkdir(path.join(cwd, "realZ"));
		await symlink(path.join(cwd, "realA"), path.join(cwd, "zlink"), process.platform === "win32" ? "junction" : "dir");
		await symlink(path.join(cwd, "realZ"), path.join(cwd, "alink"), process.platform === "win32" ? "junction" : "dir");
		const linkPlan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: zlink/one.txt
+one
*** Add File: alink/two.txt
+two
*** End Patch`,
		);
		const directPlan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: realA/one.txt
+one
*** Add File: realZ/two.txt
+two
*** End Patch`,
		);
		// Drift: the targets now exist, so Pi keys their queues on canonical identities. The link plan's
		// submitted spellings sort opposite to the direct plan's, so lexical keys would deadlock here.
		await writeFile(path.join(cwd, "realA/one.txt"), "drift\n");
		await writeFile(path.join(cwd, "realZ/two.txt"), "drift\n");
		const settled = await Promise.race([
			Promise.allSettled([applyPatchPlan(linkPlan), applyPatchPlan(directPlan)]),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("deadlock")), 5000)),
		]);
		for (const result of settled) {
			assert.equal(result.status, "rejected");
			if (result.status === "rejected") assert.match(String(result.reason), /changed before apply/);
		}
	});

	it("rejects Unicode case aliases of move destinations on a case-insensitive host", async (t) => {
		const cwd = await workspace();
		const candidates = [
			["\u00df.txt", "SS.txt"],
			["\u1e9e.txt", "ss.txt"],
			["\u1e9e.txt", "\u00df.txt"],
		];
		const aliases: string[][] = [];
		for (const [left = "", right = ""] of candidates) {
			await writeFile(path.join(cwd, left), "probe\n");
			try {
				await stat(path.join(cwd, right));
				aliases.push([left, right]);
			} catch {
				// The host keeps this pair distinct; skip only that pair.
			}
			await rm(path.join(cwd, left));
		}
		if (aliases.length === 0) {
			t.skip("host does not fold these Unicode pairs");
			return;
		}

		await writeFile(path.join(cwd, "one.txt"), "FIRST\n");
		await writeFile(path.join(cwd, "two.txt"), "SECOND\n");
		for (const [left = "", right = ""] of aliases) {
			await assert.rejects(
				planPatch(
					cwd,
					`*** Begin Patch
*** Update File: one.txt
*** Move to: ${left}
@@
 FIRST
*** Update File: two.txt
*** Move to: ${right}
@@
 SECOND
*** End Patch`,
				),
				/conflicting operations/,
			);
		}
		assert.equal(await readFile(path.join(cwd, "one.txt"), "utf8"), "FIRST\n");
		assert.equal(await readFile(path.join(cwd, "two.txt"), "utf8"), "SECOND\n");
	});

	it("plans a lone add without listing an unreadable directory", { skip: process.platform === "win32" }, async (t) => {
		if (process.getuid?.() === 0) {
			t.skip("requires a non-root user for permission failures");
			return;
		}
		const cwd = await workspace();
		const directory = path.join(cwd, "nested");
		await mkdir(directory);
		await chmod(directory, 0o300);
		try {
			const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: nested/only.txt\n+value\n*** End Patch");
			await applyPatchPlan(plan);
		} finally {
			await chmod(directory, 0o700);
		}
		assert.equal(await readFile(path.join(directory, "only.txt"), "utf8"), "value\n");
	});

	it("keeps a leading space-only context line in an update hunk", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "old\n\nold\n");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Update File: value.txt\n \n-old\n+new\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal(await readFile(target, "utf8"), "old\n\nnew\n");
	});

	it("rejects a non-UTF-8 update source without mutating it", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "binary.txt");
		const original = Buffer.from("6f6c640ae90a", "hex");
		await writeFile(target, original);
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Update File: binary.txt\n@@\n-old\n+new\n*** End Patch"),
			/not valid UTF-8/,
		);
		assert.deepEqual(await readFile(target), original);
		assert.deepEqual(
			(await readdir(cwd)).filter((name) => name.startsWith(".patchcraft-")),
			[],
		);

		const overwrite = await planPatch(cwd, "*** Begin Patch\n*** Add File: binary.txt\n+new\n*** End Patch");
		await applyPatchPlan(overwrite);
		assert.equal(await readFile(target, "utf8"), "new\n");

		const remove = await planPatch(cwd, "*** Begin Patch\n*** Delete File: binary.txt\n*** End Patch");
		await applyPatchPlan(remove);
		await assert.rejects(readFile(target));
	});

	it("rejects permission drift between planning and apply", { skip: process.platform === "win32" }, async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\n");
		await chmod(target, 0o644);
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		await chmod(target, 0o600);
		await assert.rejects(applyPatchPlan(plan), /permissions changed before apply/);
		assert.equal((await stat(target)).mode & 0o777, 0o600);
		assert.equal(await readFile(target, "utf8"), "before\n");
	});

	it("removes a partially written move destination when the source unlink fails", {
		skip: process.platform === "win32",
	}, async (t) => {
		if (process.getuid?.() === 0) {
			t.skip("requires a non-root user for permission failures");
			return;
		}
		const cwd = await workspace();
		const sourceDirectory = path.join(cwd, "source");
		const targetDirectory = path.join(cwd, "target");
		await mkdir(sourceDirectory);
		await mkdir(targetDirectory);
		const source = path.join(sourceDirectory, "file.txt");
		await writeFile(source, "original\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: source/file.txt\n*** Move to: target/moved.txt\n@@\n original\n*** End Patch",
		);
		// The read-only source directory makes the unlink fail after the destination was written. The
		// source still holds the original inode, so rollback only removes the destination copy; it must
		// not rewrite the source, which the read-only directory would refuse.
		await chmod(sourceDirectory, 0o500);
		try {
			await assert.rejects(applyPatchPlan(plan), /All applied changes were rolled back/);
		} finally {
			await chmod(sourceDirectory, 0o700);
		}
		assert.equal(await readFile(source, "utf8"), "original\n");
		await assert.rejects(stat(path.join(targetDirectory, "moved.txt")));
	});

	it("refuses to overwrite a read-only file like Pi edit and Codex", {
		skip: process.platform === "win32",
	}, async (t) => {
		if (process.getuid?.() === 0) {
			t.skip("requires a non-root user for permission failures");
			return;
		}
		const cwd = await workspace();
		const target = path.join(cwd, "read-only.txt");
		await writeFile(target, "before\n");
		await chmod(target, 0o444);
		try {
			const plan = await planPatch(
				cwd,
				`*** Begin Patch
*** Add File: rolled-back.txt
+created first
*** Update File: read-only.txt
@@
-before
+after
*** End Patch`,
			);
			await assert.rejects(applyPatchPlan(plan), /permission denied[\s\S]*All applied changes were rolled back/i);
			assert.equal(await readFile(target, "utf8"), "before\n");
			await assert.rejects(stat(path.join(cwd, "rolled-back.txt")), { code: "ENOENT" });
		} finally {
			await chmod(target, 0o644);
		}
	});

	it("writes a moved read-only file because rename only needs directory permission", {
		skip: process.platform === "win32",
	}, async (t) => {
		if (process.getuid?.() === 0) {
			t.skip("requires a non-root user for permission failures");
			return;
		}
		const cwd = await workspace();
		const source = path.join(cwd, "source.txt");
		await writeFile(source, "original\n");
		await chmod(source, 0o444);
		try {
			const plan = await planPatch(
				cwd,
				"*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n original\n*** End Patch",
			);
			await applyPatchPlan(plan);
			assert.equal(await readFile(path.join(cwd, "moved.txt"), "utf8"), "original\n");
		} finally {
			await chmod(source, 0o644).catch(() => {});
		}
	});

	it("rejects an aborted apply before any mutation", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(applyPatchPlan(plan, controller.signal), /abort/i);
		assert.equal(await readFile(target, "utf8"), "before\n");
	});

	it("does not authorize a commit cancelled while waiting for Pi's lock", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "fresh.txt");
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: fresh.txt\n+new\n*** End Patch");
		const controller = new AbortController();
		let rejected: Promise<void> | undefined;
		await withFileMutationQueue(target, async () => {
			rejected = assert.rejects(plan.apply(controller.signal), /abort/i);
			await new Promise((resolve) => setTimeout(resolve, 25));
			controller.abort();
			await assert.rejects(stat(target), { code: "ENOENT" });
		});
		await rejected;
		await assert.rejects(stat(target), { code: "ENOENT" });
	});
});
