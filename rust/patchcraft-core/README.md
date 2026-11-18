# Patchcraft core

`patchcraft-core` is the single execution engine for Patchcraft. It owns patch
parsing, matching, path resolution, conflict checks, writes, and rollback.

## Standalone use

```sh
cargo install --locked --path rust/patchcraft-core
patchcraft-core doctor --json
patchcraft-core apply --json < /path/to/edit.patch
```

Run `apply` from the directory that relative patch paths should resolve
against. It reads one UTF-8 patch from stdin and prints a JSON operation
summary on success (exit `0`) or an error message on failure (exit `1`).
Standalone use does not participate in Pi's process-local file queues.

## Pi protocol (version 4)

Pi starts `patchcraft-core session --json` in the workspace directory. The
one-shot session uses newline-delimited JSON on stdout. On stdin the host sends
one JSON line `{"protocol":4,"cwd":"/logical/workspace","patch":"..."}` and
keeps the pipe open. The absolute `cwd` must identify the child process's
working directory. Its original spelling is used for Pi's missing-file queues.

1. The core plans without writing. It sends one `{"status":"change", ...}`
   frame per change, with `change` metadata and either `before`/`after`
   snapshots in base64 or a `window`. A window describes one unambiguous
   single-line replacement in an LF-terminated UTF-8 file of at least 1 MiB: `line`
   (1-based), `totalLines` (excluding the final LF's empty element),
   `before`/`after` line text, and up to four unchanged `leading` and
   `trailing` lines. Pi uses the same display format for both paths. Then
   the core sends `{"protocol":4,"status":"planned","lockPaths":[...]}`.
2. Only after acquiring Pi's queues for those paths, the host writes the
   literal line `commit\n`. The plan stays in Rust; the host cannot send back
   changed paths, snapshots, or chunks.
3. The core revalidates and applies the plan, then replies
   `{"protocol":4,"status":"applied"}` and exits `0`. Errors use
   `{"protocol":4,"status":"error","message":"..."}` and exit `1`.

Closing stdin discards a plan before commit or requests cooperative
cancellation after commit. Keep the pipe open until the result during normal
execution. On cancellation Pi waits for exit, including rollback, before
releasing its queues. A cancellation observed after the final commit boundary
does not undo a successful patch. Rollback is not crash recovery.

## Upstream code

From [OpenAI Codex at `ca21fe65d18a9b6326759fb4263c65dfbb645aa5`](https://github.com/openai/codex/tree/ca21fe65d18a9b6326759fb4263c65dfbb645aa5):

- `src/parser.rs` and `src/streaming_parser.rs` reuse the runtime parser from
  `codex-rs/apply-patch/src/`. The port removes Codex's `PathUri` integration
  and returns only hunks and the environment directive; it adds no syntax rules.
- `src/file_update.rs` uses the same replacement computation on text supplied
  by the transaction. `src/seek_sequence.rs` uses the same match order,
  whitespace, and punctuation rules, with a comparison budget and fuzz
  accounting. `src/text_file.rs` borrows line text while retaining the original
  newline handling.
- `src/grammar.ts` in the Pi package embeds
  `codex-rs/core/assets/tools/apply_patch.lark` unchanged.
- `tests/fixtures/codex/` is the complete upstream scenario suite. The CLI
  test runs all 25 cases, checking exact file bytes. The only expected
  differences are scenarios **010** (no overwriting move destinations) and
  **015** (preflight failures leave the workspace untouched).

The upstream material is Apache-2.0; see [LICENSE](licenses/LICENSE) and
[NOTICE](licenses/NOTICE). On upgrade, refresh parser and fixtures together
and run `mise run ci`. `scripts/check-codex.mjs` checks the grammar blob and
scenario tree against Git object IDs from the pinned revision without network
access. The adapted Rust files are checked by behavior, not byte-for-byte.
Local transaction policy stays outside the parser:
size limits, path validation, no remote routing, no-op update rejection,
conflict checks, and rollback. The rest of the core is MIT.
