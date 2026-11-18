// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenAI Codex; see rust/patchcraft-core/README.md.

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

/// Search in Codex's order: exact, trailing-space, surrounding-space, then
/// punctuation-normalized. Only the comparison budget and fuzz score are local.
pub(super) fn seek_sequence(
    lines: &[&str],
    pattern: &[String],
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

    let mut search = |matches: fn(&str, &str) -> bool, fuzz| {
        'windows: for index in search_start..=last {
            for (line, pat) in lines[index..].iter().zip(pattern) {
                budget.spend()?;
                if !matches(line, pat) {
                    continue 'windows;
                }
            }
            return Ok(Some(Match { index, fuzz }));
        }
        Ok(None)
    };

    if let Some(found) = search(|a, b| a == b, 0)? {
        return Ok(Some(found));
    }
    if let Some(found) = search(|a, b| a.trim_end() == b.trim_end(), 1)? {
        return Ok(Some(found));
    }
    if let Some(found) = search(|a, b| a.trim() == b.trim(), 100)? {
        return Ok(Some(found));
    }
    search(|a, b| normalise(a) == normalise(b), 10_000)
}

// Codex's mapping of typographic dashes, quotes, and spaces to ASCII.
fn normalise(s: &str) -> String {
    s.trim()
        .chars()
        .map(|c| match c {
            // Various dash / hyphen code-points → ASCII '-'
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            // Fancy single quotes → '\''
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // Fancy double quotes → '"'
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // Non-breaking space and other odd spaces → normal space
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::{Budget, seek_sequence as search};

    fn seek_sequence(lines: &[&str], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
        search(lines, pattern, start, eof, &mut Budget::default())
            .unwrap()
            .map(|found| found.index)
    }
    use std::string::ToString;

    fn to_vec(strings: &[&str]) -> Vec<String> {
        strings.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn test_exact_match_finds_sequence() {
        let lines = ["foo", "bar", "baz"];
        let pattern = to_vec(&["bar", "baz"]);
        assert_eq!(
            seek_sequence(&lines, &pattern, /*start*/ 0, /*eof*/ false,),
            Some(1)
        );
    }

    #[test]
    fn test_rstrip_match_ignores_trailing_whitespace() {
        let lines = ["foo   ", "bar\t\t"];
        // Pattern omits trailing whitespace.
        let pattern = to_vec(&["foo", "bar"]);
        assert_eq!(
            seek_sequence(&lines, &pattern, /*start*/ 0, /*eof*/ false,),
            Some(0)
        );
    }

    #[test]
    fn test_trim_match_ignores_leading_and_trailing_whitespace() {
        let lines = ["    foo   ", "   bar\t"];
        // Pattern omits any additional whitespace.
        let pattern = to_vec(&["foo", "bar"]);
        assert_eq!(
            seek_sequence(&lines, &pattern, /*start*/ 0, /*eof*/ false,),
            Some(0)
        );
    }

    #[test]
    fn test_pattern_longer_than_input_returns_none() {
        let lines = ["just one line"];
        let pattern = to_vec(&["too", "many", "lines"]);
        // Should not panic – must return None when pattern cannot possibly fit.
        assert_eq!(
            seek_sequence(&lines, &pattern, /*start*/ 0, /*eof*/ false,),
            None
        );
    }
}
