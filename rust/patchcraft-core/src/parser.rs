// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenAI Codex; see rust/patchcraft-core/README.md.

//! This module is responsible for parsing & validating a patch into a list of "hunks".
//! (It does not attempt to actually check that the patch can be applied to the filesystem.)
//!
//! The official Lark grammar for the apply-patch format is:
//!
//! start: begin_patch environment_id? hunk+ end_patch
//! begin_patch: "*** Begin Patch" LF
//! environment_id: "*** Environment ID: " filename LF
//! end_patch: "*** End Patch" LF?
//!
//! hunk: add_hunk | delete_hunk | update_hunk
//! add_hunk: "*** Add File: " filename LF add_line+
//! delete_hunk: "*** Delete File: " filename LF
//! update_hunk: "*** Update File: " filename LF change_move? change?
//! filename: /(.+)/
//! add_line: "+" /(.+)/ LF -> line
//!
//! change_move: "*** Move to: " filename LF
//! change: (change_context | change_line)+ eof_line?
//! change_context: ("@@" | "@@ " /(.+)/) LF
//! change_line: ("+" | "-" | " ") /(.+)/ LF
//! eof_line: "*** End of File" LF
//!
//! The parser below is a little more lenient than the explicit spec and allows for
//! leading/trailing whitespace around patch markers.
use crate::streaming_parser::StreamingPatchParser;

use thiserror::Error;

pub(crate) const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
pub(crate) const END_PATCH_MARKER: &str = "*** End Patch";
pub(crate) const ADD_FILE_MARKER: &str = "*** Add File: ";
pub(crate) const DELETE_FILE_MARKER: &str = "*** Delete File: ";
pub(crate) const UPDATE_FILE_MARKER: &str = "*** Update File: ";
pub(crate) const MOVE_TO_MARKER: &str = "*** Move to: ";
pub(crate) const EOF_MARKER: &str = "*** End of File";
pub(crate) const CHANGE_CONTEXT_MARKER: &str = "@@ ";
pub(crate) const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";

#[derive(Debug, PartialEq, Error, Clone)]
pub enum ParseError {
    #[error("invalid patch: {0}")]
    InvalidPatchError(String),
    #[error("invalid hunk at line {line_number}, {message}")]
    InvalidHunkError { message: String, line_number: usize },
}
use ParseError::*;

#[derive(Debug, PartialEq, Clone)]
#[allow(clippy::enum_variant_names)]
pub enum Hunk {
    AddFile {
        path: String,
        contents: String,
    },
    DeleteFile {
        path: String,
    },
    UpdateFile {
        path: String,
        move_path: Option<String>,

        /// Chunks should be in order, i.e. the `change_context` of one chunk
        /// should occur later in the file than the previous chunk.
        chunks: Vec<UpdateFileChunk>,
    },
}

#[cfg(test)]
use Hunk::*;

#[derive(Debug, Default, PartialEq, Clone)]
pub struct UpdateFileChunk {
    /// A single line of context used to narrow down the position of the chunk
    /// (this is usually a class, method, or function definition.)
    pub change_context: Option<String>,

    /// A contiguous block of lines that should be replaced with `new_lines`.
    /// `old_lines` must occur strictly after `change_context`.
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,

    /// Pairs of indices into `old_lines` and `new_lines` that identify lines
    /// parsed as context rather than inferred to be equal by their contents.
    pub context_line_indices: Vec<(usize, usize)>,

    /// If set to true, `old_lines` must occur at the end of the source file.
    /// (Tolerance around trailing newlines should be encouraged.)
    pub is_end_of_file: bool,
}

impl UpdateFileChunk {
    /// Adds a context line to both sides while recording its corresponding
    /// indices so it remains distinguishable from identical changed lines.
    pub(crate) fn push_context_line(&mut self, line: String) {
        self.context_line_indices
            .push((self.old_lines.len(), self.new_lines.len()));
        self.old_lines.push(line.clone());
        self.new_lines.push(line);
    }
}

/// Local output boundary: only the parsed operations and routing directive are needed.
#[derive(Debug, PartialEq)]
pub(crate) struct ParsedPatch {
    pub(crate) hunks: Vec<Hunk>,
    pub(crate) environment_id: Option<String>,
}

pub(crate) fn parse_patch(patch: &str) -> Result<ParsedPatch, ParseError> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    let patch_lines = check_patch_boundaries_lenient(&lines)?;

    let patch = patch_lines.join("\n");
    let mut parser = StreamingPatchParser::default();
    parser.push_delta(&patch)?;
    let hunks = parser.finish()?;
    let environment_id = parser.environment_id().map(str::to_owned);
    Ok(ParsedPatch {
        hunks,
        environment_id,
    })
}

/// Checks the start and end lines of the patch text for `apply_patch`,
/// returning an error if they do not match the expected markers.
fn check_patch_boundaries_strict<'a>(lines: &'a [&'a str]) -> Result<&'a [&'a str], ParseError> {
    let (first_line, last_line) = match lines {
        [] => (None, None),
        [first] => (Some(first), Some(first)),
        [first, .., last] => (Some(first), Some(last)),
    };
    check_start_and_end_lines_strict(first_line, last_line)?;
    Ok(lines)
}

/// Accepts the patch between its boundary markers, or inside a heredoc wrapper. Codex added the
/// wrapper for gpt-4.1 and accepts it for every model, since its parser cannot tell models apart. A
/// `local_shell` command runs `apply_patch` through `execvpe`, not a shell, so the model may pass
/// `<<'EOF'` ... `EOF` as literal text. The first line must start with `<<EOF` (possibly quoted) and the last must end with `EOF`.
/// There must be at least 4 lines: two wrapper lines around a patch of at least 2 lines.
///
/// Returns the lines of the patch itself; the wrapper lines are dropped. The body is still parsed
/// strictly.
fn check_patch_boundaries_lenient<'a>(
    original_lines: &'a [&'a str],
) -> Result<&'a [&'a str], ParseError> {
    let original_parse_error = match check_patch_boundaries_strict(original_lines) {
        Ok(lines) => return Ok(lines),
        Err(e) => e,
    };

    match original_lines {
        [first, .., last] => {
            if (first == &"<<EOF" || first == &"<<'EOF'" || first == &"<<\"EOF\"")
                && last.ends_with("EOF")
                && original_lines.len() >= 4
            {
                let inner_lines = &original_lines[1..original_lines.len() - 1];
                check_patch_boundaries_strict(inner_lines)
            } else {
                Err(original_parse_error)
            }
        }
        _ => Err(original_parse_error),
    }
}

fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError> {
    let first_line = first_line.map(|line| line.trim());
    let last_line = last_line.map(|line| line.trim());

    match (first_line, last_line) {
        (Some(first), Some(last)) if first == BEGIN_PATCH_MARKER && last == END_PATCH_MARKER => {
            Ok(())
        }
        (Some(first), _) if first != BEGIN_PATCH_MARKER => Err(InvalidPatchError(String::from(
            "The first line of the patch must be '*** Begin Patch'",
        ))),
        _ => Err(InvalidPatchError(String::from(
            "The last line of the patch must be '*** End Patch'",
        ))),
    }
}

#[test]
fn test_parse_patch() {
    assert_eq!(
        parse_patch("bad"),
        Err(InvalidPatchError(
            "The first line of the patch must be '*** Begin Patch'".to_string()
        ))
    );
    assert_eq!(
        parse_patch("*** Begin Patch\nbad"),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );

    assert_eq!(
        parse_patch(concat!(
            "*** Begin Patch",
            " ",
            "\n*** Add File: foo\n+hi\n",
            " ",
            "*** End Patch"
        ))
        .unwrap()
        .hunks,
        vec![AddFile {
            path: String::from("foo"),
            contents: "hi\n".to_string()
        }]
    );
    assert_eq!(
        parse_patch(
            "*** Begin Patch\n\
             *** Update File: test.py\n\
             *** End Patch"
        ),
        Err(InvalidHunkError {
            message: "Update file hunk for path 'test.py' is empty".to_string(),
            line_number: 2,
        })
    );
    assert_eq!(
        parse_patch(
            "*** Begin Patch\n\
             *** End Patch"
        )
        .unwrap()
        .hunks,
        Vec::new()
    );
    assert_eq!(
        parse_patch(
            "*** Begin Patch\n\
             *** Add File: path/add.py\n\
             +abc\n\
             +def\n\
             *** Delete File: path/delete.py\n\
             *** Update File: path/update.py\n\
             *** Move to: path/update2.py\n\
             @@ def f():\n\
             -    pass\n\
             +    return 123\n\
             *** End Patch"
        )
        .unwrap()
        .hunks,
        vec![
            AddFile {
                path: String::from("path/add.py"),
                contents: "abc\ndef\n".to_string()
            },
            DeleteFile {
                path: String::from("path/delete.py")
            },
            UpdateFile {
                path: String::from("path/update.py"),
                move_path: Some(String::from("path/update2.py")),
                chunks: vec![UpdateFileChunk {
                    change_context: Some("def f():".to_string()),
                    old_lines: vec!["    pass".to_string()],
                    new_lines: vec!["    return 123".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: false
                }]
            }
        ]
    );
    // Update hunk followed by another hunk (Add File).
    assert_eq!(
        parse_patch(
            "*** Begin Patch\n\
             *** Update File: file.py\n\
             @@\n\
             +line\n\
             *** Add File: other.py\n\
             +content\n\
             *** End Patch"
        )
        .unwrap()
        .hunks,
        vec![
            UpdateFile {
                path: String::from("file.py"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec![],
                    new_lines: vec!["line".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: false
                }],
            },
            AddFile {
                path: String::from("other.py"),
                contents: "content\n".to_string()
            }
        ]
    );

    // Update hunk without an explicit @@ header for the first chunk should parse.
    // Use a raw string to preserve the leading space diff marker on the context line.
    assert_eq!(
        parse_patch(
            r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#
        )
        .unwrap()
        .hunks,
        vec![UpdateFile {
            path: String::from("file2.py"),
            move_path: None,
            chunks: vec![UpdateFileChunk {
                change_context: None,
                old_lines: vec!["import foo".to_string()],
                new_lines: vec!["import foo".to_string(), "bar".to_string()],
                context_line_indices: vec![(0, 0)],
                is_end_of_file: false,
            }],
        }]
    );
}

#[test]
fn test_parse_patch_preserves_end_of_file_marker() {
    let patch =
        "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch";
    assert_eq!(
        parse_patch(patch),
        Ok(ParsedPatch {
            hunks: vec![UpdateFile {
                path: String::from("file.txt"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: Vec::new(),
                    new_lines: vec!["quux".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: true,
                }],
            }],

            environment_id: None,
        })
    );
}

#[test]
fn test_parse_patch_accepts_relative_and_absolute_hunk_paths() {
    let dir = tempfile::tempdir().unwrap();
    let absolute_delete = dir.path().join("absolute-delete.py");
    let absolute_update = dir.path().join("absolute-update.py");
    let patch_text = format!(
        r#"*** Begin Patch
*** Add File: relative-add.py
+content
*** Delete File: {}
*** Update File: {}
@@
-old
+new
*** End Patch"#,
        absolute_delete.display(),
        absolute_update.display()
    );

    assert_eq!(
        parse_patch(&patch_text).unwrap().hunks,
        vec![
            AddFile {
                path: String::from("relative-add.py"),
                contents: "content\n".to_string()
            },
            DeleteFile {
                path: absolute_delete.to_str().unwrap().to_owned()
            },
            UpdateFile {
                path: absolute_update.to_str().unwrap().to_owned(),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec!["old".to_string()],
                    new_lines: vec!["new".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: false
                }]
            },
        ]
    );
}

#[test]
fn test_parse_patch_lenient() {
    let patch_text = r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#;
    let expected_patch = vec![UpdateFile {
        path: String::from("file2.py"),
        move_path: None,
        chunks: vec![UpdateFileChunk {
            change_context: None,
            old_lines: vec!["import foo".to_string()],
            new_lines: vec!["import foo".to_string(), "bar".to_string()],
            context_line_indices: vec![(0, 0)],
            is_end_of_file: false,
        }],
    }];
    let expected_error =
        InvalidPatchError("The first line of the patch must be '*** Begin Patch'".to_string());

    for quote in ["", "'", "\""] {
        let heredoc = format!("<<{quote}EOF{quote}\n{patch_text}\nEOF\n");
        assert_eq!(
            parse_patch(&heredoc),
            Ok(ParsedPatch {
                hunks: expected_patch.clone(),
                environment_id: None,
            })
        );
    }

    let mismatched_quotes = format!("<<\"EOF'\n{patch_text}\nEOF\n");
    assert_eq!(parse_patch(&mismatched_quotes), Err(expected_error));

    let missing_closing_heredoc = "<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n";
    assert_eq!(
        parse_patch(missing_closing_heredoc),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );
}

#[test]
fn test_parse_patch_environment_id_preamble() {
    assert_eq!(
        parse_patch(
            "*** Begin Patch\n\
             *** Environment ID: remote\n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch"
        ),
        Ok(ParsedPatch {
            hunks: vec![AddFile {
                path: String::from("hello.txt"),
                contents: "hello\n".to_string(),
            }],

            environment_id: Some("remote".to_string()),
        })
    );

    assert_eq!(
        parse_patch(
            "*** Begin Patch\n\
             *** Environment ID:   \n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch"
        ),
        Err(InvalidPatchError(
            "apply_patch environment_id cannot be empty".to_string()
        ))
    );
}
