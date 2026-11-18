import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempDisposableSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { planPatch } from "../src/client.ts";

const patch = "*** Begin Patch\n*** Add File: fresh.txt\n+hello\n*** End Patch";
const binary = process.env.PATCHCRAFT_BIN ?? "patchcraft-core";

it("reports compatibility and applies a patch as a standalone CLI", () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const doctor = spawnSync(binary, ["doctor", "--json"], { encoding: "utf8" });
	assert.equal(doctor.status, 0, doctor.stderr);
	assert.deepEqual(Object.keys(JSON.parse(doctor.stdout)).sort(), ["protocol", "version"]);
	assert.equal(JSON.parse(doctor.stdout).protocol, 2);
	const result = spawnSync(binary, ["apply", "--json"], { cwd: cwd.path, input: patch, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.deepEqual(JSON.parse(result.stdout), {
		protocol: 2,
		status: "applied",
		changes: [{ operation: "add", path: "fresh.txt", targetPath: "fresh.txt", fuzz: 0 }],
	});
	assert.equal(readFileSync(path.join(cwd.path, "fresh.txt"), "utf8"), "hello\n");
});

it("rejects incompatible session protocols without writing", () => {
	using cwd = mkdtempDisposableSync(path.join(os.tmpdir(), "patchcraft-core-"));
	const result = spawnSync(binary, ["session", "--json"], {
		cwd: cwd.path,
		input: `${JSON.stringify({ protocol: 1, patch })}\ncommit\n`,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stdout, /Unsupported protocol 1/);
	assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
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
		child.stdin.write(`${JSON.stringify({ protocol: 2, patch })}\n`);
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
		await assert.rejects(planPatch(cwd.path, patch), /Install patchcraft-core on PATH or set PATCHCRAFT_BIN/);
	} finally {
		if (saved === undefined) delete process.env.PATCHCRAFT_BIN;
		else process.env.PATCHCRAFT_BIN = saved;
	}
	assert.equal(existsSync(path.join(cwd.path, "fresh.txt")), false);
});
