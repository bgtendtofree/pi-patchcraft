import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.env.CARGO_TARGET_DIR ?? path.join(root, "target");
const executable = "patchcraft-core";
const directory = path.join(root, "bin", `${process.platform}-${process.arch}`);
mkdirSync(directory, { recursive: true });
const binary = path.join(directory, executable);
copyFileSync(path.join(target, "release", executable), binary);
chmodSync(binary, 0o755);
