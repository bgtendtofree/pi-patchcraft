# Pi Patchcraft Repository Guide

Instructions for human contributors and coding agents. This file applies to the entire repository.

## Purpose

Patchcraft provides Pi with a transactional Codex-style `apply_patch` tool. Preserve compatibility with Pi's public extension API and the standard `*** Begin Patch` / `*** End Patch` patch language.

## Stack

- Runtime: Node.js `>=24` through Pi
- Development tooling: Node.js 24.19.0 through project mise config and npm
- TypeScript 7, strict mode, ES2024
- Formatting and linting: Biome
- Tests: Node.js `node:test`
- Pi development baseline: `@earendil-works/pi-coding-agent` 1.0.0

Pi loads the TypeScript files directly. Runtime source and tests use separate TypeScript configs.

## Layout

- `src/index.ts` — tool registration, model-based activation, Pi lifecycle wiring
- `src/parser.ts` — Codex patch envelope and operation parser
- `src/paths.ts` — Pi-compatible path normalization and resolution
- `src/apply.ts` — planning, matching, locking, atomic writes, rollback
- `src/row.ts` — row semantics: patch details validation, titles, metrics, and detail sections
- `src/render.ts` — the tool's own row renderer (call title plus result status, metrics, and expanded diff)
- `src/types.ts` — shared patch, plan, result, and renderer detail types, plus the codemode result schema
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
- Keep `patchResultSchema` mirroring `PatchResultDetails`; `codemode` scripts receive it as the tool's `structuredContent`.
- Keep the parameter schema to exactly one required string property. Pi's grammar constrained sampling requires it and rejects every request on grammar-capable models otherwise, so `src/grammar.ts` and `patchParameters` must stay in sync.
- Support Add, Delete, Update, optional Move, stacked `@@` context, `*** End of File`, and multi-file envelopes.
- Reject malformed lines instead of silently skipping them.
- Keep model-visible tool descriptions concise. Do not inject the full grammar into Pi's system prompt unless evidence shows it is required.
- Patch paths follow Pi file-tool behavior: relative paths resolve from active workspace; absolute, home-relative, and `file://` paths are accepted.

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

## Tool Row

- Patchcraft owns its `apply_patch` row: `renderShell: "self"`, with `renderCall` and `renderResult` from `src/render.ts`.
- `renderResult` updates the same header component created by `renderCall` through `context.state`, so a completed patch keeps one title line with its metrics instead of stacking a second.
- Keep the result title vocabulary: first target file, ` +N files` for multi-file patches, `+added`, `-removed`, and `fuzz N` (zero values suppressed), plus `failed` for errors.
- There is no cross-package protocol or adapter registration. With [Pi Progressive Tools](https://github.com/bgtendtofree/pi-progressive-tools) installed, Pi leaves a self-rendering tool untouched and its rows join the activity group as opaque members; without it, the same rows render standalone. Do not add a runtime dependency or import its internals.
- The row carries no host chrome (no animation or elapsed time): while a patch runs it shows only its own partial text, and with Progressive Tools installed the group's chase comes from a host-drawn row in the same group.

## Model Tool Policy

- GPT/Codex-family models receive `apply_patch` in place of Pi `edit` and `write`.
- Other models restore the original active-tool baseline.
- Preserve tools owned by users or other extensions when switching models.
- Do not block `bash` globally; tests, formatting, and Git workflows still require it.

## Commands

```bash
mise install
npm ci
npm run quality
npm run typecheck
npm test
npm run test:coverage
npm run smoke
npm run package:check
npm run smoke:package
npm run ci
```

Use `npm run validate` for normal source changes. Use full `npm run ci` before release or after changes to Pi integration, runtime dependencies, transaction behavior, or CI scripts.

Local Pi smoke test:

```bash
npm run smoke:package
pi -e ./src/index.ts
```

## Test Expectations

- Parser changes: test valid operations plus malformed envelopes and lines.
- Path changes: test relative, absolute, home-relative, parent, and symlinked paths.
- Apply changes: test preflight, no-op rejection, fuzzy matching, moves, source drift, and rollback behavior.
- Tool wiring changes: test registration, argument normalization, model switching, and error signaling.
- Rendering changes: test operation titles, singular/plural metrics, zero suppression, multi-file summaries, and the standalone self-rendered row.
- Keep coverage thresholds passing; do not lower them to accommodate untested behavior.

## Repository Hygiene

- Do not commit `node_modules/`, `coverage/`, tarballs, temporary patch files, or smoke-test artifacts.
- Keep Pi-provided packages as `"*"` peer dependencies and exact versions in dev dependencies.
- Update README when installation, compatibility, public behavior, or safety semantics change.
- Stage only intended files. Do not use `git add -A`, force-push, bypass hooks, or rewrite shared history.

<!-- pi-ci-standard:validation:start -->
## Validation

CI contract for this repository (managed by pi-ci-standard — regenerate with `pi-ci init`):

- Run `mise run check` while iterating; fix all failures before continuing.
- Run `mise run ci` before declaring work complete; it must pass.
- GitHub Actions calls only `mise run ci`. Never add language-specific check commands to workflows.
<!-- pi-ci-standard:validation:end -->
