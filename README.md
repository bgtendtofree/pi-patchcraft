# Pi Patchcraft

Transactional Codex-style `apply_patch` tool for [Pi](https://pi.dev).

Patchcraft gives GPT models their familiar Codex patch language. It validates the full patch before mutation, serializes touched files through Pi's mutation queue, writes atomically, and rolls back already-applied changes when a later operation fails.

## Features

- Codex `*** Begin Patch` / `*** End Patch` format
- Add, update, delete, move, and rename-only operations
- Multi-file patches in one tool call
- Codex runtime parser with errors for malformed patches and unmatched hunks
- Relative, absolute, home-relative, and `file://` paths
- Full preflight before the first write
- Atomic per-file writes with mode preservation
- 1 MiB patch and 8 MiB source limits
- Best-effort patch-level rollback
- Concurrent source-change detection
- Exact, whitespace-tolerant, and punctuation-normalized context matching with a bounded comparison budget
- File symlink targets followed for Add and Update; the link is preserved
- Case- and normalization-insensitive conflict checks for two spellings of one file
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

Tool arguments must be an object with the required `patch` string. Extra properties such as `input` or `patchText` are ignored, and a raw string argument is rejected.

The tool declares an output schema, so a [`codemode`](https://pi.dev/docs/codemode) script receives `{ changes, added, removed, fuzz }` from `tools.apply_patch(...)` instead of the text result. The model-facing content is unchanged.

On OpenAI endpoints that support custom tools with grammar formats (GPT-5 and later on OpenAI, Azure OpenAI, Codex, and compatible gateways), Patchcraft declares the [Codex `apply_patch` grammar](https://github.com/openai/codex/blob/ca21fe65d18a9b6326759fb4263c65dfbb645aa5/codex-rs/core/assets/tools/apply_patch.lark). Those models write the patch as raw text instead of a JSON-escaped string; Pi maps that text to the `patch` parameter before validation. Everywhere else Pi falls back to the same JSON-schema function tool. Patchcraft selects the tool by model id and API; it does not inspect grammar capability itself.

The pinned Codex runtime parser is authoritative. Every `@@` needs a hunk body before the next `@@`. `Move to` also needs a hunk; use a context-only hunk to move a file without editing its lines. Codex's padded headers, bare blank update context lines, and recognized heredoc wrappers are accepted; wrappers are parsed as text, not executed. An `Add File` header with no `+` lines writes an empty file. Patchcraft operates locally and rejects Codex's `*** Environment ID:` routing directive before any write.

Content handling follows Codex: a context-less addition appends at end of file, lines parsed as context keep their original terminators (mixed line endings survive), inserted lines use the file's first line ending, and an update always terminates the final line. A leading BOM is part of the first line for matching and replacement. `Update File` and `Move` require valid UTF-8 source content; a non-UTF-8 source is rejected during preflight, before any mutation, because text matching would corrupt untouched bytes. `Add File` and `Delete File` handle arbitrary bytes.

## Tool mode

Patchcraft defaults to automatic mode: `gpt-*` models receive `apply_patch` in place of Pi `edit` and `write`; other models keep Pi's standard editing tools.

```text
/patchcraft          Show current mode and effective state
/patchcraft auto     Select by model id (default)
/patchcraft on       Force apply_patch for current session
/patchcraft off      Restore baseline edit/write for current session
```

Mode changes persist in current session across reloads, resumes, and tree navigation. New sessions default to `auto`.

Before enabling `apply_patch`, Patchcraft checks the core's protocol before each turn that would use it. If the core is missing or incompatible, your baseline editing tools stay available, even when `on` was requested. `/patchcraft` shows the reason. Fixing the install takes effect on the next turn; no reselect or `/reload` is needed.

Before changing tools, Patchcraft saves the active-tool baseline as session metadata. Reloads, resumes, tree navigation, and forks restore it from the active branch. Only `edit` and `write` that were enabled in that baseline are restored; other tools retain their current enabled/disabled state. New sessions capture their own baseline.

When the active branch has no valid baseline metadata, Patchcraft captures the current active tools. This also handles first-time loading and tree navigation before the metadata entry. If those tools were already replaced by Patchcraft, the original `edit`/`write` choices cannot be recovered reliably, so neither is guessed back on. Start a new session with the desired editing tools enabled to establish a fresh baseline.

For virtual models, Pi's `ctx.model` is the selected virtual model, not the physical model dispatched for each request. `auto` checks that selected id only; it does not detect GPT through routing. Use `/patchcraft on` to enable patches for a router with a non-`gpt-*` id.

## Safety semantics

Patchcraft intentionally fails instead of guessing:

- `Add File` creates the file, or overwrites an existing one like Codex; the previous content is captured for rollback.
- `Update File` targets must exist and resolve to a regular file. A file symlink is followed to its target for `Add File` and `Update File`, and the link is preserved; `Add File` creates the target of a dangling link. Link targets are walked component by component, so a `..` after a symlinked directory resolves against the real directory chain instead of being collapsed lexically. A dangling target under symlinked parents is canonicalized so it conflicts with a direct write to the same missing file. A target ending in a separator requires a directory and is rejected for a file write, including when it is dangling. `Delete File` and `Move` refuse a file symlink instead of deleting or moving its target.
- Patches are capped at 1 MiB and update sources at 8 MiB, rejected before any mutation.
- Move target must not exist. A `*** Move to:` that resolves to any existing file is rejected, including another spelling of the source itself on a case-insensitive filesystem.
- Paths resolve like Pi's built-in file tools, and header paths are trimmed of trailing whitespace like Codex; filesystem access follows process permissions.
- Conflicting operations touching the same source or destination are rejected. Two operations that resolve to the same file are rejected like Codex `multiple operations target`, so a repeated `*** Update File:` header is invalid; put multiple `@@` hunks with their bodies under one header. Rejecting a colliding move destination is stricter than Codex main ([openai/codex#53409](https://github.com/openai/codex/issues/53409)).
- Paths through symlinked parent directories are canonicalized before conflict checks, including the missing suffix of a dangling file symlink. Conflict comparison ignores case and Unicode normalization on every host, so a patch behaves the same on case-sensitive and case-insensitive filesystems: `a.txt` with `A.txt`, `café.txt` with `cafe\u0301.txt`, and two spellings of a not-yet-created target all conflict during preflight instead of colliding after apply or silently dropping content. The folded identity is used only for conflict comparison; it never turns a rejected move into an in-place update.
- A touched file may not also be a directory another operation must create: a file `folder` and a child `folder/child.txt` conflict during preflight, on path boundaries rather than a raw prefix, so `foo` and `foobar/x.txt` stay distinct. An alias of an ancestor directory conflicts the same way.
- No-op updates are rejected. Matching has an explicit comparison budget; a patch that would otherwise scan a huge non-matching sequence at every fuzz tier fails with a request to re-read the file and use smaller hunks instead of blocking the tool loop.
- Source content is revalidated after mutation queues are acquired. Permissions changed between planning and apply are rejected rather than overwritten. A target that exists must also be writable: a read-only file is refused like Pi `edit`/`write` and Codex, instead of being replaced by the atomic rename.
- Mutation-queue keys follow Pi: an existing file keys on its realpath, a not-yet-created target on the submitted lexical path Pi also uses for a missing file. Keys are resolved again at apply time, so a target that appears after planning (drift) cannot invert another plan's lock order and deadlock; the plan is then rejected by the post-lock revalidation.
- Per-file writes create a same-directory temporary with exclusive (`wx`) and target-restrictive mode, then rename. A failed temporary write is cleaned up; a cleanup or rollback failure is reported alongside the original error, and a temporary this operation did not create is never removed. Rollback tracks which filesystem steps actually completed: a write that never renamed its target is not restored, so a hardlinked target keeps its inode, and a partial move whose destination was written but whose source unlink failed only removes the destination copy. A move whose source was removed restores the source before removing the destination, so a destination that may be the only surviving copy is never deleted.

Mutation queues are process-local. Separate Pi sessions, shell commands, editors, and other processes do not honor them, so Patchcraft serializes only against concurrent Patchcraft and Pi file tools in the same process. Lock keys are sampled once at apply time; a symlink swapped after the final revalidation or a file created between that sample and the lock is not guaranteed to serialize, and a lexical spelling of a still-missing file other than the one Pi itself uses is not guaranteed to share its queue. This is best-effort same-process coordination, not a global filesystem lock.

Rollback also removes empty directories created by the patch; it never recursively removes a directory or its contents. This is not a crash-safe filesystem transaction: process termination or machine failure can leave partial state. If the core stops after commit without confirming the result, check the affected files before retrying.

## Install

Supported platforms are macOS (arm64) and Linux (x64); Windows is not supported.
Release tarballs bundle a matching core for both. These packages need no Rust
toolchain or install script. If published to npm, install
the package with `pi install npm:@bgtendtofree/pi-patchcraft`. You can also
extract the `.tgz` from a GitHub Release and run `pi install /absolute/path/to/package`.

For a Git checkout or another Unix-like platform, build the matching core from the
same checkout:

```bash
cargo install --locked --path rust/patchcraft-core
patchcraft-core doctor --json
```

The extension uses `PATCHCRAFT_BIN` if set to an absolute path, then its bundled
core, then `patchcraft-core` on `PATH`. The extension and CLI must speak the
same protocol (currently `4`). Git installs do not build the core automatically.

Then install the Pi extension:

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

Patchcraft registers `renderCall` and `renderResult`. The call row previews the request: a Codex-style summary, per-file counters while the patch streams, a multi-file roster, and a bounded glimpse of the focused file once the arguments are complete. When execution starts, a single-file call row keeps its header and counts; a multi-file call row keeps only the tool name, leaving the exact totals, roster, and diffs to the result row. The result row is self-contained: a single-file patch shows its full diff (matching Pi's `edit`), while a multi-file patch shows the exact counts and the roster, plus an expand hint when there are diffs; expanded results add bounded per-file diffs through Pi's native `renderDiff`.

```text
apply_patch  Edited src/app.ts (+3 -1)
```

```text
apply_patch  Edited 3 files
  └ M src/app.ts (+3 -1)
  └ A src/new.ts (+2 -0)
  └ D old.txt
```

Once the result arrives, the result row carries the exact totals and keeps the roster:

```text
Edited 3 files (+5 -2)
  └ M src/app.ts (+3 -1)
  └ A src/new.ts (+2 -0)
  └ D old.txt (+0 -1)
```

The result row carries its own summary and roster, so hosts that snapshot rows separately (for example the HTML exporter) still show the exact multi-file summary. Patchcraft does not register `renderShell: "self"`, so Pi's default row keeps pending/success/error backgrounds and output padding.

Patch execution and returned `content`, `details`, and `structuredContent` are unchanged, including per-file `displayDiff` and added/removed/fuzz counts.

## Development

Runtime requires Node.js `>=24` and the matching Rust executable. The project
uses Node.js 24.22.2, Pi 1.5.2, and stable Rust for local development and CI.

```bash
mise install
npm ci
npm run quality
npm run typecheck
npm test
npm run test:coverage
npm run package:check
npm run smoke:package
mise run ci
```

Load local source:

```bash
npm run build:core
PATCHCRAFT_BIN="$PWD/target/debug/patchcraft-core" pi -e ./src/index.ts
```

### Core and Pi adapter

[`rust/patchcraft-core`](rust/patchcraft-core/README.md) owns parsing, matching,
path resolution, planning, writes, and rollback. Pi holds its native file
queues from commit authorization through the core's exit, including rollback.
TypeScript only registers the tool, drives the session, and formats the
streaming preview and final diff. Run `mise run rust:check` for core tests
and `mise run ci` for the full gate, including the packed extension with the
real CLI.

Tests follow the same ownership boundary:

- `rust/patchcraft-core/tests/` covers core matrices that do not need the Pi host: parsing,
  matching, transaction preconditions, and filesystem outcomes.
- `test/core.test.ts` and `test/apply.test.ts` keep only the TS client seam: diff frames, Pi
  mutation queues, abort/close, error mapping, and the mirrored protocol limits.
- `test/index.test.ts`, `test/tools.test.ts`, `test/render.test.ts`, `test/preview.test.ts`, and
  `test/patch-format.test.ts` cover the extension host, loadout restore, and TUI contracts.

## Compatibility

Development and smoke tests pin Node.js 24.22.2 through mise, locked npm dependencies, Pi 1.5.2,
and TypeScript 7. Runtime dependencies stay `"*"` peer dependencies.

For example, enable codemode while excluding Pi's `write` tool:

```bash
pi -e ./src/index.ts --tools +codemode,-write
```

This changes tool selection, not filesystem permissions: `apply_patch` can still add and update files. `/patchcraft off` restores only the baseline editing tools.

## License

MIT, except for the Codex-derived sources, grammar, and test fixtures identified
in [`rust/patchcraft-core`](rust/patchcraft-core/README.md), which are Apache-2.0.
