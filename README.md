# Pi Patchcraft

Transactional Codex-style `apply_patch` tool for [Pi](https://pi.dev).

Patchcraft gives GPT models their familiar Codex patch language. It validates the full patch before mutation, serializes touched files through Pi's mutation queue, writes atomically, and rolls back already-applied changes when a later operation fails.

## Features

- Codex `*** Begin Patch` / `*** End Patch` format
- Add, update, delete, move, and rename-only operations
- Multi-file patches in one tool call
- Strict parser with actionable errors
- Relative, absolute, home-relative, and `file://` paths
- Full preflight before the first write
- Atomic per-file writes with mode preservation
- Best-effort patch-level rollback
- Concurrent source-change detection
- Exact, whitespace-tolerant, and Unicode-normalized context matching
- Automatic `apply_patch` activation for `gpt-*` models
- Grammar-constrained patch text on OpenAI models that support custom tools
- Structured result for `codemode` scripts (`changes`, `added`, `removed`, `fuzz`)
- Automatic restoration of Pi `edit` / `write` tools for other models
- Session-scoped `/patchcraft auto|on|off` override for any model
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

The tool declares an output schema, so a [`codemode`](https://pi.dev/docs/codemode) script receives `{ changes, added, removed, fuzz }` from `tools.apply_patch(...)` instead of the text result. The model-facing content is unchanged.

On OpenAI endpoints that support custom tools with grammar formats (GPT-5 and later on OpenAI, Azure OpenAI, Codex, and compatible gateways), Patchcraft declares the [Codex `apply_patch` grammar](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_apply_patch.lark). Those models write the patch as raw text instead of a JSON-escaped string. Everywhere else Pi falls back to the same JSON-schema function tool, so Patchcraft does not detect model capabilities itself.

## Tool mode

Patchcraft defaults to automatic mode: `gpt-*` models receive `apply_patch` in place of Pi `edit` and `write`; other models keep Pi's standard editing tools.

```text
/patchcraft          Show current mode and effective state
/patchcraft auto     Select by model id (default)
/patchcraft on       Force apply_patch for current session
/patchcraft off      Restore baseline edit/write for current session
```

Mode changes persist in current session across reloads, resumes, and tree navigation. New sessions default to `auto`.

Before changing tools, Patchcraft saves the active-tool baseline as session metadata. Reloads, resumes, tree navigation, and forks restore it from the active branch. Only `edit` and `write` that were enabled in that baseline are restored; other tools retain their current enabled/disabled state. New sessions capture their own baseline.

Older sessions without baseline metadata use the current active tools conservatively. If those tools were already replaced by Patchcraft, the original `edit`/`write` choices cannot be recovered reliably, so neither is guessed back on. Start a new session with the desired editing tools enabled to establish a fresh baseline.

For virtual models, Pi's `ctx.model` is the selected virtual model, not the physical model dispatched for each request. `auto` checks that selected id only; it does not detect GPT through routing. Use `/patchcraft on` to enable patches for a router with a non-`gpt-*` id.

## Safety semantics

Patchcraft intentionally fails instead of guessing:

- `Add File` target must not exist.
- `Update File` and `Delete File` targets must exist and be regular files.
- Move target must not exist.
- Paths resolve like Pi's built-in file tools; filesystem access follows process permissions.
- Conflicting operations touching the same source or destination are rejected.
- Paths through symlinked parent directories are canonicalized before conflict checks and mutation locking.
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

For compact tool rows and per-file native diff views in Transcript Navigator, install Progressive Tools too:

```bash
pi install git:github.com/bgtendtofree/pi-progressive-tools
```

Both extension load orders are supported through Progressive Tools provider protocol v2. Press `y` in Block Reader to copy the original transcript result. Result metadata stores diffs instead of full file snapshots.

## Development

Runtime contract is Node.js `>=24`. Project mise config pins local development and CI to Node 24.19.0 with Pi 1.0.0.

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

Load local source:

```bash
npm run smoke:package
pi -e ./src/index.ts
```

## Current compatibility

Development and package smoke tests pin:

- Node.js 24.19.0 through mise
- npm locked dependencies
- Pi 1.0.0
- TypeScript 7

Pi runtime dependencies remain `"*"` peer dependencies.

## License

MIT
