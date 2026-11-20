#!/usr/bin/env bash
# Run from the repository root after cargo build --release.
set -euo pipefail
export PATCHCRAFT_BIN="${PATCHCRAFT_BIN:-$PWD/target/release/patchcraft-core}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

node --input-type=module - "$work" <<'JS'
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const work = process.argv[2];
const filler = "0123456789".repeat(9);
const source = Array.from({ length: Math.floor(6 * 1024 * 1024 / 100) }, (_, index) =>
    `${String(index).padStart(8, "0")} ${filler}\n`).join("");
writeFileSync(join(work, "core.txt"), `before\n${source}`);
copyFileSync(join(work, "core.txt"), join(work, "adapter.txt"));
JS

patch() { printf '%s\n' '*** Begin Patch' "*** Update File: $1" '-before' '+after' '*** End Patch'; }
time_args=(-v)
if [[ "$(uname -s)" = Darwin ]]; then time_args=(-l); fi
echo "Standalone Rust CLI:"
patch core.txt | (cd "$work" && /usr/bin/time "${time_args[@]}" "$PATCHCRAFT_BIN" apply --json)

echo "Pi adapter:"
PATCH="$(patch adapter.txt)" node --input-type=module - "$work" <<'JS'
import assert from "node:assert/strict";
import { planPatch } from "./src/client.ts";
const started = performance.now();
const plan = await planPatch(process.argv[2], process.env.PATCH);
const planned = performance.now();
await plan.apply();
assert.equal(plan.added, 1);
assert.equal(plan.removed, 1);
console.log({
    planMs: Math.round(planned - started),
    totalMs: Math.round(performance.now() - started),
    nodePeakMiB: Math.round(process.resourceUsage().maxRSS / 1024),
});
JS
