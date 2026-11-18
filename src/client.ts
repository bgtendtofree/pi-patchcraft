import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PatchResultChange, PatchResultDetails } from "./types.ts";

const protocol = 2;
// Two base64 snapshots of up to 64 MiB each, plus patch overhead.
const maxFrameBytes = 192 * 1024 * 1024;

interface PatchPlan extends PatchResultDetails {
	apply(signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one frame at a time, without buffering the whole plan or splitting UTF-8 characters. */
async function* frames(stream: AsyncIterable<Buffer>) {
	let parts: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream) {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			size += end - start;
			if (size > maxFrameBytes) throw new Error("patchcraft-core response frame is too large");
			parts.push(chunk.subarray(start, end));
			start = end + 1;
			if (newline >= 0) {
				const value: unknown = JSON.parse(Buffer.concat(parts, size).toString("utf8"));
				parts = [];
				size = 0;
				if (!object(value)) throw new Error("Invalid patchcraft-core response");
				yield value;
			}
		}
	}
	if (size) throw new Error("Incomplete patchcraft-core response");
}

function renderChange(frame: Record<string, unknown>): PatchResultChange {
	const { change, before, after } = frame;
	if (!object(change) || typeof before !== "string" || typeof after !== "string") {
		throw new Error("Invalid patchcraft-core change frame");
	}
	const { operation, path, targetPath, fuzz } = change;
	if (
		(operation !== "add" && operation !== "update" && operation !== "move" && operation !== "delete") ||
		typeof path !== "string" ||
		typeof targetPath !== "string" ||
		typeof fuzz !== "number" ||
		!Number.isSafeInteger(fuzz) ||
		fuzz < 0
	) {
		throw new Error("Invalid patchcraft-core change");
	}
	const { diff: displayDiff } = generateDiffString(
		Buffer.from(before, "base64").toString("utf8"),
		Buffer.from(after, "base64").toString("utf8"),
	);
	return {
		operation,
		path,
		targetPath,
		fuzz,
		displayDiff,
		added: (displayDiff.match(/^\+/gm) ?? []).length,
		removed: (displayDiff.match(/^-/gm) ?? []).length,
	};
}

async function queueKey(filePath: string): Promise<string> {
	try {
		return await realpath(filePath);
	} catch (error) {
		if (object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return filePath;
		throw error;
	}
}

async function withPiQueues(paths: string[], signal: AbortSignal | undefined, commit: () => Promise<void>) {
	// These are Pi's keys, not patch path resolution. In particular, two
	// previously missing aliases might now share one already-existing key.
	const keys = [...new Set(await Promise.all(paths.map(queueKey)))].sort();
	async function acquire(index: number): Promise<void> {
		signal?.throwIfAborted();
		const key = keys[index];
		if (key === undefined) return commit();
		if ((await queueKey(key)) !== key) throw new Error(`Patch lock path changed before apply: ${key}`);
		return withFileMutationQueue(key, () => acquire(index + 1));
	}
	await acquire(0);
}

export async function planPatch(cwd: string, patch: string, signal?: AbortSignal): Promise<PatchPlan> {
	signal?.throwIfAborted();
	const binary = process.env.PATCHCRAFT_BIN || "patchcraft-core";
	const child = spawn(binary, ["session", "--json"], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		// Let Pi handle terminal interrupts. The core sees EOF and can roll back.
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	let spawnError: Error | undefined;
	let stderr = "";
	child.once("error", (error) => {
		spawnError = error;
	});
	child.stdin.on("error", () => {
		// Early rejection can close stdin; use the core's stdout/exit status.
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-8192);
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	const cancel = () => child.stdin.end();
	const output = frames(child.stdout.iterator({ destroyOnReturn: false }));
	let applied = false;
	async function close() {
		cancel();
		// Drain stdout before waiting so a response in flight can't block exit.
		await output.return(undefined).catch(() => {});
		child.stdout.resume();
		await exited;
	}

	async function next() {
		const { value, done } = await output.next();
		if (done) {
			const status = await exited;
			if (spawnError && object(spawnError) && spawnError.code === "ENOENT") {
				throw new Error(`Cannot start ${binary}. Install patchcraft-core on PATH or set PATCHCRAFT_BIN.`);
			}
			throw new Error(
				spawnError?.message ??
					`patchcraft-core exited (${status.signal ?? status.code}) without a result. ${stderr}`.trim(),
			);
		}
		if (value.status !== "change" && value.protocol !== protocol) {
			throw new Error(
				`Incompatible patchcraft-core protocol; expected ${protocol}. Install matching Pi and core releases.`,
			);
		}
		if (value.status === "error") {
			throw new Error(typeof value.message === "string" ? value.message : "patchcraft-core failed");
		}
		return value;
	}

	try {
		signal?.addEventListener("abort", cancel, { once: true });
		child.stdin.write(`${JSON.stringify({ protocol, patch })}\n`);
		const changes: PatchResultChange[] = [];
		let response = await next();
		while (response.status === "change") {
			signal?.throwIfAborted();
			changes.push(renderChange(response));
			response = await next();
		}
		signal?.throwIfAborted();
		const { lockPaths } = response;
		if (
			response.status !== "planned" ||
			!changes.length ||
			!Array.isArray(lockPaths) ||
			!lockPaths.length ||
			!lockPaths.every((key): key is string => typeof key === "string" && path.isAbsolute(key))
		) {
			throw new Error("Invalid patchcraft-core plan");
		}
		return {
			changes,
			added: changes.reduce((sum, change) => sum + change.added, 0),
			removed: changes.reduce((sum, change) => sum + change.removed, 0),
			fuzz: changes.reduce((sum, change) => sum + change.fuzz, 0),
			async apply(signal?: AbortSignal) {
				if (applied) throw new Error("Patchcraft plan was already used");
				applied = true;
				try {
					signal?.addEventListener("abort", cancel, { once: true });
					await withPiQueues(lockPaths, signal, async () => {
						try {
							child.stdin.write("commit\n");
							const result = await next();
							if (result.status !== "applied" || !(await output.next()).done || (await exited).code !== 0) {
								throw new Error("patchcraft-core did not acknowledge commit");
							}
						} catch (error) {
							// Don't release Pi's locks until the core finishes any rollback.
							await close();
							throw error;
						}
					});
				} finally {
					signal?.removeEventListener("abort", cancel);
					await close();
				}
			},
			close,
		};
	} catch (error) {
		await close();
		signal?.throwIfAborted();
		throw error;
	} finally {
		// The apply phase attaches its own listener, including while waiting for queues.
		signal?.removeEventListener("abort", cancel);
	}
}
