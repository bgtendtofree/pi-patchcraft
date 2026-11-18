use serde::Serialize;

const MIN_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_WINDOW_BYTES: usize = 16 * 1024;
const CONTEXT_LINES: usize = 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffWindow<'a> {
    line: usize,
    total_lines: usize,
    before: &'a str,
    after: &'a str,
    leading: Vec<&'a str>,
    trailing: Vec<&'a str>,
}

/// Avoid shipping large snapshots for an unambiguous single-line replacement.
/// Use the planned bytes, not the patch's input hunk, which may match fuzzily.
pub(crate) fn single_line_window<'a>(before: &'a [u8], after: &'a [u8]) -> Option<DiffWindow<'a>> {
    if before.len().min(after.len()) < MIN_SOURCE_BYTES {
        return None;
    }
    let before = std::str::from_utf8(before).ok()?;
    let after = std::str::from_utf8(after).ok()?;
    if !before.ends_with('\n')
        || !after.ends_with('\n')
        || before.contains('\r')
        || after.contains('\r')
    {
        return None;
    }

    let mut old = before.split_terminator('\n');
    let mut new = after.split_terminator('\n');
    let mut prefix_bytes = 0;
    let mut line = 1;
    let (removed, inserted) = loop {
        let a = old.next()?;
        let b = new.next()?;
        if a != b {
            break (a, b);
        }
        prefix_bytes += a.len() + 1;
        line += 1;
    };

    let mut trailing = Vec::new();
    let mut tail = 0;
    loop {
        match (old.next(), new.next()) {
            (None, None) => break,
            (Some(a), Some(b)) if a == b => {
                // Pi's full diff may align repeated lines differently if a
                // deletion or insertion can immediately match the next line.
                if tail == 0 && (a == removed || a == inserted) {
                    return None;
                }
                if tail < CONTEXT_LINES {
                    trailing.push(a);
                }
                tail += 1;
            }
            _ => return None,
        }
    }
    let mut leading: Vec<_> = before[..prefix_bytes]
        .rsplit_terminator('\n')
        .take(CONTEXT_LINES)
        .collect();
    leading.reverse();
    let bytes = removed.len()
        + inserted.len()
        + leading
            .iter()
            .chain(&trailing)
            .map(|line| line.len())
            .sum::<usize>();
    if bytes > MAX_WINDOW_BYTES {
        return None;
    }
    Some(DiffWindow {
        line,
        total_lines: line + tail,
        before: removed,
        after: inserted,
        leading,
        trailing,
    })
}
