// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenAI Codex; see rust/patchcraft-core/README.md.

use std::borrow::Cow;

use crate::is_trim_char;

const MAX_MATCH_COMPARISONS: usize = 5_000_000;

pub(super) struct Budget(usize);

impl Default for Budget {
    fn default() -> Self {
        Self(MAX_MATCH_COMPARISONS)
    }
}

#[derive(Debug)]
pub(super) struct BudgetExceeded;

impl Budget {
    fn spend(&mut self) -> Result<(), BudgetExceeded> {
        self.0 = self.0.checked_sub(1).ok_or(BudgetExceeded)?;
        Ok(())
    }
}

pub(super) struct Match {
    pub index: usize,
    pub fuzz: u64,
}

// Keep Codex's decreasing strictness, with Patchcraft's fuzz weights and budget.
pub(super) fn seek_sequence(
    lines: &[String],
    pattern: &[&str],
    start: usize,
    eof: bool,
    budget: &mut Budget,
) -> Result<Option<Match>, BudgetExceeded> {
    if pattern.is_empty() {
        return Ok(Some(Match {
            index: start,
            fuzz: 0,
        }));
    }
    let Some(last) = lines.len().checked_sub(pattern.len()) else {
        return Ok(None);
    };
    let search_start = if eof { last.max(start) } else { start };

    for fuzz in [0, 1, 100, 10_000] {
        let mut expected = Vec::with_capacity(pattern.len());
        for pat in pattern {
            budget.spend()?;
            expected.push(prepare(pat, fuzz));
        }
        for index in search_start..=last {
            let mut matched = true;
            for (line, pat) in lines[index..].iter().zip(&expected) {
                budget.spend()?;
                if prepare(line, fuzz) != *pat {
                    matched = false;
                    break;
                }
            }
            if matched {
                return Ok(Some(Match { index, fuzz }));
            }
        }
    }
    Ok(None)
}

fn prepare(line: &str, fuzz: u64) -> Cow<'_, str> {
    match fuzz {
        0 => Cow::Borrowed(line),
        1 => Cow::Borrowed(line.trim_end_matches(is_trim_char)),
        100 => Cow::Borrowed(line.trim_matches(is_trim_char)),
        _ => normalize(line),
    }
}

pub(super) fn normalize(line: &str) -> Cow<'_, str> {
    let line = line.trim_matches(is_trim_char);
    fn ascii_equivalent(c: char) -> char {
        match c {
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{2018}'..='\u{201b}' => '\'',
            '\u{201c}'..='\u{201f}' => '"',
            '\u{00a0}' | '\u{2002}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' => ' ',
            other => other,
        }
    }
    if line.chars().any(|c| ascii_equivalent(c) != c) {
        Cow::Owned(line.chars().map(ascii_equivalent).collect())
    } else {
        Cow::Borrowed(line)
    }
}
