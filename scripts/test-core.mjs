import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../target/", import.meta.url));
const testCore = path.resolve(process.env.PATCHCRAFT_BIN || path.join(target, "debug", "patchcraft-core"));
process.env.PATCHCRAFT_BIN = testCore;
