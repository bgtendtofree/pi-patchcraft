use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};

pub(crate) type Result<T> = std::result::Result<T, String>;

pub(crate) fn io_error(path: &Path, error: io::Error) -> String {
    format!("{}: {error}", path.display())
}

pub(crate) fn lstat(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(path, error)),
    }
}

pub(crate) fn parent(path: &Path) -> &Path {
    path.parent().unwrap_or(path)
}

pub(crate) fn canonical(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).map_err(|error| io_error(path, error))
}

pub(crate) fn wire_path(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| format!("Patch path is not valid UTF-8: {}", path.display()))
}

pub(crate) fn lexical_path(cwd: &Path, input: &str) -> Result<PathBuf> {
    let value = input.strip_prefix('@').unwrap_or(input);
    if value.is_empty() || value.contains('\0') {
        return Err("Patch path is empty or contains NUL".into());
    }
    let home = if value == "~" {
        Some("")
    } else {
        value.strip_prefix("~/")
    };
    let path = if let Some(rest) = home {
        // Joining the relative suffix must not treat repeated separators as a new root.
        let home = std::env::home_dir().ok_or("Could not resolve home directory")?;
        home.join(rest.trim_start_matches(std::path::is_separator))
    } else if value.starts_with("file://") {
        let url = url::Url::parse(value).map_err(|error| format!("Invalid file URL: {error}"))?;
        let lower = url.path().to_ascii_lowercase();
        if lower.contains("%2f") {
            return Err("File URL path must not contain encoded separators".into());
        }
        url.to_file_path()
            .map_err(|()| "Invalid file URL path or host")?
    } else {
        PathBuf::from(value)
    };
    // A `file://` path can introduce NUL after percent-decoding.
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err("Patch path contains NUL".into());
    }
    let joined = cwd.join(path);
    let absolute = std::path::absolute(&joined).map_err(|error| io_error(&joined, error))?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(component),
        }
    }
    Ok(normalized)
}

/// Resolve the deepest existing parent, preserving the final spelling (and any missing suffix).
pub(crate) fn resolve_parent(lexical: &Path) -> Result<PathBuf> {
    let mut current = parent(lexical);
    loop {
        match dunce::canonicalize(current) {
            Ok(real) => {
                let suffix = lexical.strip_prefix(current).expect("ancestor");
                return Ok(if suffix.as_os_str().is_empty() {
                    real
                } else {
                    real.join(suffix)
                });
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && current != parent(current) => {
                current = parent(current);
            }
            Err(error) => return Err(io_error(current, error)),
        }
    }
}

pub(crate) struct Resolved {
    pub path: PathBuf,
    pub metadata: Option<Metadata>,
    pub followed: bool,
}

fn link_parts(path: &Path) -> (Option<PathBuf>, VecDeque<OsString>) {
    // Components skips intermediate "." and a trailing separator, both significant for
    // rejecting links that require a directory. Work on raw bytes to preserve native names.
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let bytes = path.as_os_str().as_bytes();
    let root = path.has_root().then(|| PathBuf::from("/"));
    let mut parts: VecDeque<OsString> = bytes
        .split(|&b| b == b'/')
        .filter(|part| !part.is_empty())
        .map(|part| OsString::from_vec(part.to_vec()))
        .collect();
    if bytes.ends_with(b"/") && !parts.is_empty() {
        parts.push_back(".".into());
    }
    (root, parts)
}

/// Resolve active symlink chains without lexically collapsing ".." inside a symlink target.
pub(crate) fn resolve_links(absolute: &Path) -> Result<Resolved> {
    let (root, mut pending) = link_parts(absolute);
    let mut current = root.ok_or("Expected an absolute patch path")?;
    let mut links = 0;
    while let Some(part) = pending.pop_front() {
        if part == "." {
            continue;
        }
        if part == ".." {
            current.pop();
            continue;
        }
        let candidate = current.join(part);
        let Some(metadata) = lstat(&candidate)? else {
            if pending.iter().any(|part| part == "..") {
                return Err(format!(
                    "Cannot resolve a patch path with \"..\" after a missing component: {}",
                    candidate.display()
                ));
            }
            if pending.back().is_some_and(|part| part == ".") {
                return Err(format!(
                    "Cannot write a file for a patch path that requires a directory: {}",
                    candidate.display()
                ));
            }
            current = candidate;
            current.extend(pending.iter().filter(|p| p.as_os_str() != OsStr::new(".")));
            return Ok(Resolved {
                path: current,
                metadata: None,
                followed: links != 0,
            });
        };
        if !metadata.is_symlink() {
            if !pending.is_empty() && !metadata.is_dir() {
                return Err(format!(
                    "Cannot traverse non-directory path component (ENOTDIR): {}",
                    candidate.display()
                ));
            }
            current = candidate;
            continue;
        }
        links += 1;
        if links > 40 {
            return Err(format!("Too many symbolic links: {}", absolute.display()));
        }
        let target = fs::read_link(&candidate).map_err(|error| io_error(&candidate, error))?;
        let (root, mut parts) = link_parts(&target);
        if let Some(root) = root {
            current = root;
        }
        parts.append(&mut pending);
        pending = parts;
    }
    let metadata = fs::symlink_metadata(&current).map_err(|error| io_error(&current, error))?;
    Ok(Resolved {
        path: current,
        metadata: Some(metadata),
        followed: links != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_at_home_and_file_url_paths() {
        let dir = tempfile::tempdir().unwrap();
        let here = canonical(dir.path()).unwrap();
        for (arg, expected) in [
            ("nested/new.txt", here.join("nested/new.txt")),
            ("@value.txt", here.join("value.txt")),
            ("./missing/../other.txt", here.join("other.txt")),
            (
                "~/value.txt",
                canonical(&std::env::home_dir().unwrap())
                    .unwrap()
                    .join("value.txt"),
            ),
            ("~", canonical(&std::env::home_dir().unwrap()).unwrap()),
        ] {
            let actual = resolve_parent(&lexical_path(&here, arg).unwrap()).unwrap();
            assert_eq!(actual, expected, "{arg}");
        }
        let expected = here.join("url with space.txt");
        let url = url::Url::from_file_path(&expected).unwrap();
        assert_eq!(lexical_path(&here, url.as_str()).unwrap(), expected);
        assert!(lexical_path(&here, "file:///dir%2Fname").is_err());
        assert!(lexical_path(&here, "file:///name%00").is_err());
    }
}
