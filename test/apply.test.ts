import assert from "node:assert/strict";
import fs, { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatchPlan, planPatch } from "../src/apply.ts";
import { directoryUsesCaseInsensitiveNames, directoryUsesNormalizationInsensitiveNames } from "../src/paths.ts";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-patchcraft-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
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

/**
 * A buffer that fails every write after the temporary file was created, without mocking the
 * filesystem: Node throws when asked to write a detached ArrayBuffer.
 */
function detachedBuffer(): Buffer {
	const buffer = Buffer.allocUnsafeSlow(1);
	buffer.buffer.transfer();
	return buffer;
}

async function temporaryFiles(directory: string): Promise<string[]> {
	return (await readdir(directory)).filter((name) => name.startsWith(".patchcraft-"));
}

/**
 * Replace readdir/lstat with a synthetic directory listing so a host that only exposes one default
 * sensitivity pair can still exercise the other. `aliases` maps basenames to a shared inode; any
 * other name falls through to the real filesystem so real directories still resolve.
 */
function installNameLookupMock(entries: string[], aliases: Map<string, number>): () => void {
	const originalReaddir = fs.readdir;
	const originalLstat = fs.lstat;
	fs.readdir = (async () => entries) as unknown as typeof fs.readdir;
	fs.lstat = (async (target: string) => {
		const ino = aliases.get(path.basename(String(target)));
		if (ino !== undefined) {
			return { ino, dev: 1, isFile: () => true, isDirectory: () => false } as unknown as Awaited<
				ReturnType<typeof stat>
			>;
		}
		return originalLstat(target);
	}) as typeof fs.lstat;
	syncBuiltinESMExports();
	return () => {
		fs.readdir = originalReaddir;
		fs.lstat = originalLstat;
		syncBuiltinESMExports();
	};
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

	it("strips a leading BOM for matching and preserves it on write", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "bom.txt");
		await writeFile(target, "\uFEFFbefore\nafter\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: bom.txt\n@@\n-before\n+changed\n*** End Patch",
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
			/conflicting operations/,
		);
		assert.equal(await readFile(path.join(cwd, "update.txt"), "utf8"), "before\n");
	});

	it("creates or overwrites a file with Add File like Codex, capturing old content", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "existing.txt");
		await writeFile(target, "old\n");
		const overwrite = await planPatch(cwd, "*** Begin Patch\n*** Add File: existing.txt\n+new\n*** End Patch");
		assert.equal(overwrite.changes[0]?.before?.toString("utf8"), "old\n");
		await applyPatchPlan(overwrite);
		assert.equal(await readFile(target, "utf8"), "new\n");

		const create = await planPatch(cwd, "*** Begin Patch\n*** Add File: fresh.txt\n+fresh\n*** End Patch");
		assert.equal(create.changes[0]?.before, undefined);
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
			"*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n*** End Patch",
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
			"*** Begin Patch\n*** Update File: source.sh\n*** Move to: target.sh\n*** End Patch",
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
*** Update File: second.txt
*** Move to: nested/cafe\u0301.txt
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

	it("shares Pi's mutation queue for a not-yet-existing file", async () => {
		const cwd = await workspace();
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

	it("decides case and Unicode-normalization insensitivity independently", async () => {
		const cwd = await workspace();
		const originalReaddir = fs.readdir;
		const originalLstat = fs.lstat;
		// Simulate a case-sensitive but Unicode-normalization-insensitive filesystem: a case variant is
		// absent while a normalization variant resolves to the same inode. Hosts only exercise one
		// default (macOS APFS is both insensitive; Linux is both sensitive), so mock the read-only lookup.
		fs.readdir = (async () => ["Caf\u00e9.txt"]) as unknown as typeof fs.readdir;
		fs.lstat = (async (target: string) => {
			const name = path.basename(target);
			if (name === "Caf\u00e9.txt" || name === "Cafe\u0301.txt") {
				return { ino: 1, dev: 1 } as Awaited<ReturnType<typeof stat>>;
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		}) as typeof fs.lstat;
		syncBuiltinESMExports();
		try {
			assert.equal(await directoryUsesCaseInsensitiveNames(cwd), false);
			assert.equal(await directoryUsesNormalizationInsensitiveNames(cwd), true);
		} finally {
			fs.readdir = originalReaddir;
			fs.lstat = originalLstat;
			syncBuiltinESMExports();
		}
	});

	it("rejects a pure Unicode collision but allows a case variant on case-sensitive normalization-insensitive", async () => {
		const cwd = await workspace();
		// A normalization variant resolves to the same inode; the ASCII case variants do not.
		const fixture = "Fixture\u00e9.txt";
		const restore = installNameLookupMock(
			[fixture],
			new Map([
				[fixture, 1],
				[fixture.normalize("NFD"), 1],
			]),
		);
		try {
			await assert.rejects(
				planPatch(
					cwd,
					`*** Begin Patch
*** Add File: caf\u00e9.txt
+one
*** Add File: cafe\u0301.txt
+two
*** End Patch`,
				),
				/conflicting operations/,
			);
			const plan = await planPatch(
				cwd,
				`*** Begin Patch
*** Add File: a.txt
+lower
*** Add File: A.txt
+upper
*** End Patch`,
			);
			assert.equal(plan.changes.length, 2);
		} finally {
			restore();
		}
	});

	it("rejects a case variant but allows a pure Unicode collision on case-insensitive normalization-sensitive", async () => {
		const cwd = await workspace();
		// A lowercase case variant resolves to the same inode; the normalization variant does not.
		const fixture = "Mixed\u00e9.txt";
		const restore = installNameLookupMock(
			[fixture],
			new Map([
				[fixture, 1],
				[fixture.toLowerCase(), 1],
			]),
		);
		try {
			await assert.rejects(
				planPatch(
					cwd,
					`*** Begin Patch
*** Add File: a.txt
+lower
*** Add File: A.txt
+upper
*** End Patch`,
				),
				/conflicting operations/,
			);
			const plan = await planPatch(
				cwd,
				`*** Begin Patch
*** Add File: caf\u00e9.txt
+composed
*** Add File: cafe\u0301.txt
+decomposed
*** End Patch`,
			);
			assert.equal(plan.changes.length, 2);
		} finally {
			restore();
		}
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

	it("does not list directories for ordinary multi-file adds and moves", async () => {
		const cwd = await workspace();
		await writeFile(path.join(cwd, "old.txt"), "old\n");
		const originalReaddir = fs.readdir;
		let readdirCalls = 0;
		fs.readdir = (async () => {
			readdirCalls++;
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		}) as unknown as typeof fs.readdir;
		syncBuiltinESMExports();
		try {
			const plan = await planPatch(
				cwd,
				`*** Begin Patch
*** Add File: one.txt
+one
*** Add File: two.txt
+two
*** Update File: old.txt
*** Move to: nested/old.txt
*** End Patch`,
			);
			await applyPatchPlan(plan);
		} finally {
			fs.readdir = originalReaddir;
			syncBuiltinESMExports();
		}
		// A probe swallows a lookup error, so only the call count proves no listing happened.
		assert.equal(readdirCalls, 0);
		assert.equal(await readFile(path.join(cwd, "one.txt"), "utf8"), "one\n");
		assert.equal(await readFile(path.join(cwd, "two.txt"), "utf8"), "two\n");
		assert.equal(await readFile(path.join(cwd, "nested/old.txt"), "utf8"), "old\n");
	});

	it("re-evaluates case aliases for each plan instead of caching a probe", async () => {
		const cwd = await workspace();
		const directory = path.join(cwd, "nested");
		await mkdir(directory);
		if (await isCaseInsensitive(cwd)) {
			await assert.rejects(
				planPatch(
					cwd,
					`*** Begin Patch
*** Add File: nested/a.txt
+one
*** Add File: nested/A.txt
+two
*** End Patch`,
				),
				/conflicting operations/,
			);
		}
		const plan = await planPatch(cwd, "*** Begin Patch\n*** Add File: nested/b.txt\n+ok\n*** End Patch");
		await applyPatchPlan(plan);
		assert.equal(await readFile(path.join(directory, "b.txt"), "utf8"), "ok\n");
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
		assert.deepEqual(await temporaryFiles(cwd), []);

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

	it("removes its temporary file when the write fails after creation", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		const change = plan.changes[0];
		assert.ok(change);
		change.after = detachedBuffer();
		await assert.rejects(applyPatchPlan(plan), /All applied changes were rolled back/);
		assert.equal(await readFile(target, "utf8"), "before\n");
		assert.deepEqual(await temporaryFiles(cwd), []);
	});

	it("rolls back earlier changes in reverse order when a later operation fails", async () => {
		const cwd = await workspace();
		const created = path.join(cwd, "created.txt");
		const overwritten = path.join(cwd, "overwritten.txt");
		const victim = path.join(cwd, "victim.txt");
		const failing = path.join(cwd, "failing.txt");
		await writeFile(overwritten, "old\n");
		await writeFile(victim, "victim\n");
		await writeFile(failing, "keep\n");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Add File: created.txt
+created
*** Delete File: victim.txt
*** Add File: overwritten.txt
+new
*** Update File: failing.txt
@@
-keep
+changed
*** End Patch`,
		);
		const last = plan.changes[3];
		assert.ok(last);
		last.after = detachedBuffer();
		// Record the filesystem operation order so a forward-order rollback regression is caught.
		const originalRename = fs.rename;
		const originalUnlink = fs.unlink;
		const originalRm = fs.rm;
		const events: string[] = [];
		const record = (kind: string, target: string) => {
			const name = path.basename(target);
			if (!name.startsWith(".patchcraft-")) events.push(`${kind}:${name}`);
		};
		fs.rename = (async (from: string, to: string) => {
			const result = await originalRename(from, to);
			record("rename", to);
			return result;
		}) as typeof fs.rename;
		fs.unlink = (async (target: string) => {
			const result = await originalUnlink(target);
			record("unlink", target);
			return result;
		}) as typeof fs.unlink;
		fs.rm = (async (target: string, options?: { force?: boolean; recursive?: boolean }) => {
			const result = await originalRm(target, options);
			record("rm", target);
			return result;
		}) as typeof fs.rm;
		syncBuiltinESMExports();
		try {
			await assert.rejects(applyPatchPlan(plan), /All applied changes were rolled back/);
		} finally {
			fs.rename = originalRename;
			fs.unlink = originalUnlink;
			fs.rm = originalRm;
			syncBuiltinESMExports();
		}
		// Apply: created, victim, overwritten. The failing update never renamed its target, so there is
		// nothing to restore for it. Roll back the three applied changes in reverse order.
		assert.deepEqual(events, [
			"rename:created.txt",
			"unlink:victim.txt",
			"rename:overwritten.txt",
			"rename:overwritten.txt",
			"rename:victim.txt",
			"rm:created.txt",
		]);
		await assert.rejects(readFile(created));
		assert.equal(await readFile(overwritten, "utf8"), "old\n");
		assert.equal(await readFile(victim, "utf8"), "victim\n");
		assert.equal(await readFile(failing, "utf8"), "keep\n");
		assert.deepEqual(await temporaryFiles(cwd), []);
	});

	it("leaves an untouched target's inode intact when its write rename fails", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		const alias = path.join(cwd, "alias.txt");
		await writeFile(target, "before\n");
		await link(target, alias);
		const beforeIno = (await stat(target)).ino;
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		const originalRename = fs.rename;
		let injected = false;
		fs.rename = (async (from: string, to: string) => {
			if (!injected && String(to).endsWith("value.txt")) {
				injected = true;
				throw Object.assign(new Error("EIO"), { code: "EIO" });
			}
			return originalRename(from, to);
		}) as typeof fs.rename;
		syncBuiltinESMExports();
		try {
			await assert.rejects(applyPatchPlan(plan), /All applied changes were rolled back/);
		} finally {
			fs.rename = originalRename;
			syncBuiltinESMExports();
		}
		assert.ok(injected);
		// The rename never touched the target, so rollback must not rewrite it and break the hardlink.
		assert.equal((await stat(target)).ino, beforeIno);
		assert.equal((await stat(alias)).ino, beforeIno);
		assert.equal(await readFile(target, "utf8"), "before\n");
		assert.equal(await readFile(alias, "utf8"), "before\n");
		assert.deepEqual(await temporaryFiles(cwd), []);
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
			"*** Begin Patch\n*** Update File: source/file.txt\n*** Move to: target/moved.txt\n*** End Patch",
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

	it("keeps a completed move destination when restoring the source fails", async () => {
		const cwd = await workspace();
		const source = path.join(cwd, "original.txt");
		const destination = path.join(cwd, "moved.txt");
		const other = path.join(cwd, "second.txt");
		await writeFile(source, "");
		await writeFile(other, "keep\n");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Update File: original.txt
*** Move to: moved.txt
*** Update File: second.txt
@@
-keep
+changed
*** End Patch`,
		);
		const move = plan.changes[0];
		const later = plan.changes[1];
		assert.ok(move);
		assert.ok(later);
		// The empty source equals the zero-length detached buffer, so preflight still passes; the
		// detached buffer then makes the rollback restore throw.
		move.before = detachedBuffer();
		later.after = detachedBuffer();
		await assert.rejects(applyPatchPlan(plan), /Rollback failed/);
		// The move completed, so the destination holds the only copy and must survive.
		assert.equal(await readFile(destination, "utf8"), "");
		await assert.rejects(readFile(source));
		assert.equal(await readFile(other, "utf8"), "keep\n");
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
				"*** Begin Patch\n*** Update File: read-only.txt\n@@\n-before\n+after\n*** End Patch",
			);
			await assert.rejects(applyPatchPlan(plan), /EACCES|permission denied/);
			assert.equal(await readFile(target, "utf8"), "before\n");
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
				"*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n*** End Patch",
			);
			await applyPatchPlan(plan);
			assert.equal(await readFile(path.join(cwd, "moved.txt"), "utf8"), "original\n");
		} finally {
			await chmod(source, 0o644).catch(() => {});
		}
	});

	it("reports a temporary cleanup failure without discarding the original error", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		const change = plan.changes[0];
		assert.ok(change);
		change.after = detachedBuffer();
		const originalRm = fs.rm;
		let cleanupAttempted = false;
		fs.rm = (async (filePath: string, options?: { force?: boolean; recursive?: boolean }) => {
			if (path.basename(filePath).startsWith(".patchcraft-") && !cleanupAttempted) {
				cleanupAttempted = true;
				throw Object.assign(new Error("CLEANUP_FAILURE"), { code: "EACCES" });
			}
			return originalRm(filePath, options);
		}) as typeof fs.rm;
		syncBuiltinESMExports();
		try {
			await assert.rejects(applyPatchPlan(plan), /Failed to clean up temporary file[\s\S]*CLEANUP_FAILURE/);
		} finally {
			fs.rm = originalRm;
			syncBuiltinESMExports();
		}
		assert.ok(cleanupAttempted);
		assert.equal(await readFile(target, "utf8"), "before\n");
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

	it("undoes a change cancelled during the final filesystem operation", async () => {
		const cwd = await workspace();
		const target = path.join(cwd, "value.txt");
		await writeFile(target, "before\n");
		const plan = await planPatch(
			cwd,
			"*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
		);
		const controller = new AbortController();
		const originalRename = fs.rename;
		fs.rename = (async (oldPath: string, newPath: string) => {
			const result = await originalRename(oldPath, newPath);
			// Abort after the write reached the filesystem but before apply observes completion.
			controller.abort();
			return result;
		}) as typeof fs.rename;
		syncBuiltinESMExports();
		try {
			await assert.rejects(applyPatchPlan(plan, controller.signal), /All applied changes were rolled back/);
		} finally {
			fs.rename = originalRename;
			syncBuiltinESMExports();
		}
		assert.equal(await readFile(target, "utf8"), "before\n");
		assert.deepEqual(await temporaryFiles(cwd), []);
	});

	it("rolls back applied changes when the signal aborts mid-apply", async () => {
		const cwd = await workspace();
		const first = path.join(cwd, "first.txt");
		const second = path.join(cwd, "second.txt");
		await writeFile(first, "one\n");
		await writeFile(second, "two\n");
		const plan = await planPatch(
			cwd,
			`*** Begin Patch
*** Update File: first.txt
@@
-one
+ONE
*** Update File: second.txt
@@
-two
+TWO
*** End Patch`,
		);
		const controller = new AbortController();
		const originalRename = fs.rename;
		let renamed = false;
		fs.rename = (async (oldPath: string, newPath: string) => {
			const result = await originalRename(oldPath, newPath);
			if (!renamed) {
				renamed = true;
				controller.abort();
			}
			return result;
		}) as typeof fs.rename;
		syncBuiltinESMExports();
		try {
			await assert.rejects(applyPatchPlan(plan, controller.signal), /All applied changes were rolled back/);
		} finally {
			fs.rename = originalRename;
			syncBuiltinESMExports();
		}
		assert.ok(renamed);
		assert.equal(await readFile(first, "utf8"), "one\n");
		assert.equal(await readFile(second, "utf8"), "two\n");
	});
});
