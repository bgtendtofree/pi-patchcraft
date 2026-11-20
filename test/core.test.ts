import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { planPatch } from "../src/client.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

const patch = "*** Begin Patch\n*** Add File: fresh.txt\n+hello\n*** End Patch";
const binary = process.env.PATCHCRAFT_BIN ?? "patchcraft-core";

it("reports compatibility and applies a patch as a standalone CLI", () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const doctor = spawnSync(binary, ["doctor", "--json"], { encoding: "utf8" });
	assert.equal(doctor.status, 0, doctor.stderr);
	assert.deepEqual(Object.keys(JSON.parse(doctor.stdout)).sort(), ["protocol", "version"]);
	assert.equal(JSON.parse(doctor.stdout).protocol, PROTOCOL_VERSION);
	const result = spawnSync(binary, ["apply", "--json"], { cwd: cwd.path, input: patch, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.deepEqual(JSON.parse(result.stdout), {
		protocol: PROTOCOL_VERSION,
		status: "applied",
		changes: [{ operation: "add", path: "fresh.txt", targetPath: "fresh.txt", fuzz: 0 }],
	});
	assert.equal(readFileSync(path.join(cwd.path, "fresh.txt"), "utf8"), "hello\n");
});

it("rejects incompatible session protocols without writing", () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const result = spawnSync(binary, ["session", "--json"], {
		cwd: cwd.path,
		input: `${JSON.stringify({ protocol: PROTOCOL_VERSION - 1, cwd: cwd.path, patch })}\ncommit\n`,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stdout, new RegExp(`Unsupported protocol ${PROTOCOL_VERSION - 1}`));
	assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
});

it("sends Pi's full diff for a large single-line update", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const file = path.join(cwd.path, "source.txt");
	const filler = `${"context ".repeat(14)}\n`.repeat(5_000);
	const before = `${filler}before\n`;
	writeFileSync(file, before);
	const plan = await planPatch(
		cwd.path,
		"*** Begin Patch\n*** Update File: source.txt\n@@\n-before\n+after\n*** End Patch",
	);
	assert.equal(readFileSync(file, "utf8"), before);
	await plan.apply();
	const after = readFileSync(file, "utf8");
	assert.equal(after, before.replace("before", "after"));
	assert.equal(plan.changes[0]?.displayDiff, generateDiffString(before, after).diff);
	assert.deepEqual([plan.added, plan.removed, plan.fuzz], [1, 1, 0]);
});

it("uses the Codex runtime parser for leniencies and empty hunks", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const add = "<<'EOF'\n*** Begin Patch\n  *** Add File: padded.txt  \n+first\n+\n+last\n*** End Patch\nEOF\n";
	const plan = await planPatch(cwd.path, add);
	await plan.apply();
	await assert.rejects(
		planPatch(cwd.path, "*** Begin Patch\n*** Update File: padded.txt\n*** Move to: moved.txt\n*** End Patch"),
		/Update file hunk .* is empty/,
	);
	await assert.rejects(
		planPatch(cwd.path, "*** Begin Patch\n*** Update File: padded.txt\n@@ first\n@@\n-last\n+changed\n*** End Patch"),
		/Unexpected line found in update hunk/,
	);
	const update = await planPatch(
		cwd.path,
		"*** Begin Patch\n*** Update File: padded.txt\n@@\n first\n\n-last\n+changed\n*** End Patch",
	);
	await update.apply();
	assert.equal(readFileSync(path.join(cwd.path, "padded.txt"), "utf8"), "first\n\nchanged\n");
});

it("rejects remote routing and invalid path data before a local mutation", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	await assert.rejects(
		planPatch(cwd.path, patch.replace("*** Begin Patch", "*** Begin Patch\n*** Environment ID: remote")),
		/does not support \*\*\* Environment ID/,
	);
	await assert.rejects(planPatch(cwd.path, patch.replace("fresh.txt", "nul\0name.txt")), /path .*NUL/);
	assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
});

it("rejects a move to the same file even if its content would change", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const file = path.join(cwd.path, "fresh.txt");
	writeFileSync(file, "before\n");
	await assert.rejects(
		planPatch(
			cwd.path,
			"*** Begin Patch\n*** Update File: fresh.txt\n*** Move to: ./fresh.txt\n-before\n+after\n*** End Patch",
		),
		/Move target already exists/,
	);
	assert.equal(readFileSync(file, "utf8"), "before\n");
});

it("tracks plan phase and settled outcome", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const file = path.join(cwd.path, "phase.txt");
	writeFileSync(file, "before\n");
	const plan = await planPatch(
		cwd.path,
		"*** Begin Patch\n*** Update File: phase.txt\n@@\n-before\n+after\n*** End Patch",
	);
	assert.equal(plan.phase, "planned");
	assert.equal(plan.outcome, undefined);
	await plan.apply();
	assert.equal(plan.phase, "applied");
	assert.equal(plan.outcome, "applied");
	await plan.close();
	assert.equal(plan.phase, "applied");
	await assert.rejects(plan.apply(), /no longer available \(phase: applied, outcome: applied\)/);

	const closed = await planPatch(cwd.path, "*** Begin Patch\n*** Add File: closed.txt\n+x\n*** End Patch");
	await closed.close();
	assert.equal(closed.phase, "closed");
	assert.equal(closed.outcome, undefined);
	await assert.rejects(closed.apply(), /no longer available \(phase: closed\)/);
});

it("reports an unknown outcome if the core exits without acknowledging commit", {
	skip: process.platform === "win32",
}, async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const fake = path.join(cwd.path, "fake-core");
	const file = path.join(cwd.path, "fresh.txt");
	writeFileSync(
		fake,
		`#!/bin/sh
read -r request
printf '%s\\n' '{"status":"change","change":{"operation":"add","path":"fresh.txt","targetPath":"fresh.txt","fuzz":0},"before":"","after":"aGVsbG8K"}'
printf '%s\\n' '${JSON.stringify({ protocol: PROTOCOL_VERSION, status: "planned", lockPaths: [file] })}'
if read -r command && [ "$command" = commit ]; then
  printf 'hello\\n' > fresh.txt
fi
exit 1
`,
		{ mode: 0o755 },
	);
	const saved = process.env.PATCHCRAFT_BIN;
	process.env.PATCHCRAFT_BIN = fake;
	try {
		const plan = await planPatch(cwd.path, patch);
		await assert.rejects(plan.apply(), /commit outcome is unknown.*Check the affected files before retrying/);
		assert.equal(plan.phase, "failed");
		assert.equal(plan.outcome, "unknown");
		await assert.rejects(plan.apply(), /no longer available \(phase: failed, outcome: unknown\)/);
		assert.equal(readFileSync(file, "utf8"), "hello\n");
	} finally {
		if (saved === undefined) delete process.env.PATCHCRAFT_BIN;
		else process.env.PATCHCRAFT_BIN = saved;
	}
});

it("EOF discards a plan when the host has not authorized commit", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const child = spawn(binary, ["session", "--json"], { cwd: cwd.path, stdio: ["pipe", "pipe", "inherit"] });
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	let planned = false;
	let error = "";
	try {
		child.stdin.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, cwd: cwd.path, patch })}\n`);
		for await (const line of createInterface({ input: child.stdout })) {
			const frame = JSON.parse(line);
			if (frame.status === "planned") {
				assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
				planned = true;
				child.stdin.end();
			}
			if (frame.status === "error") error = String(frame.message);
		}
	} finally {
		child.stdin.end();
	}
	assert.equal(await exited, 1);
	assert.equal(planned, true);
	assert.match(error, /aborted before commit/);
	assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
});

it("fails clearly rather than falling back when the core executable is missing", async () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const saved = process.env.PATCHCRAFT_BIN;
	process.env.PATCHCRAFT_BIN = path.join(cwd.path, "not-installed");
	try {
		await assert.rejects(planPatch(cwd.path, patch), /put patchcraft-core on PATH \(or set PATCHCRAFT_BIN\)/);
	} finally {
		if (saved === undefined) delete process.env.PATCHCRAFT_BIN;
		else process.env.PATCHCRAFT_BIN = saved;
	}
	assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
});
