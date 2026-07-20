# Pi Patchcraft Repository Guide

Instructions for human contributors and coding agents. This file applies to the entire repository.

## Purpose

Patchcraft provides Pi with a transactional Codex-style `apply_patch` tool. Preserve compatibility with Pi's public extension API and the standard `*** Begin Patch` / `*** End Patch` patch language.

## Stack

- Runtime: Node.js 24 through Pi
- Development tooling: Bun 1.3.14
- TypeScript 7, strict mode, ES2024
- Formatting and linting: Biome
- Tests: Node.js `node:test`
- Pi development baseline: `@earendil-works/pi-coding-agent` 0.80.10

Do not use Bun runtime APIs in extension source. Pi loads the TypeScript files directly.

## Layout

- `src/index.ts` — tool registration, model-based activation, Pi lifecycle wiring
- `src/parser.ts` — Codex patch envelope and operation parser
- `src/paths.ts` — workspace path and symlink-escape validation
- `src/apply.ts` — planning, matching, locking, atomic writes, rollback
- `src/progressive.ts` — optional Progressive Tools protocol adapter
- `src/render.ts` — standalone fallback renderer
- `src/types.ts` — shared patch, plan, result, and renderer detail types
- `test/*.test.ts` — mirrored Node.js test suites

Keep `index.ts` thin. Put pure parsing, matching, path, and rendering logic in focused modules.

## Code Style

- Tabs for indentation; double quotes; semicolons.
- Use `.ts` suffixes for local imports.
- Keep strict TypeScript clean: no `any`, `@ts-ignore`, or `@ts-expect-error`.
- Prefer explicit unions and named interfaces over enums and ambiguous booleans.
- Prefer whole-object assertions in tests when practical.
- Throw from tool execution to report failure; returning an error-shaped result is still a successful Pi tool call.
- Use only documented exports from `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.

## Patch Language Contract

- Public tool name remains `apply_patch`.
- Public schema remains `{ patch: string }`; compatibility normalization may accept `input`, `patchText`, and raw strings.
- Support Add, Delete, Update, optional Move, stacked `@@` context, `*** End of File`, and multi-file envelopes.
- Reject malformed lines instead of silently skipping them.
- Keep model-visible tool descriptions concise. Do not inject the full grammar into Pi's system prompt unless evidence shows it is required.
- Patch paths are relative to the active workspace. Never weaken absolute-path, traversal, or symlink-escape rejection.

## Transaction Invariants

Changes touching patch execution must preserve all of these:

1. Parse and plan every operation before the first mutation.
2. Validate operation preconditions and conflicting source/destination paths during planning.
3. Acquire Pi file mutation queues in stable sorted path order.
4. Revalidate source contents and destination absence after locks are acquired.
5. Write through a temporary file in the destination directory, preserve mode when available, then rename.
6. Roll back completed operations in reverse order when a later operation fails.
7. Attempt to restore the currently failing operation when it may have partially mutated state.
8. Report rollback failures explicitly; never claim transaction safety after incomplete recovery.

Patchcraft provides best-effort runtime rollback, not crash-safe filesystem transactions. Do not describe it otherwise.

## Matching Rules

Context matching progresses from exact to increasingly fuzzy forms:

1. Exact line match
2. Ignore trailing whitespace
3. Trim surrounding whitespace
4. Unicode compatibility, quote, dash, and special-space normalization

Preserve fuzz accounting. Prefer failure over adding broader or ambiguous matching.

## Progressive Tools Integration

- Integration is optional; Patchcraft must work without Progressive Tools installed.
- Discover protocol v1 through its versioned `Symbol.for()` keys; do not add a runtime package dependency.
- Support both load orders through immediate registration or the pending queue.
- Adapter code owns presentation only. It must not execute patches, mutate tool results, or write session entries.
- Retain the standalone fallback renderer.
- Keep adapter id stable: `@bgtendtofree/pi-patchcraft/apply-patch`.

## Model Tool Policy

- GPT/Codex-family models receive `apply_patch` in place of Pi `edit` and `write`.
- Other models restore the original active-tool baseline.
- Preserve tools owned by users or other extensions when switching models.
- Do not block `bash` globally; tests, formatting, and Git workflows still require it.

## Commands

```bash
bun install
bun run quality
bun run typecheck
bun run test
bun run test:coverage
bun run smoke
bun run package:check
bun run smoke:package
bun run ci
```

Use `bun run validate` for normal source changes. Use full `bun run ci` before release or after changes to packaging, Pi integration, runtime dependencies, transaction behavior, or CI scripts.

Local Pi smoke test:

```bash
pi --offline --no-extensions -e . --list-models
pi -e ./src/index.ts
```

## Test Expectations

- Parser changes: test valid operations plus malformed envelopes and lines.
- Path changes: test traversal, absolute paths, missing ancestors, and symlink escapes.
- Apply changes: test preflight, no-op rejection, fuzzy matching, moves, source drift, and rollback behavior.
- Tool wiring changes: test registration, argument normalization, model switching, and error signaling.
- Rendering changes: test operation titles, singular/plural metrics, zero suppression, multi-file summaries, and Progressive Tools absence.
- Keep coverage thresholds passing; do not lower them to accommodate untested behavior.

## Repository Hygiene

- Do not commit `node_modules/`, `coverage/`, tarballs, temporary patch files, or smoke-test artifacts.
- Keep Pi-provided packages as `"*"` peer dependencies and exact versions in dev dependencies.
- Update README when installation, compatibility, public behavior, or safety semantics change.
- Stage only intended files. Do not use `git add -A`, force-push, bypass hooks, or rewrite shared history.
