use std::collections::HashMap;
use std::path::Path;

use unicode_normalization::UnicodeNormalization;

use crate::paths::{Result, wire_path};

/// Comparison key for filesystems that equate case or Unicode normalization. A patch that
/// addresses two spellings is rejected rather than betting the filesystem keeps them apart.
fn fold(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

/// Reject distinct spellings of one file and file/directory conflicts. Comparisons ignore case and
/// normalization on every host, so a patch behaves the same on case-sensitive and
/// case-insensitive filesystems instead of depending on a probe of the current one.
pub(crate) fn check<'a>(
    paths: impl IntoIterator<Item = (&'a Path, &'static str, usize)>,
) -> Result<()> {
    let mut folded = HashMap::<String, (&Path, &str, usize)>::new();
    let mut entries = Vec::new();
    for (path, operation, owner) in paths {
        let key = fold(wire_path(path)?);
        let (previous, previous_operation, previous_owner) = *folded
            .entry(key.clone())
            .or_insert((path, operation, owner));
        // A move's own source and destination may differ only in case/normalization.
        if owner != previous_owner {
            return Err(conflict(previous, previous_operation));
        }
        entries.push((key, path, operation));
    }
    for (key, path, operation) in entries {
        for prefix in Path::new(&key).ancestors().skip(1) {
            if prefix
                .to_str()
                .is_some_and(|prefix| folded.contains_key(prefix))
            {
                return Err(conflict(path, operation));
            }
        }
    }
    Ok(())
}

fn conflict(path: &Path, operation: &str) -> String {
    format!(
        "Patch contains conflicting operations for {} ({operation})",
        path.display()
    )
}
