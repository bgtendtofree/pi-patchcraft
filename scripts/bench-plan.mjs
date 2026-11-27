// Run after `cargo build --release --locked`. Times are medians, not CI thresholds.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

const core = fileURLToPath(new URL("../target/release/patchcraft-core", import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), "patchcraft-bench-"));
const patch = "*** Begin Patch\n*** Update File: data\n@@\n-old\n+new\n*** End Patch";
async function sample(source) {
	await writeFile(path.join(cwd, "data"), source);
	const start = performance.now();
	const child = spawn(core, ["session", "--json"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
	const exit = new Promise((resolve, reject) => child.once("close", resolve).once("error", reject));
	const lines = createInterface({ input: child.stdout });
	child.stdin.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, cwd, patch })}\n`);
	let changeKiB, receivedMs, decodeMs, diffMs, planMs, applied;
	try {
		for await (const line of lines) {
			const arrived = performance.now();
			const frame = JSON.parse(line);
			if (frame.status === "error") throw new Error(frame.message);
			if (frame.status === "change") {
				receivedMs = arrived - start;
				changeKiB = (Buffer.byteLength(line) + 1) / 1024;
				const before = Buffer.from(frame.before, "base64").toString();
				const after = Buffer.from(frame.after, "base64").toString();
				const decoded = performance.now();
				decodeMs = decoded - arrived; // JSON parse + base64/UTF-8
				generateDiffString(before, after);
				diffMs = performance.now() - decoded;
			}
			if (frame.status === "planned") {
				planMs = performance.now() - start;
				child.stdin.write("commit\n");
			}
			if (frame.status === "applied") applied = true;
		}
		if ((await exit) !== 0 || !applied) throw new Error("Missing commit acknowledgement");
		return { changeKiB, receivedMs, decodeMs, diffMs, planMs };
	} finally {
		child.stdin.end();
		await exit;
	}
}

try {
	for (const kib of [64, 1024, 4096]) {
		const half = "123456789abcdef\n".repeat(kib * 32);
		const source = `${half}old\n${half}`;
		await sample(source);
		const runs = [];
		for (let i = 0; i < 7; i++) runs.push(await sample(source));
		const median = (key) =>
			runs
				.map((row) => row[key])
				.sort((a, b) => a - b)[3]
				.toFixed(1);
		console.log(`${kib} KiB`, Object.fromEntries(Object.keys(runs[0]).map((key) => [key, median(key)])));
	}
} finally {
	await rm(cwd, { recursive: true, force: true });
}
