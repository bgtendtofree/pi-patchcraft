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

## Pi protocol (version 2)

Pi starts `patchcraft-core session --json` in the workspace directory. The
one-shot session uses newline-delimited JSON on stdout. On stdin the host sends
one JSON line `{"protocol":2,"patch":"..."}` and keeps the pipe open.

1. The core plans without writing. It sends one `{"status":"change", ...}`
   frame per change, with operation metadata and `before`/`after` bytes in
   base64 for Pi's native diff renderer. Then it sends
   `{"protocol":2,"status":"planned","lockPaths":[...]}`.
2. Only after acquiring Pi's queues for those paths, the host writes the
   literal line `commit\n`. The plan stays in Rust; the host cannot send back
   changed paths, snapshots, or chunks.
3. The core revalidates and applies the plan, then replies
   `{"protocol":2,"status":"applied"}` and exits `0`. Errors use
   `{"protocol":2,"status":"error","message":"..."}` and exit `1`.

Closing stdin discards a plan before commit or requests cooperative
cancellation after commit. Keep the pipe open until the result during normal
execution. On cancellation Pi waits for exit, including rollback, before
releasing its queues. A cancellation observed after the final commit boundary
does not undo a successful patch. Rollback is not crash recovery.

## Upstream code

From [OpenAI Codex at `ca21fe65d18a9b6326759fb4263c65dfbb645aa5`](https://github.com/openai/codex/tree/ca21fe65d18a9b6326759fb4263c65dfbb645aa5/codex-rs/apply-patch/src):

- `text_file.rs` reuses line-ending preservation and replacement code.
- `file_update.rs` adapts replacement computation to supplied text.
- `seek_sequence.rs` adapts matching tiers and Unicode punctuation mapping,
  with Patchcraft's fuzz counts and comparison budget.

Those files are Apache-2.0; see [LICENSE](licenses/LICENSE) and
[NOTICE](licenses/NOTICE). The parser preserves Patchcraft's existing strict
envelope (including stacked contexts and move-only operations), rather than
substituting Codex's streaming parser. The rest of the core is MIT.
