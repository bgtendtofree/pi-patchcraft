use std::collections::{HashMap, HashSet};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

use crate::paths::{Result, lstat, parent, wire_path};

#[derive(Clone, Copy, Default)]
struct Sensitivity {
    case_aliases: Option<bool>,
    normalization_aliases: Option<bool>,
}

fn fold_case(value: &str) -> String {
    // Preserve dotless i and explicitly fold capital sharp S. Use full string
    // case conversion (including the same contextual sigma rules as JS).
    value
        .replace('\u{0131}', "\0")
        .replace('\u{1e9e}', "ss")
        .to_uppercase()
        .to_lowercase()
        .replace('\0', "\u{0131}")
}

fn fold(value: &str, sensitivity: Sensitivity) -> String {
    let preliminary = if sensitivity.normalization_aliases != Some(false) {
        value.nfc().collect()
    } else {
        value.to_owned()
    };
    let cased = if sensitivity.case_aliases != Some(false) {
        fold_case(&preliminary)
    } else {
        preliminary
    };
    if sensitivity.normalization_aliases != Some(false) {
        cased.nfc().collect()
    } else {
        cased
    }
}

fn case_variants(name: &str) -> [String; 2] {
    [
        name.to_lowercase(),
        name.chars()
            .map(|c| {
                if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                }
            })
            .collect(),
    ]
}

fn normalization_variants(name: &str) -> [String; 2] {
    [name.nfc().collect(), name.nfd().collect()]
}

#[cfg(unix)]
fn same_entry((_, a): (&Path, &Metadata), (_, b): (&Path, &Metadata)) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.ino() == b.ino() && a.dev() == b.dev()
}

#[cfg(not(unix))]
fn same_entry((a, _): (&Path, &Metadata), (b, _): (&Path, &Metadata)) -> bool {
    fs::canonicalize(a)
        .ok()
        .zip(fs::canonicalize(b).ok())
        .is_some_and(|(a, b)| a == b)
}

#[cfg(unix)]
fn same_device(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
}

#[cfg(not(unix))]
fn same_device(_: &Metadata, _: &Metadata) -> bool {
    // Don't borrow an ancestor's lookup rules when we cannot prove same device.
    false
}

fn probe(directory: &Path, variants: fn(&str) -> [String; 2]) -> Option<bool> {
    let probe_entry = |entry: &Path, original: &Metadata| -> Option<bool> {
        let name = entry.file_name()?.to_str()?;
        let mut compared = false;
        for variant in variants(name).into_iter().filter(|variant| variant != name) {
            let alternative = parent(entry).join(variant);
            let stats = lstat(&alternative).ok()?;
            compared = true;
            if let Some(stats) = stats
                && same_entry((entry, original), (&alternative, &stats))
            {
                return Some(true);
            }
        }
        compared.then_some(false)
    };
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.filter_map(std::result::Result::ok) {
            let entry = entry.path();
            if let Ok(Some(original)) = lstat(&entry)
                && let Some(decision) = probe_entry(&entry, &original)
            {
                return Some(decision);
            }
        }
    }
    let mut current = directory;
    let mut stats = lstat(current).ok()??;
    while current != parent(current) {
        let previous = parent(current);
        let previous_stats = lstat(previous).ok()??;
        if !same_device(&stats, &previous_stats) {
            break;
        }
        if let Some(decision) = probe_entry(current, &stats) {
            return Some(decision);
        }
        current = previous;
        stats = previous_stats;
    }
    None
}

fn existing_parent(path: &Path) -> Result<&Path> {
    let mut current = parent(path);
    while lstat(current)?.is_none() && current != parent(current) {
        current = parent(current);
    }
    Ok(current)
}

pub(crate) fn check(paths: impl IntoIterator<Item = PathBuf>) -> Result<()> {
    check_with(paths, |path| {
        Ok(Sensitivity {
            case_aliases: probe(path, case_variants),
            normalization_aliases: probe(path, normalization_variants),
        })
    })
}

fn check_with(
    paths: impl IntoIterator<Item = PathBuf>,
    mut sensitivity: impl FnMut(&Path) -> Result<Sensitivity>,
) -> Result<()> {
    let paths: HashSet<_> = paths.into_iter().collect();
    let mut folded: HashMap<_, Vec<_>> = HashMap::new();
    let mut cache = HashMap::new();
    let conflict = |path: &Path| {
        format!(
            "Patch contains conflicting operations for {}",
            path.display()
        )
    };
    for path in &paths {
        folded
            .entry(fold(wire_path(path)?, Sensitivity::default()))
            .or_default()
            .push(path);
    }
    for path in &paths {
        let full = wire_path(path)?;
        for prefix in path.ancestors().filter(|prefix| *prefix != path) {
            if paths.contains(prefix) {
                return Err(conflict(path));
            }
        }
        let folded_path = fold(full, Sensitivity::default());
        for prefix in Path::new(&folded_path).ancestors() {
            let Some(candidates) = folded.get(wire_path(prefix)?) else {
                continue;
            };
            for other in candidates {
                if *other == path {
                    continue;
                }
                let directory = existing_parent(other)?;
                let info = match cache.get(directory) {
                    Some(info) => *info,
                    None => {
                        let info = sensitivity(directory)?;
                        cache.insert(directory, info);
                        info
                    }
                };
                let name = fold(full, info);
                let other_name = fold(wire_path(other)?, info);
                if Path::new(&name).starts_with(&other_name) {
                    return Err(conflict(path));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_axes_independently_and_only_for_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let check_names = |names: [&str; 2], case_aliases, normalization_aliases| {
            check_with(names.map(|name| dir.path().join(name)), |_| {
                Ok(Sensitivity {
                    case_aliases,
                    normalization_aliases,
                })
            })
        };
        for (case, norm) in [(true, false), (false, true)] {
            assert_eq!(
                check_names(["a", "A"], Some(case), Some(norm)).is_err(),
                case
            );
            assert_eq!(
                check_names(["café", "cafe\u{301}"], Some(case), Some(norm)).is_err(),
                norm
            );
        }
        for pair in [
            ["σ", "ς"],
            ["S", "ſ"],
            ["µ", "Μ"],
            ["ß", "SS"],
            ["ẞ", "ß"],
            ["ẞ", "ss"],
        ] {
            assert!(
                check_names(pair, Some(true), Some(false)).is_err(),
                "{pair:?}"
            );
        }
        assert!(check_names(["a", "A"], None, Some(false)).is_err());
        assert!(check_names(["café", "cafe\u{301}"], Some(false), None).is_err());
        check_with(
            ["a", "b", "a.txt", "nested/c"].map(|name| dir.path().join(name)),
            |_| panic!("ordinary paths must not probe their parent"),
        )
        .unwrap();
    }
}
