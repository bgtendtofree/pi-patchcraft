import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../target/", import.meta.url));
const executable = process.platform === "win32" ? "patchcraft-core.exe" : "patchcraft-core";
export const testCore = path.resolve(process.env.PATCHCRAFT_BIN || path.join(target, "debug", executable));
process.env.PATCHCRAFT_BIN = testCore;
