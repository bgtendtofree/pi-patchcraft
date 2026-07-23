import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePatchPath(cwd: string, input: string): string {
	let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (!value) throw new Error("Patch path is empty");
	if (value.includes("\0")) throw new Error("Patch path contains NUL");
	if (value === "~") value = os.homedir();
	else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		value = path.join(os.homedir(), value.slice(2));
	}
	if (value.startsWith("file://")) value = fileURLToPath(value);
	return path.resolve(cwd, value);
}
