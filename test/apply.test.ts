/**
 * TS client contract tests: diff frames, Pi queues, lifecycle, protocol limits, and error mapping.
 * Core filesystem and parser matrices live in `rust/patchcraft-core/tests/`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { planPatch as openPlan } from "../src/client.ts";
import { MAX_SOURCE_BYTES } from "../src/protocol.ts";

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

	it("rejects oversized patches and sources before mutation", async () => {
		const cwd = await workspace();
		const hugePatch = `*** Begin Patch\n*** Add File: huge.txt\n+${"a".repeat(1024 * 1024)}\n*** End Patch`;
		await assert.rejects(planPatch(cwd, hugePatch), /Patch is too large/);
		await assert.rejects(readFile(path.join(cwd, "huge.txt")));

		const target = path.join(cwd, "large.txt");
		await writeFile(target, "value\n");
		await truncate(target, MAX_SOURCE_BYTES + 1);
		await assert.rejects(
			planPatch(cwd, "*** Begin Patch\n*** Update File: large.txt\n@@\n-value\n+changed\n*** End Patch"),
			/Patch source is too large/,
		);
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
		assert.equal(plan.phase, "failed");
		assert.equal(plan.outcome, "failed");
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
		assert.equal(plan.phase, "failed");
		assert.equal(plan.outcome, "failed");
		await assert.rejects(stat(target), { code: "ENOENT" });
	});
});
