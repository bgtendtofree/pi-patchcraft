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
- Pi development baseline: `@earendil-works/pi-coding-agent` 1.4.0

Pi loads the TypeScript files directly. Runtime source and tests use separate TypeScript configs.

## Layout

- `src/index.ts` — tool registration, model-based activation, Pi lifecycle wiring
- `src/parser.ts` — Codex patch envelope and operation parser
- `src/paths.ts` — Pi-compatible path normalization and resolution
- `src/match.ts` — pure context matching, chunk application, BOM splitting
- `src/preview.ts` — tolerant streaming preview scanner
- `src/render.ts` — Codex-style summary and diff formatting
- `src/tools.ts` — pure loadout reconciliation and model detection
- `src/apply.ts` — planning, locking, atomic writes, rollback
- `src/types.ts` — shared patch, plan, result detail types, plus the codemode result schema
- `test/*.test.ts` — mirrored Node.js test suites

Keep `index.ts` thin. Put pure parsing, matching, and path logic in focused modules.

## Code Style

- Tabs for indentation; double quotes; semicolons.
- Use `.ts` suffixes for local imports.
- Keep strict TypeScript clean: no `any`, `@ts-ignore`, or `@ts-expect-error`.
- Prefer explicit unions and named interfaces over enums and ambiguous booleans.
- Prefer whole-object assertions in tests when practical.
- Throw from tool execution to report failure; returning an error-shaped result is still a successful Pi tool call.
- Use only documented exports from `@earendil-works/pi-coding-agent` and `typebox`.

## Patch Language Contract

- Public tool name remains `apply_patch`.
- Public schema remains `{ patch: string }`. Do not add input aliases or argument compatibility shims; Pi maps raw grammar input to `patch` before schema validation.
- Keep `patchResultSchema` mirroring `PatchResultDetails`; `codemode` scripts receive it as the tool's `structuredContent`.
- Keep the parameter schema to exactly one required string property. Pi's grammar constrained sampling requires it and rejects every request on grammar-capable models otherwise, so `src/grammar.ts` and `patchParameters` must stay in sync.
- Support Add, Delete, Update, optional Move, stacked `@@` context, `*** End of File`, and multi-file envelopes.
- Reject two operations that resolve to the same file in one envelope (Codex parity, `openai/codex#37867`): a repeated `*** Update File:` header is invalid, and a move destination colliding with any other source or destination is rejected as well. That destination check is stricter than Codex main (`openai/codex#53409`).
- `Add File` creates or overwrites a target, matching Codex; a pre-existing file is captured as `before` for rollback.
- Follow Codex content semantics: a context-less addition appends at end of file, lines parsed as context keep their original endings, inserted lines use the file's first line ending, and an update always terminates the final line.
- Reject malformed lines instead of silently skipping them.
- Keep model-visible tool descriptions concise. Do not inject the full grammar into Pi's system prompt unless evidence shows it is required.
- Patch paths follow Pi file-tool behavior: relative paths resolve from active workspace; absolute, home-relative, and `file://` paths are accepted.

## Transaction Invariants

Changes touching patch execution must preserve all of these:

1. Parse and plan every operation before the first mutation.
2. Validate operation preconditions and conflicting source/destination paths during planning.
3. Acquire Pi file mutation queues in stable sorted path order.
4. Revalidate source contents after locks are acquired; for moves also require the destination to stay absent. `Add File` overwrites an existing target, so it revalidates the captured previous content instead.
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
4. Quote, dash, and special-space normalization

Content positioning follows Codex: context-less additions append at end of file, context lines keep their terminators, and an update terminates the final line. Preserve fuzz accounting. Prefer failure over adding broader or ambiguous matching.

## Tool Rendering

- Register `renderCall` and `renderResult` for `apply_patch`; keep formatting and preview scanning in focused modules.
- Do not register `renderShell: "self"`; Pi's default shell owns pending/success/error backgrounds and output padding.
- Reuse Pi's `renderDiff`; do not implement a custom diff parser, syntax highlighter, or Codex-style tinted diff backgrounds. Pi's theme colors and terminal capability handling are the compatibility baseline.
- `src/preview.ts` may scan partial patch arguments for display only, including a bounded glimpse after arguments complete. It must be tolerant, bounded, cached, and never feed execution.
- The call row owns the summary; the result renderer adds diffs or the expand hint and must not repeat the summary.
- Do not repeat the success `content` text; render error `content` as-is.
- Preserve normal progress updates, errors, and returned `content`/`details`/`structuredContent`, including `displayDiff`, added/removed counts, and fuzz.
- Tests must assert summary labels/counts, roster and diff rendering, streaming bounds, error output, and unchanged execution/result data.

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
- Tool wiring changes: test registration, argument validation, model switching, and error signaling.
- Presentation changes: assert renderer output, streaming bounds, progress updates, and unmodified structured results.
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
