import type { PatchChunk, PatchOperation } from "./types.ts";

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PatchParseError";
	}
}

function normalizePatchText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripHeredoc(value: string): string {
	const match = value.match(/^(?:cat\s+)?<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	return match?.[2] ?? value;
}

function requirePath(value: string, header: string): string {
	if (!value) throw new PatchParseError(`${header} requires a path`);
	if (value.includes("\0")) throw new PatchParseError(`${header} path contains NUL`);
	return value;
}

export function parsePatch(patchText: string): PatchOperation[] {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split("\n");
	if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") {
		throw new PatchParseError("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
	}

	const operations: PatchOperation[] = [];
	const endIndex = lines.length - 1;
	let index = 1;

	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (line.trim() === "") {
			index++;
			continue;
		}

		if (line.startsWith("*** Add File: ")) {
			const filePath = requirePath(line.slice("*** Add File: ".length), "Add File");
			index++;
			const content: string[] = [];
			while (index < endIndex && !(lines[index] ?? "").startsWith("*** ")) {
				const contentLine = lines[index] ?? "";
				if (!contentLine.startsWith("+")) {
					throw new PatchParseError("Add File lines must start with '+'");
				}
				content.push(contentLine.slice(1));
				index++;
			}
			if (content.length === 0) throw new PatchParseError(`Add File '${filePath}' has no content lines`);
			operations.push({ type: "add", path: filePath, content: `${content.join("\n")}\n` });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			operations.push({
				type: "delete",
				path: requirePath(line.slice("*** Delete File: ".length), "Delete File"),
			});
			index++;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const filePath = requirePath(line.slice("*** Update File: ".length), "Update File");
			index++;
			let moveTo: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				moveTo = requirePath((lines[index] ?? "").slice("*** Move to: ".length), "Move to");
				index++;
			}

			const chunks: PatchChunk[] = [];
			while (index < endIndex && !(lines[index] ?? "").startsWith("*** ")) {
				if ((lines[index] ?? "").trim() === "") {
					index++;
					continue;
				}

				const contexts: string[] = [];
				while ((lines[index] ?? "").startsWith("@@")) {
					const marker = lines[index] ?? "";
					if (marker !== "@@") contexts.push(marker.slice(3));
					index++;
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let parsedLines = 0;
				let endOfFile = false;
				while (index < endIndex) {
					const changeLine = lines[index] ?? "";
					if (changeLine === "*** End of File") {
						if (parsedLines === 0) throw new PatchParseError("Update hunk has no change lines");
						endOfFile = true;
						index++;
						break;
					}
					if (changeLine.startsWith("@@") || changeLine.startsWith("*** ")) break;
					const prefix = changeLine[0];
					const value = changeLine.slice(1);
					if (prefix === " ") {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === "-") oldLines.push(value);
					else if (prefix === "+") newLines.push(value);
					else {
						throw new PatchParseError(`Invalid update line: '${changeLine}'`);
					}
					parsedLines++;
					index++;
				}
				if (parsedLines === 0) throw new PatchParseError("Update hunk has no change lines");
				chunks.push({ contexts, oldLines, newLines, endOfFile });
			}

			if (chunks.length === 0 && moveTo === undefined) {
				throw new PatchParseError(`Update File '${filePath}' is empty`);
			}
			operations.push(
				moveTo === undefined
					? { type: "update", path: filePath, chunks }
					: { type: "update", path: filePath, moveTo, chunks },
			);
			continue;
		}

		throw new PatchParseError(`Unknown patch header: '${line}'`);
	}

	if (operations.length === 0) throw new PatchParseError("Patch is empty");
	return operations;
}
