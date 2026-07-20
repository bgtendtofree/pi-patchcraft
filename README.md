# Pi Patchcraft

Transactional Codex-style `apply_patch` tool for [Pi](https://pi.dev).

Patchcraft gives GPT and Codex-family models their familiar patch language while keeping file changes inside the active workspace. It validates the full patch before mutation, serializes touched files through Pi's mutation queue, writes atomically, and rolls back already-applied changes when a later operation fails.

## Features

- Codex `*** Begin Patch` / `*** End Patch` format
- Add, update, delete, move, and rename-only operations
- Multi-file patches in one tool call
- Strict parser with actionable errors
- Workspace traversal and symlink-escape protection
- Full preflight before the first write
- Atomic per-file writes with mode preservation
- Best-effort patch-level rollback
- Concurrent source-change detection
- Exact, whitespace-tolerant, and Unicode-normalized context matching
- Automatic `apply_patch` activation for GPT/Codex models
- Automatic restoration of Pi `edit` / `write` tools for other models
- Optional [Pi Progressive Tools](https://github.com/bgtendtofree/pi-progressive-tools) compact rendering
- Independent fallback renderer when Progressive Tools is absent

## Patch format

```text
*** Begin Patch
*** Add File: src/new.ts
+export const value = 1;
*** Update File: src/app.ts
@@ function main() {
-oldCall();
+newCall();
*** Update File: src/old.ts
*** Move to: src/moved.ts
*** Delete File: src/obsolete.ts
*** End Patch
```

Tool input uses Pi's public JSON tool API:

```json
{
  "patch": "*** Begin Patch\n...\n*** End Patch"
}
```

Compatibility input names `input` and `patchText`, plus raw string arguments, are normalized before schema validation.

## Safety semantics

Patchcraft intentionally fails instead of guessing:

- `Add File` target must not exist.
- `Update File` and `Delete File` targets must exist and be regular files.
- Move target must not exist.
- Absolute paths and parent traversal are rejected.
- Workspace symlink escapes are rejected.
- Conflicting operations touching the same source or destination are rejected.
- No-op updates are rejected.
- Source content is revalidated after mutation queues are acquired.

Patch-level rollback handles ordinary runtime failures. It is not a crash-safe filesystem transaction: process termination or machine failure during mutation can still leave partial state.

## Install

```bash
pi install git:github.com/bgtendtofree/pi-patchcraft
```

Project-local:

```bash
pi install -l git:github.com/bgtendtofree/pi-patchcraft
```

One run:

```bash
pi -e git:github.com/bgtendtofree/pi-patchcraft
```

For compact tool rows and transcript detail navigation, install Progressive Tools too:

```bash
pi install git:github.com/bgtendtofree/pi-progressive-tools
```

Both extension load orders are supported through Progressive Tools provider protocol v1.

## Development

Bun is development tooling. Runtime remains Node.js through Pi.

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

Load local source:

```bash
pi --offline --no-extensions -e . --list-models
pi -e ./src/index.ts
```

## Current compatibility

Development and package smoke tests pin:

- Node.js 24
- Bun 1.3.14
- Pi 0.80.10
- TypeScript 7

Pi runtime dependencies remain `"*"` peer dependencies.

## License

MIT
