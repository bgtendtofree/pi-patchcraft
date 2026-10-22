# Pi Patchcraft

Transactional Codex-style `apply_patch` tool for [Pi](https://pi.dev).

Patchcraft gives GPT models their familiar Codex patch language. It validates the full patch before mutation, serializes touched files through Pi's mutation queue, writes atomically, and rolls back already-applied changes when a later operation fails.

## Features

- Codex `*** Begin Patch` / `*** End Patch` format
- Add, update, delete, move, and rename-only operations
- Multi-file patches in one tool call
- Strict parser with actionable errors, including truncation and closest-match line hints
- Relative, absolute, home-relative, and `file://` paths
- Full preflight before the first write
- Atomic per-file writes with mode preservation
- 1 MiB patch and 64 MiB source limits
- Best-effort patch-level rollback
- Concurrent source-change detection
- Exact, whitespace-tolerant, and punctuation-normalized context matching
- File symlink targets followed for Add and Update; the link is preserved
- Automatic `apply_patch` activation for `gpt-*` and Codex Responses models
- Grammar-constrained patch text on OpenAI models that support custom tools
- Structured result for `codemode` scripts (`changes`, `added`, `removed`, `fuzz`)
- Automatic restoration of Pi `edit` / `write` tools for other models
- Session-scoped `/patchcraft auto|on|off` override for any model
- Codex-style summary with per-file counts, add/update/delete/move labels, and a multi-file roster
- Per-file diffs rendered with Pi's native diff renderer, collapsed or expanded
- Streaming per-file counters while the patch is generated
- Native Pi components and diff renderer, no custom shell

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

Tool arguments must use `{ patch: string }`. The aliases `input` and `patchText`, and raw string arguments, are not accepted.

The tool declares an output schema, so a [`codemode`](https://pi.dev/docs/codemode) script receives `{ changes, added, removed, fuzz }` from `tools.apply_patch(...)` instead of the text result. The model-facing content is unchanged.

On OpenAI endpoints that support custom tools with grammar formats (GPT-5 and later on OpenAI, Azure OpenAI, Codex, and compatible gateways), Patchcraft declares the [Codex `apply_patch` grammar](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_apply_patch.lark). Those models write the patch as raw text instead of a JSON-escaped string; Pi maps that text to the `patch` parameter before validation. Everywhere else Pi falls back to the same JSON-schema function tool. Patchcraft selects the tool by model id and API; it does not inspect grammar capability itself.

Content handling follows Codex: a context-less addition appends at end of file, lines parsed as context keep their original terminators (mixed line endings survive), inserted lines use the file's first line ending, and an update always terminates the final line. A leading BOM is preserved. `Update File` and `Move` require valid UTF-8 source content; a non-UTF-8 source is rejected during preflight, before any mutation, because text matching would corrupt untouched bytes. `Add File` and `Delete File` handle arbitrary bytes.

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

When the active branch has no valid baseline metadata, Patchcraft captures the current active tools. This also handles first-time loading and tree navigation before the metadata entry. If those tools were already replaced by Patchcraft, the original `edit`/`write` choices cannot be recovered reliably, so neither is guessed back on. Start a new session with the desired editing tools enabled to establish a fresh baseline.

For virtual models, Pi's `ctx.model` is the selected virtual model, not the physical model dispatched for each request. `auto` checks that selected id only; it does not detect GPT through routing. Use `/patchcraft on` to enable patches for a router with a non-`gpt-*` id.

## Safety semantics

Patchcraft intentionally fails instead of guessing:

- `Add File` creates the file, or overwrites an existing one like Codex; the previous content is captured for rollback.
- `Update File` targets must exist and resolve to a regular file. A file symlink is followed to its target for `Add File` and `Update File`, and the link is preserved; `Add File` creates the target of a dangling link. `Delete File` and `Move` refuse a file symlink instead of deleting or moving its target.
- Patches are capped at 1 MiB and update sources at 64 MiB, rejected before any mutation.
- Move target must not exist. A `*** Move to:` that resolves to any existing file is rejected, including another spelling of the source itself on a case-insensitive filesystem.
- Paths resolve like Pi's built-in file tools, and header paths are trimmed of trailing whitespace like Codex; filesystem access follows process permissions.
- Conflicting operations touching the same source or destination are rejected. Two operations that resolve to the same file are rejected like Codex `multiple operations target`, so a repeated `*** Update File:` header is invalid; put multiple hunks in one block as stacked `@@` chunks. Rejecting a colliding move destination is stricter than Codex main ([openai/codex#53409](https://github.com/openai/codex/issues/53409)).
- Paths through symlinked parent directories are canonicalized before conflict checks. Genuinely case-sensitive filesystems keep `a.txt` and `A.txt` distinct. Case-insensitive name lookup and Unicode-normalization-insensitive name lookup are probed independently, read-only, and only when an envelope contains a potential alias pair, so a lone new file never lists its directory. A case alias of one existing file, a case or normalization alias of a not-yet-created target, and a normalization alias of a move destination (`café.txt` vs `cafe\u0301.txt`) all conflict instead of colliding after apply or silently dropping content. An axis whose probe cannot decide is treated as insensitive for that pair, so a possible collision fails closed; an axis the filesystem is proven sensitive for keeps the spellings distinct. The folded identity is used only for conflict comparison; it never turns a rejected move into an in-place update.
- A touched file may not also be a directory another operation must create: a file `folder` and a child `folder/child.txt` conflict during preflight, on path boundaries rather than a raw prefix, so `foo` and `foobar/x.txt` stay distinct. Case and normalization aliases of an ancestor directory conflict only when the filesystem actually equates the spelling.
- No-op updates are rejected.
- Source content is revalidated after mutation queues are acquired. Permissions changed between planning and apply are rejected rather than overwritten. A target that exists must also be writable: a read-only file is refused like Pi `edit`/`write` and Codex, instead of being replaced by the atomic rename.
- Mutation-queue keys follow Pi: an existing file keys on its realpath, a not-yet-created target on the submitted lexical path Pi also uses for a missing file. Keys are resolved again at apply time, so a target that appears after planning (drift) cannot invert another plan's lock order and deadlock; the plan is then rejected by the post-lock revalidation.
- Per-file writes create a same-directory temporary with exclusive (`wx`) and target-restrictive mode, then rename. A failed temporary write is cleaned up; a cleanup or rollback failure is reported alongside the original error, and a temporary this operation did not create is never removed. Rollback tracks which filesystem steps actually completed: a write that never renamed its target is not restored, so a hardlinked target keeps its inode, and a partial move whose destination was written but whose source unlink failed only removes the destination copy. A move whose source was removed restores the source before removing the destination, so a destination that may be the only surviving copy is never deleted.

Mutation queues are process-local. Separate Pi sessions, shell commands, editors, and other processes do not honor them, so Patchcraft serializes only against concurrent Patchcraft and Pi file tools in the same process. Lock keys are sampled once at apply time; a symlink swapped after the final revalidation or a file created between that sample and the lock is not guaranteed to serialize, and a lexical spelling of a still-missing file other than the one Pi itself uses is not guaranteed to share its queue. This is best-effort same-process coordination, not a global filesystem lock.

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

## Rendering

Patchcraft registers `renderCall` and `renderResult`. The call row shows a Codex-style summary, per-file counters while the patch streams, and a multi-file roster. The call row owns the summary; the result row adds each file's diff through Pi's native `renderDiff`.

```text
apply_patch  Edited src/app.ts (+3 -1)
```

```text
apply_patch  Edited 3 files (+5 -2)
  └ M src/app.ts (+3 -1)
  └ A src/new.ts (+2 -0)
  └ D old.txt (+0 -1)
```

A single-file patch shows its diff immediately; a multi-file patch shows the roster and an expand hint until expanded, then all per-file diffs. It does not register `renderShell: "self"`, so Pi's default row keeps pending/success/error backgrounds and output padding.

Patch execution and returned `content`, `details`, and `structuredContent` are unchanged, including per-file `displayDiff` and added/removed/fuzz counts.

## Development

Runtime contract is Node.js `>=24`. Project mise config pins local development and CI to Node 24.19.0 with Pi 1.4.0.

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
- Pi 1.4.0
- TypeScript 7

Pi 1.4.0 is the development baseline; runtime dependencies remain `"*"` peer dependencies. Grammar sampling, structured results, file mutation queues, and codemode prompt guidelines are unchanged.

Relevant Pi 1.3/1.4 changes:

| Feature / API | Patchcraft impact |
|---|---|
| Resumed sessions keep their active tools (1.3) | Patchcraft captures its baseline before the first replacement and restores only managed `edit`/`write`; reload, resume, tree, and fork tests cover this. |
| Extension tools active unless `defaultActive: false` (1.4) | A branch without baseline metadata still captures the current tools conservatively instead of guessing `edit`/`write` back on. |
| `before_agent_start` union and busy-during-start | Patchcraft ignores the event body and calls `syncTools(ctx)`; it never sends a message during start. |
| Codemode waits for a free worker | No Patchcraft change; `tools.apply_patch()` still returns the same structured result. |

For example, enable codemode while excluding Pi's `write` tool:

```bash
pi -e ./src/index.ts --tools +codemode,-write
```

This changes tool selection, not filesystem permissions: `apply_patch` can still add and update files. `/patchcraft off` restores only the baseline editing tools.

## License

MIT
