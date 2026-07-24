import type { PatchChunk, PatchOperation } from "./types.ts";

function requirePath(value: string, header: string): string {
	if (!value) throw new Error(`${header} requires a path`);
	if (value.includes("\0")) throw new Error(`${header} path contains NUL`);
	return value;
}

export function parsePatch(patchText: string): PatchOperation[] {
	const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	const lines = normalized.split("\n");
	if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") {
		throw new Error("Invalid patch format: expected *** Begin Patch ... *** End Patch envelope");
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
					throw new Error("Add File lines must start with '+'");
				}
				content.push(contentLine.slice(1));
				index++;
			}
			if (content.length === 0) throw new Error(`Add File '${filePath}' has no content lines`);
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
					if (marker === "@@") {
						index++;
						continue;
					}
					if (!marker.startsWith("@@ ")) throw new Error(`Invalid update marker: '${marker}'`);
					contexts.push(marker.slice(3));
					index++;
				}

				const oldLines: string[] = [];
				const newLines: string[] = [];
				let parsedLines = 0;
				let endOfFile = false;
				while (index < endIndex) {
					const changeLine = lines[index] ?? "";
					if (changeLine === "*** End of File") {
						if (parsedLines === 0) throw new Error("Update hunk has no change lines");
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
						throw new Error(`Invalid update line: '${changeLine}'`);
					}
					parsedLines++;
					index++;
				}
				if (parsedLines === 0) throw new Error("Update hunk has no change lines");
				chunks.push({ contexts, oldLines, newLines, endOfFile });
			}

			if (chunks.length === 0 && moveTo === undefined) {
				throw new Error(`Update File '${filePath}' is empty`);
			}
			operations.push(
				moveTo === undefined
					? { type: "update", path: filePath, chunks }
					: { type: "update", path: filePath, moveTo, chunks },
			);
			continue;
		}

		throw new Error(`Unknown patch header: '${line}'`);
	}

	if (operations.length === 0) throw new Error("Patch is empty");
	return operations;
}
