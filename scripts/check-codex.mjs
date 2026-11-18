import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposableSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPLY_PATCH_LARK_GRAMMAR } from "../src/grammar.ts";

// Blob and tree IDs from OpenAI Codex at this revision, not hashes of the local port.
const revision = "ca21fe65d18a9b6326759fb4263c65dfbb645aa5";
const grammarBlob = "5aa41b0af797a0bde0dc2459c272c9af63e96dc3";
const scenariosTree = "e63f926297ff92caecb6d014b59c2819d67dbf6d";
const fixtures = "rust/patchcraft-core/tests/fixtures/codex";
const root = fileURLToPath(new URL("../", import.meta.url));

using temp = mkdtempDisposableSync(path.join(tmpdir(), "patchcraft-upstream-"));
// Hash the working files, including additions and deletions, without touching the real index.
const env = { ...process.env, GIT_INDEX_FILE: path.join(temp.path, "index") };
function git(args, input) {
	return execFileSync("git", args, { cwd: root, env, input, encoding: "utf8" }).trim();
}

assert.equal(git(["hash-object", "--stdin"], APPLY_PATCH_LARK_GRAMMAR), grammarBlob, "Codex grammar changed");
git(["add", "--force", "--", fixtures]);
assert.equal(git(["write-tree", `--prefix=${fixtures}/`]), scenariosTree, "Codex fixtures changed");
for (const file of ["README.md", "rust/patchcraft-core/README.md"]) {
	assert.ok(readFileSync(path.join(root, file), "utf8").includes(revision), `${file} does not reference pinned Codex`);
}
console.log(`Codex ${revision}: grammar and scenarios match upstream Git objects`);
