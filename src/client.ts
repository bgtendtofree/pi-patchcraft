import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateDiffString, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./protocol.ts";
import type { PatchResultChange, PatchResultDetails } from "./types.ts";

const executable = "patchcraft-core";
const bundledCore = fileURLToPath(new URL(`../bin/${process.platform}-${process.arch}/${executable}`, import.meta.url));
const coreHelp = "Install a matching Patchcraft package or put patchcraft-core on PATH (or set PATCHCRAFT_BIN).";
const executeFile = promisify(execFile);

class CoreRejection extends Error {}

/**
 * Planned → waiting for queues → committing → applied. A plan can also be closed
 * before use or fail; only failures after authorizing commit can have an unknown outcome.
 */
export type PatchPlanPhase = "planned" | "waiting" | "committing" | "applied" | "failed" | "closed";
export type PatchPlanOutcome = "applied" | "failed" | "unknown";

/** A single state value, so the phase and outcome can never disagree. */
type PlanState =
	| { phase: "planned" }
	| { phase: "waiting" }
	| { phase: "committing" }
	| { phase: "applied" }
	| { phase: "failed"; outcome: "failed" | "unknown" }
	| { phase: "closed" };

function outcomeOf(state: PlanState): PatchPlanOutcome | undefined {
	if (state.phase === "applied") return "applied";
	return state.phase === "failed" ? state.outcome : undefined;
}

export interface PatchPlan extends PatchResultDetails {
	readonly phase: PatchPlanPhase;
	readonly outcome: PatchPlanOutcome | undefined;
	apply(signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coreBinary(): string {
	return process.env.PATCHCRAFT_BIN || (existsSync(bundledCore) ? bundledCore : executable);
}

export async function checkCore(binary: string, cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await executeFile(binary, ["doctor", "--json"], {
			cwd,
			timeout: 2000,
			killSignal: "SIGKILL",
			maxBuffer: 16 * 1024,
		});
		const result: unknown = JSON.parse(stdout);
		if (object(result) && result.protocol === PROTOCOL_VERSION) return undefined;
		return `Incompatible patchcraft-core protocol (expected ${PROTOCOL_VERSION}). ${coreHelp}`;
	} catch (error) {
		const reason = object(error) && error.code === "ENOENT" ? "not found" : "doctor failed";
		return `Cannot use ${binary}: ${reason}. ${coreHelp}`;
	}
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
			if (size > MAX_FRAME_BYTES) throw new Error("patchcraft-core response frame is too large");
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
	if (!object(change)) throw new Error("Invalid patchcraft-core change frame");
	const { operation, path, targetPath, fuzz } = change;
	if (
		(operation !== "add" && operation !== "update" && operation !== "move" && operation !== "delete") ||
		typeof path !== "string" ||
		typeof targetPath !== "string" ||
		typeof fuzz !== "number" ||
		typeof before !== "string" ||
		typeof after !== "string"
	) {
		throw new Error("Invalid patchcraft-core change");
	}
	const { diff: displayDiff } = generateDiffString(
		Buffer.from(before, "base64").toString("utf8"),
		Buffer.from(after, "base64").toString("utf8"),
	);
	let added = 0;
	let removed = 0;
	// Pi's diff rows are separated by LF, not every line terminator matched by JS's multiline ^.
	for (const [, sign] of displayDiff.matchAll(/(?:^|\n)([+-])/g)) {
		if (sign === "+") added++;
		else removed++;
	}
	return {
		operation,
		path,
		targetPath,
		fuzz,
		displayDiff,
		added,
		removed,
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
	const binary = coreBinary();
	const child = spawn(binary, ["session", "--json"], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		// Let Pi handle terminal interrupts. The core sees EOF and can roll back.
		detached: true,
	});
	let spawnError: (Error & { code?: string }) | undefined;
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
	let state: PlanState = { phase: "planned" };
	let closing: Promise<void> | undefined;
	function stopCore(): Promise<void> {
		closing ??= (async () => {
			cancel();
			// Drain stdout before waiting so a response in flight can't block exit.
			await output.return(undefined).catch(() => {});
			child.stdout.resume();
			await exited;
		})();
		return closing;
	}

	function close(): Promise<void> {
		if (state.phase === "committing") {
			// Apply owns the response stream until acknowledgement or failure.
			cancel();
			return exited.then(() => undefined);
		}
		if (state.phase === "planned" || state.phase === "waiting") state = { phase: "closed" };
		return stopCore();
	}

	async function next() {
		const { value, done } = await output.next();
		if (done) {
			const status = await exited;
			if (spawnError?.code === "ENOENT") {
				throw new Error(`Cannot start ${binary}. ${coreHelp}`);
			}
			throw new Error(
				spawnError?.message ??
					`patchcraft-core exited (${status.signal ?? status.code}) without a result. ${stderr}`.trim(),
			);
		}
		if (value.status !== "change" && value.protocol !== PROTOCOL_VERSION) {
			throw new Error(
				`Incompatible patchcraft-core protocol; expected ${PROTOCOL_VERSION}. Install matching Pi and core releases.`,
			);
		}
		if (value.status === "error" && typeof value.message === "string") {
			throw new CoreRejection(value.message);
		}
		return value;
	}

	try {
		signal?.addEventListener("abort", cancel, { once: true });
		child.stdin.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, cwd: path.resolve(cwd), patch })}\n`);
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
			!lockPaths.every((key): key is string => typeof key === "string")
		) {
			throw new Error("Invalid patchcraft-core plan");
		}
		return {
			changes,
			added: changes.reduce((sum, change) => sum + change.added, 0),
			removed: changes.reduce((sum, change) => sum + change.removed, 0),
			fuzz: changes.reduce((sum, change) => sum + change.fuzz, 0),
			get phase() {
				return state.phase;
			},
			get outcome() {
				return outcomeOf(state);
			},
			async apply(signal?: AbortSignal) {
				if (state.phase !== "planned") {
					const outcome = outcomeOf(state);
					const detail = outcome ? `, outcome: ${outcome}` : "";
					throw new Error(`Patchcraft plan is no longer available (phase: ${state.phase}${detail})`);
				}
				state = { phase: "waiting" };
				try {
					signal?.addEventListener("abort", cancel, { once: true });
					await withPiQueues(lockPaths, signal, async () => {
						if (state.phase === "closed") throw new Error("Patchcraft plan was closed before commit");
						state = { phase: "committing" };
						try {
							child.stdin.write("commit\n");
							const result = await next();
							if (result.status !== "applied" || !(await output.next()).done || (await exited).code !== 0) {
								throw new Error("patchcraft-core did not acknowledge commit");
							}
							state = { phase: "applied" };
						} catch (error) {
							// Don't release Pi's locks until the core finishes any rollback.
							await stopCore();
							if (error instanceof CoreRejection && (await exited).code === 1) {
								state = { phase: "failed", outcome: "failed" };
								throw error;
							}
							state = { phase: "failed", outcome: "unknown" };
							const reason = error instanceof Error ? error.message : String(error);
							throw new Error(`Patch commit outcome is unknown. Check the affected files before retrying. ${reason}`, {
								cause: error,
							});
						}
					});
				} catch (error) {
					// The commit callback settles post-authorization failures itself.
					if (state.phase === "waiting") state = { phase: "failed", outcome: "failed" };
					throw error;
				} finally {
					signal?.removeEventListener("abort", cancel);
					await stopCore();
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
