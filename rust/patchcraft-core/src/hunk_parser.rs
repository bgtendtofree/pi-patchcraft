// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenAI Codex's streaming_parser.rs; see rust/patchcraft-core/README.md.

use crate::parser::ADD_FILE_MARKER;
use crate::parser::CHANGE_CONTEXT_MARKER;
use crate::parser::DELETE_FILE_MARKER;
use crate::parser::EMPTY_CHANGE_CONTEXT_MARKER;
use crate::parser::END_PATCH_MARKER;
use crate::parser::EOF_MARKER;
use crate::parser::Hunk;
use crate::parser::MOVE_TO_MARKER;
use crate::parser::ParseError;
use crate::parser::ParsedPatch;
use crate::parser::UPDATE_FILE_MARKER;
use crate::parser::UpdateFileChunk;

use Hunk::*;
use ParseError::*;

const ENVIRONMENT_ID_MARKER: &str = "*** Environment ID:";

#[derive(Default)]
pub(crate) struct PatchParser {
    mode: ParserMode,
    hunks: Vec<Hunk>,
    environment_id: Option<String>,
    line_number: usize,
}

#[derive(Default, Clone, Copy)]
enum ParserMode {
    #[default]
    StartedPatch,
    AddFile,
    DeleteFile,
    UpdateFile {
        hunk_line_number: usize,
    },
    EndedPatch,
}

impl PatchParser {
    /// The caller has already validated the begin/end markers (and removed a heredoc wrapper).
    pub(crate) fn parse(lines: &[&str]) -> Result<ParsedPatch, ParseError> {
        let mut parser = Self::default();
        let end = lines.len() - 1;
        for (index, line) in lines[1..end].iter().enumerate() {
            parser.line_number = index + 2;
            // Preserve the pinned parser's normalization after the outer `str::lines()` pass.
            parser.process_line(line.strip_suffix('\r').unwrap_or(line))?;
        }
        // The final marker is recognized even if padded inside an update hunk.
        parser.line_number = lines.len();
        parser.ensure_update_hunk_is_not_empty(END_PATCH_MARKER)?;
        Ok(ParsedPatch {
            hunks: parser.hunks,
            environment_id: parser.environment_id,
        })
    }

    fn ensure_update_hunk_is_not_empty(&self, line: &str) -> Result<(), ParseError> {
        if let Some(UpdateFile { path, chunks, .. }) = self.hunks.last() {
            if chunks.is_empty()
                && let ParserMode::UpdateFile { hunk_line_number } = self.mode
            {
                return Err(InvalidHunkError {
                    message: format!("Update file hunk for path '{path}' is empty"),
                    line_number: hunk_line_number,
                });
            }
            if chunks
                .last()
                .is_some_and(|chunk| chunk.old_lines.is_empty() && chunk.new_lines.is_empty())
            {
                if line == END_PATCH_MARKER {
                    return Err(InvalidHunkError {
                        message: "Update hunk does not contain any lines".to_string(),
                        line_number: self.line_number,
                    });
                }
                return Err(InvalidHunkError {
                    message: format!(
                        "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                    ),
                    line_number: self.line_number,
                });
            }
        }
        Ok(())
    }

    fn handle_hunk_headers_and_end_patch(&mut self, trimmed: &str) -> Result<bool, ParseError> {
        if matches!(self.mode, ParserMode::StartedPatch)
            && let Some(environment_id) = trimmed.strip_prefix(ENVIRONMENT_ID_MARKER)
        {
            if self.environment_id.is_some() {
                return Err(InvalidPatchError(
                    "apply_patch environment_id cannot be specified more than once".to_string(),
                ));
            }
            let environment_id = environment_id.trim();
            if environment_id.is_empty() {
                return Err(InvalidPatchError(
                    "apply_patch environment_id cannot be empty".to_string(),
                ));
            }
            self.environment_id = Some(environment_id.to_string());
            return Ok(true);
        }
        if trimmed == END_PATCH_MARKER {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.mode = ParserMode::EndedPatch;
            return Ok(true);
        }
        if let Some(path) = trimmed.strip_prefix(ADD_FILE_MARKER) {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.hunks.push(AddFile {
                path: String::from(path),
                contents: String::new(),
            });
            self.mode = ParserMode::AddFile;
            return Ok(true);
        }
        if let Some(path) = trimmed.strip_prefix(DELETE_FILE_MARKER) {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.hunks.push(DeleteFile {
                path: String::from(path),
            });
            self.mode = ParserMode::DeleteFile;
            return Ok(true);
        }
        if let Some(path) = trimmed.strip_prefix(UPDATE_FILE_MARKER) {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.hunks.push(UpdateFile {
                path: String::from(path),
                move_path: None,
                chunks: Vec::new(),
            });
            self.mode = ParserMode::UpdateFile {
                hunk_line_number: self.line_number,
            };
            return Ok(true);
        }
        Ok(false)
    }

    fn process_line(&mut self, line: &str) -> Result<(), ParseError> {
        let trimmed = line.trim();
        match self.mode {
            ParserMode::StartedPatch | ParserMode::DeleteFile => {
                if self.handle_hunk_headers_and_end_patch(trimmed)? {
                    return Ok(());
                }
                Err(InvalidHunkError {
                    message: format!(
                        "'{trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
                    ),
                    line_number: self.line_number,
                })
            }
            ParserMode::AddFile => {
                if self.handle_hunk_headers_and_end_patch(trimmed)? {
                    return Ok(());
                }
                if let Some(line_to_add) = line.strip_prefix('+')
                    && let Some(AddFile { contents, .. }) = self.hunks.last_mut()
                {
                    contents.push_str(line_to_add);
                    contents.push('\n');
                    return Ok(());
                }
                Err(InvalidHunkError {
                    message: format!(
                        "'{trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
                    ),
                    line_number: self.line_number,
                })
            }
            ParserMode::UpdateFile { .. } => {
                let update_line = line.trim_end();
                if self.handle_hunk_headers_and_end_patch(update_line)? {
                    return Ok(());
                }

                if let Some(UpdateFile {
                    move_path, chunks, ..
                }) = self.hunks.last_mut()
                {
                    if chunks.last().is_some_and(|chunk| chunk.is_end_of_file) {
                        if update_line.is_empty() {
                            return Ok(());
                        }
                        if update_line != EMPTY_CHANGE_CONTEXT_MARKER
                            && !update_line.starts_with(CHANGE_CONTEXT_MARKER)
                        {
                            return Err(InvalidHunkError {
                                message: format!(
                                    "Expected update hunk to start with a @@ context marker, got: '{line}'"
                                ),
                                line_number: self.line_number,
                            });
                        }
                    }

                    if chunks.is_empty()
                        && move_path.is_none()
                        && let Some(move_to_path) = update_line.strip_prefix(MOVE_TO_MARKER)
                    {
                        *move_path = Some(String::from(move_to_path));
                        return Ok(());
                    }

                    if (update_line == EMPTY_CHANGE_CONTEXT_MARKER
                        || update_line.starts_with(CHANGE_CONTEXT_MARKER))
                        && chunks.last().is_some_and(|chunk| {
                            chunk.old_lines.is_empty() && chunk.new_lines.is_empty()
                        })
                    {
                        return Err(InvalidHunkError {
                            message: format!(
                                "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                            ),
                            line_number: self.line_number,
                        });
                    }

                    if update_line == EMPTY_CHANGE_CONTEXT_MARKER {
                        chunks.push(UpdateFileChunk::default());
                        return Ok(());
                    }

                    if let Some(change_context) = update_line.strip_prefix(CHANGE_CONTEXT_MARKER) {
                        chunks.push(UpdateFileChunk {
                            change_context: Some(change_context.to_string()),
                            ..UpdateFileChunk::default()
                        });
                        return Ok(());
                    }

                    if update_line == EOF_MARKER {
                        if chunks.last().is_some_and(|chunk| {
                            chunk.old_lines.is_empty() && chunk.new_lines.is_empty()
                        }) {
                            return Err(InvalidHunkError {
                                message: "Update hunk does not contain any lines".to_string(),
                                line_number: self.line_number,
                            });
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.is_end_of_file = true;
                        }
                        return Ok(());
                    }

                    if line.is_empty() {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.push_context_line(String::new());
                        }
                        return Ok(());
                    }

                    if let Some(line_to_add) = line.strip_prefix(' ') {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.push_context_line(line_to_add.to_string());
                        }
                        return Ok(());
                    }

                    if let Some(line_to_add) = line.strip_prefix('+') {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.new_lines.push(line_to_add.to_string());
                        }
                        return Ok(());
                    }

                    if let Some(line_to_remove) = line.strip_prefix('-') {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.old_lines.push(line_to_remove.to_string());
                        }
                        return Ok(());
                    }

                    if chunks.last().is_some_and(|chunk| {
                        !chunk.old_lines.is_empty() || !chunk.new_lines.is_empty()
                    }) {
                        return Err(InvalidHunkError {
                            message: format!(
                                "Expected update hunk to start with a @@ context marker, got: '{line}'"
                            ),
                            line_number: self.line_number,
                        });
                    }
                }
                Err(InvalidHunkError {
                    message: format!(
                        "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                    ),
                    line_number: self.line_number,
                })
            }
            ParserMode::EndedPatch => {
                if trimmed.is_empty() {
                    Ok(())
                } else {
                    Err(InvalidPatchError(
                        "The last line of the patch must be '*** End Patch'".to_string(),
                    ))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::{Hunk, ParseError, parse_patch};

    #[test]
    fn keeps_indented_markers_and_bare_blank_lines_as_context() {
        let parsed = parse_patch(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n *** Update File: b.txt\n\n *** End Patch",
        )
        .unwrap();
        let [Hunk::UpdateFile { chunks, .. }] = parsed.hunks.as_slice() else {
            panic!("expected one update");
        };
        let [chunk] = chunks.as_slice() else {
            panic!("expected one chunk");
        };
        assert_eq!(chunk.old_lines, ["old", "*** Update File: b.txt", ""]);
        assert_eq!(chunk.new_lines, ["new", "*** Update File: b.txt", ""]);
        assert_eq!(chunk.context_line_indices, [(1, 1), (2, 2)]);
    }

    #[test]
    fn keeps_the_pinned_crlf_normalization() {
        for old_line in ["-old\r\n", "-old\r\r\n"] {
            let patch = format!(
                "*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n{old_line}+new\r\n*** End Patch\r\n"
            );
            let parsed = parse_patch(&patch).unwrap();
            let [Hunk::UpdateFile { chunks, .. }] = parsed.hunks.as_slice() else {
                panic!("expected one update");
            };
            assert_eq!(chunks[0].old_lines, ["old"]);
            assert_eq!(chunks[0].new_lines, ["new"]);
        }
    }

    #[test]
    fn rejects_content_after_an_early_end_marker() {
        assert_eq!(
            parse_patch("*** Begin Patch\n*** End Patch\nextra\n*** End Patch"),
            Err(ParseError::InvalidPatchError(
                "The last line of the patch must be '*** End Patch'".into()
            ))
        );
    }

    #[test]
    fn rejects_duplicate_environment_directives() {
        assert_eq!(
            parse_patch(
                "*** Begin Patch\n*** Environment ID: a\n*** Environment ID: b\n*** End Patch"
            ),
            Err(ParseError::InvalidPatchError(
                "apply_patch environment_id cannot be specified more than once".into()
            ))
        );
    }

    #[test]
    fn diagnoses_empty_and_malformed_update_chunks_at_the_right_line() {
        for (body, line, message) in [
            (
                "*** Move to: moved.txt\n*** Delete File: other.txt\n",
                2,
                "Update file hunk for path 'a.txt' is empty",
            ),
            ("@@\n", 4, "Update hunk does not contain any lines"),
            (
                "@@\n*** End of File\n",
                4,
                "Update hunk does not contain any lines",
            ),
            ("@@\n@@\n", 4, "Unexpected line found in update hunk: '@@'"),
            (
                "@@\n*** Update File: other.txt\n",
                4,
                "Unexpected line found in update hunk: '*** Update File: other.txt'",
            ),
            (
                "@@\n-old\nbad\n",
                5,
                "Expected update hunk to start with a @@ context marker",
            ),
        ] {
            let patch = format!("*** Begin Patch\n*** Update File: a.txt\n{body}*** End Patch");
            let Err(ParseError::InvalidHunkError {
                line_number,
                message: actual,
            }) = parse_patch(&patch)
            else {
                panic!("expected an invalid hunk: {body:?}");
            };
            assert_eq!(line_number, line, "{body:?}");
            assert!(actual.starts_with(message), "{actual}");
        }
    }
}
