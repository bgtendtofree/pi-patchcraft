use serde::Serialize;

use crate::{MAX_PATCH_BYTES, is_trim_char};

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE: &str = "*** Move to: ";
const EOF: &str = "*** End of File";

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Operation<'a> {
    Add {
        path: &'a str,
        content: String,
    },
    Delete {
        path: &'a str,
    },
    Update {
        path: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        move_to: Option<&'a str>,
        chunks: Vec<UpdateChunk<'a>>,
    },
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChunk<'a> {
    pub(crate) contexts: Vec<&'a str>,
    pub(crate) context_line_indices: Vec<(usize, usize)>,
    pub(crate) old_lines: Vec<&'a str>,
    pub(crate) new_lines: Vec<&'a str>,
    pub(crate) end_of_file: bool,
}

fn require_path<'a>(value: &'a str, header: &str) -> Result<&'a str, String> {
    let path = value.trim_end_matches(is_trim_char);
    if path.is_empty() {
        Err(format!("{header} requires a path"))
    } else if path.contains('\0') {
        Err(format!("{header} path contains NUL"))
    } else {
        Ok(path)
    }
}

/// Parse the complete Patchcraft envelope, without interpreting any paths.
/// Preserve Patchcraft's stricter envelope rather than Codex streaming leniencies.
pub fn parse_patch(patch: &str) -> Result<Vec<Operation<'_>>, String> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(format!(
            "Patch is too large: {} bytes exceeds 1 MiB limit",
            patch.len()
        ));
    }
    // CRLF is one separator, not two. Retain any real empty lines.
    let mut lines = Vec::new();
    let mut rest = patch.trim_matches(is_trim_char);
    while let Some(end) = rest.find(['\r', '\n']) {
        lines.push(&rest[..end]);
        rest = if rest.as_bytes()[end] == b'\r' && rest.as_bytes().get(end + 1) == Some(&b'\n') {
            &rest[end + 2..]
        } else {
            &rest[end + 1..]
        };
    }
    lines.push(rest);

    if lines[0].trim_matches(is_trim_char) != BEGIN {
        return Err("Invalid patch format: expected *** Begin Patch as the first line".into());
    }
    let last = lines.pop().unwrap().trim_matches(is_trim_char);
    if last != END {
        return Err(if last == "+*** End Patch" {
            "Invalid patch format: *** End Patch must not start with '+'".into()
        } else {
            "Invalid patch format: missing *** End Patch (the patch may have been truncated; split it into smaller patches)".into()
        });
    }

    let mut lines = lines[1..].iter().copied().peekable();
    let mut operations = Vec::new();
    while let Some(line) = lines.next() {
        if line.trim_matches(is_trim_char).is_empty() {
            continue;
        }
        if let Some(path) = line.strip_prefix(ADD) {
            let path = require_path(path, "Add File")?;
            let mut content = String::new();
            while lines.peek().is_some_and(|line| !line.starts_with("*** ")) {
                let added = lines
                    .next()
                    .unwrap()
                    .strip_prefix('+')
                    .ok_or("Add File lines must start with '+'")?;
                content.push_str(added);
                content.push('\n');
            }
            if content.is_empty() {
                return Err(format!("Add File '{path}' has no content lines"));
            }
            operations.push(Operation::Add { path, content });
        } else if let Some(path) = line.strip_prefix(DELETE) {
            operations.push(Operation::Delete {
                path: require_path(path, "Delete File")?,
            });
        } else if let Some(path) = line.strip_prefix(UPDATE) {
            let path = require_path(path, "Update File")?;
            let move_to = match lines.peek().and_then(|line| line.strip_prefix(MOVE)) {
                Some(path) => {
                    lines.next();
                    Some(require_path(path, "Move to")?)
                }
                None => None,
            };
            let mut chunks = Vec::new();
            while lines.peek().is_some_and(|line| !line.starts_with("*** ")) {
                if lines.next_if_eq(&"").is_some() {
                    continue;
                }
                chunks.push(parse_chunk(&mut lines)?);
            }
            if chunks.is_empty() && move_to.is_none() {
                return Err(format!("Update File '{path}' is empty"));
            }
            operations.push(Operation::Update {
                path,
                move_to,
                chunks,
            });
        } else {
            return Err(format!("Unknown patch header: '{line}'"));
        }
    }
    if operations.is_empty() {
        return Err("Patch is empty".into());
    }
    Ok(operations)
}

fn parse_chunk<'a>(
    lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<UpdateChunk<'a>, String> {
    let mut chunk = UpdateChunk::default();
    while let Some(marker) = lines.next_if(|line| line.starts_with("@@")) {
        if marker != "@@" {
            let context = marker
                .strip_prefix("@@ ")
                .ok_or_else(|| format!("Invalid update marker: '{marker}'"))?;
            chunk.contexts.push(context);
        }
    }
    while let Some(line) =
        lines.next_if(|line| *line == EOF || !(line.starts_with("@@") || line.starts_with("*** ")))
    {
        if line == EOF {
            chunk.end_of_file = true;
            break;
        }
        if let Some(text) = line.strip_prefix(' ') {
            chunk
                .context_line_indices
                .push((chunk.old_lines.len(), chunk.new_lines.len()));
            chunk.old_lines.push(text);
            chunk.new_lines.push(text);
        } else if let Some(text) = line.strip_prefix('-') {
            chunk.old_lines.push(text);
        } else if let Some(text) = line.strip_prefix('+') {
            chunk.new_lines.push(text);
        } else {
            return Err(format!("Invalid update line: '{line}'"));
        }
    }
    if chunk.old_lines.is_empty() && chunk.new_lines.is_empty() {
        return Err("Update hunk has no change lines".into());
    }
    Ok(chunk)
}
