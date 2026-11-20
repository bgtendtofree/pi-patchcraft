use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
pub(crate) fn check(paths: impl IntoIterator<Item = (PathBuf, &'static str)>) -> Result<()> {
    let mut operations: HashMap<PathBuf, &'static str> = HashMap::new();
    let mut folded: HashMap<String, PathBuf> = HashMap::new();
    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    for (path, operation) in paths {
        if operations.insert(path.clone(), operation).is_some() {
            // Both spellings of one change: a move's source and target, or an add's path.
            continue;
        }
        let key = fold(wire_path(&path)?);
        if let Some(previous) = folded.get(&key) {
            return Err(conflict(previous, &operations));
        }
        folded.insert(key.clone(), path.clone());
        entries.push((path, key));
    }
    for (path, key) in &entries {
        for prefix in Path::new(key).ancestors().skip(1) {
            if prefix
                .to_str()
                .is_some_and(|prefix| folded.contains_key(prefix))
            {
                return Err(conflict(path, &operations));
            }
        }
    }
    Ok(())
}

fn conflict(path: &Path, operations: &HashMap<PathBuf, &'static str>) -> String {
    let operation = operations.get(path).copied().unwrap_or("operation");
    format!(
        "Patch contains conflicting operations for {} ({operation})",
        path.display()
    )
}
