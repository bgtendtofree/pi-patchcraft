// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenAI Codex; see rust/patchcraft-core/README.md.

use std::fmt;

use serde::Serialize;

use crate::seek_sequence::{Budget, normalize, seek_sequence};
use crate::text_file::{Replacement, SourceFile};
use crate::{MAX_SOURCE_BYTES, UpdateChunk};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Update {
    pub content: String,
    pub fuzz: u64,
}

#[derive(Debug)]
pub enum MatchError {
    SourceTooLarge(usize),
    BudgetExceeded(String),
    MissingContext(String),
    MissingLines(String),
}

impl fmt::Display for MatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceTooLarge(size) => write!(
                f,
                "Patch source is too large: {size} bytes exceeds 64 MiB limit"
            ),
            Self::BudgetExceeded(path) => write!(
                f,
                "Patch matching exceeded its comparison budget for {path}; re-read the file and use a smaller update hunk."
            ),
            Self::MissingContext(message) | Self::MissingLines(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for MatchError {}

/// Apply an update to caller-supplied UTF-8 content. The path is only a diagnostic label.
pub fn apply_chunks(
    content: &str,
    path: &str,
    chunks: &[UpdateChunk<'_>],
) -> Result<Update, MatchError> {
    if content.len() > MAX_SOURCE_BYTES {
        return Err(MatchError::SourceTooLarge(content.len()));
    }
    let (bom, content) = match content.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", content),
    };
    let mut source = SourceFile::parse(content);
    let (replacements, fuzz) = compute_replacements(&source.line_texts(), path, chunks)?;
    source.apply_replacements(&replacements);
    Ok(Update {
        content: format!("{bom}{}", source.into_contents()),
        fuzz,
    })
}

fn compute_replacements(
    original_lines: &[String],
    path: &str,
    chunks: &[UpdateChunk<'_>],
) -> Result<(Vec<Replacement>, u64), MatchError> {
    let mut replacements = Vec::new();
    let mut line_index = 0;
    let mut fuzz = 0;
    let mut budget = Budget::default();
    let mut search = |pattern, start, eof| {
        seek_sequence(original_lines, pattern, start, eof, &mut budget)
            .map_err(|_| MatchError::BudgetExceeded(path.to_owned()))
    };

    for chunk in chunks {
        for context in &chunk.contexts {
            let Some(found) = search(std::slice::from_ref(context), line_index, false)? else {
                return Err(MatchError::MissingContext(format!(
                    "Failed to find context '{context}' in {path}.\n{}",
                    describe_closest_match(original_lines, &[*context], line_index)
                )));
            };
            line_index = found.index + 1;
            fuzz += found.fuzz;
        }

        if chunk.old_lines.is_empty() {
            replacements.push((original_lines.len(), 0, owned_lines(&chunk.new_lines)));
            continue;
        }

        let mut pattern = chunk.old_lines.as_slice();
        let mut found = search(pattern, line_index, chunk.end_of_file)?;
        let mut new_slice = chunk.new_lines.as_slice();

        // The line list has no trailing sentinel for the file's final newline.
        if found.is_none() && pattern.last() == Some(&"") {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last() == Some(&"") {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
            found = search(pattern, line_index, chunk.end_of_file)?;
        }

        let Some(found) = found else {
            return Err(MatchError::MissingLines(format!(
                "Failed to find expected lines in {path}:\n{}\n{}",
                chunk.old_lines.join("\n"),
                describe_closest_match(original_lines, &chunk.old_lines, line_index)
            )));
        };
        let start_idx = found.index;
        fuzz += found.fuzz;

        // Context lines occur on both sides. Leave the original lines and their terminators alone.
        let mut old_start = 0;
        let mut new_start = 0;
        for &(old_context, new_context) in &chunk.context_line_indices {
            if old_context >= pattern.len() || new_context >= new_slice.len() {
                break;
            }
            if old_start != old_context || new_start != new_context {
                replacements.push((
                    start_idx + old_start,
                    old_context - old_start,
                    owned_lines(&new_slice[new_start..new_context]),
                ));
            }
            old_start = old_context + 1;
            new_start = new_context + 1;
        }
        if old_start != pattern.len() || new_start != new_slice.len() {
            replacements.push((
                start_idx + old_start,
                pattern.len() - old_start,
                owned_lines(&new_slice[new_start..]),
            ));
        }
        line_index = start_idx + pattern.len();
    }
    // Stable order matters when multiple insertion-only chunks append at EOF.
    replacements.sort_by_key(|(index, _, _)| *index);
    Ok((replacements, fuzz))
}

fn owned_lines(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|line| (*line).to_owned()).collect()
}

fn describe_closest_match(lines: &[String], pattern: &[&str], start: usize) -> String {
    use fmt::Write;
    if pattern.is_empty() || lines.is_empty() {
        return String::new();
    }
    let first = start.min(lines.len() - 1);
    let compared: Vec<_> = pattern
        .iter()
        .take(20)
        .map(|line| normalize(line))
        .collect();
    let mut best_index = first;
    let mut best_matched = 0;
    let mut budget = 200_000;
    for index in first..lines.len() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        let mut matched = 0;
        for (line, expected) in lines[index..].iter().zip(&compared) {
            if budget == 0 || normalize(line) != *expected {
                break;
            }
            matched += 1;
            budget -= 1;
        }
        if matched > best_matched {
            best_matched = matched;
            best_index = index;
        }
    }
    if best_matched == 0 {
        return "No line in the remaining file matched; re-read the file and retry with current content.".into();
    }
    let mut description = format!(
        "Closest match at line {} ({best_matched}/{} lines matched):",
        best_index + 1,
        compared.len()
    );
    for (offset, line) in lines[best_index..]
        .iter()
        .take(pattern.len().min(5))
        .enumerate()
    {
        let excerpt: String = line.chars().take(200).collect();
        let _ = write!(description, "\n{}: {excerpt}", best_index + offset + 1);
    }
    description
}
