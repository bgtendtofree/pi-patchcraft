use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata, Permissions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::file_update::apply_chunks;
use crate::parser::{Hunk, parse_patch};
use crate::paths::{
    Result, canonical, io_error, lexical_path, lstat, parent, resolve_links, resolve_parent,
};
use crate::{MAX_PATCH_BYTES, MAX_SOURCE_BYTES, aliases};

#[derive(Default)]
pub struct Cancelled(AtomicBool);

impl Cancelled {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn check(&self) -> Result<()> {
        if self.0.load(Ordering::SeqCst) {
            Err("Patch application aborted".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Add,
    Delete,
    Update,
    Move,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Delete => "delete",
            Self::Update => "update",
            Self::Move => "move",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    operation: Kind,
    path: String,
    target_path: String,
    fuzz: u64,
}

pub struct Change {
    summary: Summary,
    lexical: PathBuf,
    source: PathBuf,
    identity: PathBuf,
    link: Option<PathBuf>,
    lexical_target: PathBuf,
    target: PathBuf,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    permissions: Option<Permissions>,
}

impl Change {
    pub fn summary(&self) -> &Summary {
        &self.summary
    }

    pub fn texts(&self) -> (&[u8], &[u8]) {
        (
            self.before.as_deref().unwrap_or_default(),
            self.after.as_deref().unwrap_or_default(),
        )
    }

    fn is_move(&self) -> bool {
        matches!(self.summary.operation, Kind::Move)
    }

    fn touches(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.identity.as_path())
            .chain(self.is_move().then_some(self.target.as_path()))
    }
}

/// A read-only snapshot until apply is called, owned by one CLI session.
pub struct Plan {
    changes: Vec<Change>,
}

fn read_file(path: &Path, metadata: &Metadata) -> Result<Vec<u8>> {
    let limit_error = |size| {
        format!(
            "Patch source is too large: {} ({size} bytes exceeds 64 MiB limit)",
            path.display()
        )
    };
    if !metadata.is_file() {
        return Err(format!(
            "Patch target is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_SOURCE_BYTES as u64 {
        return Err(limit_error(metadata.len()));
    }
    // Don't follow a new final symlink or block on a FIFO substituted between stat and open.
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| io_error(path, error))?;
    if !file
        .metadata()
        .map_err(|error| io_error(path, error))?
        .is_file()
    {
        return Err(format!(
            "Patch target is not a regular file: {}",
            path.display()
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(limit_error(bytes.len() as u64));
    }
    Ok(bytes)
}

impl Plan {
    pub fn build_with_cancel(cwd: &Path, patch: &str, cancelled: &Cancelled) -> Result<Self> {
        cancelled.check()?;
        if patch.len() > MAX_PATCH_BYTES {
            return Err(format!(
                "Patch is too large: {} bytes exceeds 1 MiB limit",
                patch.len()
            ));
        }
        let parsed = parse_patch(patch).map_err(|error| error.to_string())?;
        // A local transaction must never silently apply a patch addressed to a Codex environment.
        if parsed.environment_id.is_some() {
            return Err("Patchcraft does not support *** Environment ID: for local patches".into());
        }
        if parsed.hunks.is_empty() {
            return Err("No files were modified.".into());
        }
        let mut changes = Vec::new();
        let mut identities = HashMap::<PathBuf, Kind>::new();
        for op in parsed.hunks {
            cancelled.check()?;
            let change = build_change(cwd, op)?;
            for candidate in change.touches() {
                if let Some(previous) =
                    identities.insert(candidate.to_owned(), change.summary.operation)
                {
                    let is_update = |kind| matches!(kind, Kind::Update | Kind::Move);
                    let hint = if is_update(previous) && is_update(change.summary.operation) {
                        "; put multiple hunks under one *** Update File: header instead of repeating it"
                    } else {
                        ""
                    };
                    return Err(format!(
                        "Patch contains conflicting operations for {}: {} then {}{hint}",
                        candidate.display(),
                        previous.label(),
                        change.summary.operation.label()
                    ));
                }
            }
            changes.push(change);
        }
        aliases::check(changes.iter().flat_map(|change| {
            let operation = change.summary.operation.label();
            [
                (change.source.clone(), operation),
                (change.target.clone(), operation),
            ]
        }))?;
        Ok(Self { changes })
    }

    pub fn changes(&self) -> &[Change] {
        &self.changes
    }

    /// Include both lexical and physical spellings for all absent destinations. Pi
    /// resolves current queue keys again, using its own namespace and sort order.
    pub fn lock_paths(&self) -> HashSet<&Path> {
        let mut paths = HashSet::new();
        for change in &self.changes {
            if change.before.is_some() {
                paths.insert(change.identity.as_path());
            } else {
                paths.insert(change.lexical.as_path());
                paths.insert(change.source.as_path());
            }
            if change.is_move() {
                paths.insert(change.lexical_target.as_path());
                paths.insert(change.target.as_path());
            }
        }
        paths
    }

    fn validate(&self, cancelled: &Cancelled) -> Result<()> {
        for change in &self.changes {
            cancelled.check()?;
            let path = &change.summary.path;
            let current_parent = resolve_parent(&change.lexical)?;
            let current = resolve_links(&current_parent)?;
            if change.link.as_ref().is_some_and(|link| {
                !current.followed || *link != current_parent || current.path != change.source
            }) {
                return Err(format!("Patch source link changed before apply: {path}"));
            }
            if let Some(before) = &change.before {
                let drift = || format!("Patch source changed before apply: {path}");
                if current.path != change.source || current.followed != change.link.is_some() {
                    return Err(drift());
                }
                let metadata = current
                    .metadata
                    .filter(Metadata::is_file)
                    .ok_or_else(drift)?;
                if canonical(&current.path)? != change.identity
                    || read_file(&current.path, &metadata)? != *before
                {
                    return Err(drift());
                }
                if change
                    .permissions
                    .as_ref()
                    .is_some_and(|old| !same_mode(old, &metadata.permissions()))
                {
                    return Err(format!(
                        "Patch source permissions changed before apply: {path}"
                    ));
                }
            } else if current.metadata.is_some()
                || current.path != change.source
                || current.followed != change.link.is_some()
            {
                return Err(format!("Patch target changed before apply: {path}"));
            }
            if change.is_move()
                && (resolve_parent(&change.lexical_target)? != change.target
                    || lstat(&change.target)?.is_some())
            {
                return Err(format!(
                    "Patch target changed before apply: {}",
                    change.summary.target_path
                ));
            }
        }
        Ok(())
    }

    pub fn apply(self, cancelled: &Cancelled) -> Result<()> {
        self.apply_with(cancelled, &mut |_, _| Ok(()))
    }

    fn apply_with(self, cancelled: &Cancelled, hook: &mut Hook<'_>) -> Result<()> {
        self.validate(cancelled)?;
        let mut mutations = Vec::with_capacity(self.changes.len());
        let mut directories = Vec::new();
        for change in &self.changes {
            let mut state = Mutation::default();
            let result = cancelled
                .check()
                .and_then(|()| apply_change(change, &mut state, &mut directories, hook))
                .and_then(|()| cancelled.check());
            mutations.push((change, state));
            if let Err(error) = result {
                let mut failures: Vec<_> = mutations
                    .into_iter()
                    .rev()
                    .filter_map(|(change, state)| {
                        rollback_change(change, state, &mut directories, hook)
                            .err()
                            .map(|error| format!("{}: {error}", change.summary.target_path))
                    })
                    .collect();
                for directory in directories.iter().rev() {
                    if let Err(error) = fs::remove_dir(directory)
                        && error.kind() != io::ErrorKind::NotFound
                    {
                        failures.push(io_error(directory, error));
                    }
                }
                let suffix = if failures.is_empty() {
                    "All applied changes were rolled back.".into()
                } else {
                    format!("Rollback failed:\n{}", failures.join("\n"))
                };
                return Err(format!("Patch application failed: {error}\n{suffix}"));
            }
        }
        Ok(())
    }
}

fn build_change(cwd: &Path, op: Hunk) -> Result<Change> {
    let (kind, path, move_to) = match &op {
        Hunk::AddFile { path, .. } => (Kind::Add, path, None),
        Hunk::DeleteFile { path } => (Kind::Delete, path, None),
        Hunk::UpdateFile {
            path, move_path, ..
        } => (
            if move_path.is_some() {
                Kind::Move
            } else {
                Kind::Update
            },
            path,
            move_path.as_deref(),
        ),
    };
    // The parser constructs these paths from UTF-8; resolve them with Pi's path rules.
    let path = crate::paths::wire_path(path)?;
    let move_to = move_to.map(crate::paths::wire_path).transpose()?;
    let lexical = lexical_path(cwd, path)?;
    let absolute = resolve_parent(&lexical)?;
    let resolved = resolve_links(&absolute)?;
    let source = resolved.path;
    let link = resolved.followed.then(|| absolute.clone());
    if link.is_some() && resolved.metadata.is_some() {
        match kind {
            Kind::Delete => {
                return Err(format!(
                    "Delete File does not follow symbolic links: {path}; remove the link directly"
                ));
            }
            Kind::Move => {
                return Err(format!(
                    "Move does not follow symbolic links: {path}; move the target or the link directly"
                ));
            }
            _ => {}
        }
    }
    if kind != Kind::Add && resolved.metadata.is_none() {
        return Err(format!("Patch target does not exist: {path}"));
    }
    let (identity, before, permissions) = if let Some(metadata) = resolved.metadata {
        let content = read_file(&source, &metadata)?;
        (
            canonical(&source)?,
            Some(content),
            Some(metadata.permissions()),
        )
    } else {
        (source.clone(), None, None)
    };
    let (after, fuzz) = match &op {
        Hunk::AddFile { contents, .. } => (Some(contents.as_bytes().to_vec()), 0),
        Hunk::DeleteFile { .. } => (None, 0),
        Hunk::UpdateFile { chunks, .. } => {
            let original = std::str::from_utf8(before.as_deref().expect("existing source"))
                .map_err(|_| format!("Patch source is not valid UTF-8: {path}"))?;
            let updated = apply_chunks(original, path, chunks)?;
            (Some(updated.content.into_bytes()), updated.fuzz)
        }
    };
    let target_path = move_to.unwrap_or(path);
    let mut target = source.clone();
    let mut lexical_target = lexical.clone();
    if let Some(move_to) = move_to {
        let requested = lexical_path(cwd, move_to)?;
        let resolved = resolve_parent(&requested)?;
        if lstat(&resolved)?.is_some() {
            return Err(format!("Move target already exists: {target_path}"));
        }
        target = resolved;
        lexical_target = requested;
    }
    if matches!(kind, Kind::Update | Kind::Move) && target == source && after == before {
        return Err(format!("Update produced no changes: {path}"));
    }
    Ok(Change {
        summary: Summary {
            operation: kind,
            path: path.to_owned(),
            target_path: target_path.to_owned(),
            fuzz,
        },
        lexical,
        source,
        identity,
        link,
        lexical_target,
        target,
        before,
        after,
        permissions,
    })
}

#[cfg(unix)]
fn same_mode(a: &Permissions, b: &Permissions) -> bool {
    use std::os::unix::fs::PermissionsExt;
    a.mode() & 0o7777 == b.mode() & 0o7777
}

#[cfg(not(unix))]
fn same_mode(a: &Permissions, b: &Permissions) -> bool {
    a.readonly() == b.readonly()
}

#[cfg(unix)]
fn assert_replaceable(path: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: the CString is NUL-terminated and lives through the call.
    if unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn assert_replaceable(path: &Path) -> io::Result<()> {
    fs::OpenOptions::new().write(true).open(path).map(drop)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    WriteTemp,
    Rename,
    CleanupTemp,
    Applied,
    Remove,
}
type Hook<'a> = dyn FnMut(Step, &Path) -> io::Result<()> + 'a;

fn create_parents(directory: &Path, created: &mut Vec<PathBuf>) -> Result<()> {
    let mut missing = Vec::new();
    for path in directory.ancestors() {
        match fs::metadata(path) {
            Ok(_) => break, // create_dir or tempfile will diagnose a non-directory.
            Err(error) if error.kind() == io::ErrorKind::NotFound => missing.push(path),
            Err(error) => return Err(io_error(path, error)),
        }
    }
    for path in missing.into_iter().rev() {
        match fs::create_dir(path) {
            Ok(()) => created.push(path.to_owned()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
            Err(error) => return Err(io_error(path, error)),
        }
    }
    Ok(())
}

fn atomic_write(
    path: &Path,
    bytes: &[u8],
    permissions: Option<&Permissions>,
    replace: bool,
    directories: &mut Vec<PathBuf>,
    hook: &mut Hook<'_>,
) -> Result<()> {
    if replace {
        assert_replaceable(path).map_err(|error| io_error(path, error))?;
    }
    create_parents(parent(path), directories)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".patchcraft-").suffix(".tmp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(Permissions::from_mode(
            permissions.map_or(0o666, PermissionsExt::mode),
        ));
    }
    let mut temp = builder
        .tempfile_in(parent(path))
        .map_err(|error| io_error(path, error))?;
    let stage = (|| {
        hook(Step::WriteTemp, path)?;
        temp.write_all(bytes)?;
        if let Some(mode) = permissions {
            File::set_permissions(temp.as_file(), mode.clone())?;
        }
        hook(Step::Rename, path)
    })();
    let (error, temp) = match stage {
        Err(error) => (error, temp),
        Ok(()) => match if replace {
            temp.persist(path)
        } else {
            temp.persist_noclobber(path)
        } {
            Ok(_) => return Ok(()),
            Err(error) => (error.error, error.file),
        },
    };
    let error = io_error(path, error);
    let temp_path = temp.path().to_owned();
    match hook(Step::CleanupTemp, path).and_then(|()| temp.close()) {
        Ok(()) => Err(error),
        Err(cleanup) => Err(format!(
            "{error}\nFailed to clean up temporary file: {}",
            io_error(&temp_path, cleanup)
        )),
    }
}

#[derive(Default)]
struct Mutation {
    target_written: bool,
    source_removed: bool,
}

fn unlink(path: &Path, hook: &mut Hook<'_>) -> io::Result<()> {
    hook(Step::Remove, path)?;
    fs::remove_file(path)
}

fn remove_if_present(path: &Path, hook: &mut Hook<'_>) -> Result<()> {
    match unlink(path, hook) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(path, error)),
    }
}

fn apply_change(
    change: &Change,
    state: &mut Mutation,
    directories: &mut Vec<PathBuf>,
    hook: &mut Hook<'_>,
) -> Result<()> {
    if let Some(after) = &change.after {
        atomic_write(
            &change.target,
            after,
            change.permissions.as_ref(),
            !change.is_move() && change.before.is_some(),
            directories,
            hook,
        )?;
        state.target_written = true;
    }
    if change.after.is_none() || change.is_move() {
        unlink(&change.source, hook).map_err(|error| io_error(&change.source, error))?;
        state.source_removed = true;
    }
    hook(Step::Applied, &change.target).map_err(|error| io_error(&change.target, error))
}

fn rollback_change(
    change: &Change,
    state: Mutation,
    directories: &mut Vec<PathBuf>,
    hook: &mut Hook<'_>,
) -> Result<()> {
    if state.source_removed {
        // Restore first: if this fails, the move destination may be the only remaining copy.
        if let Some(before) = &change.before {
            atomic_write(
                &change.source,
                before,
                change.permissions.as_ref(),
                false,
                directories,
                hook,
            )?;
        }
    }
    if state.target_written {
        if change.is_move() || change.before.is_none() {
            remove_if_present(&change.target, hook)?;
        } else if let Some(before) = &change.before {
            atomic_write(
                &change.source,
                before,
                change.permissions.as_ref(),
                true,
                directories,
                hook,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(cwd: &Path, body: &str) -> Plan {
        Plan::build_with_cancel(
            cwd,
            &format!("*** Begin Patch\n{body}\n*** End Patch"),
            &Cancelled::default(),
        )
        .unwrap()
    }

    fn assert_clean(dir: &Path) {
        assert!(!fs::read_dir(dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".patchcraft-")
        }));
    }

    #[test]
    fn reverses_writes_and_a_delete_when_the_last_temporary_write_fails() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        for (name, bytes) in [
            ("old", b"\xff\x00".as_slice()),
            ("deleted", b"keep\n"),
            ("fail", b"keep\n"),
        ] {
            fs::write(cwd.join(name), bytes).unwrap();
        }
        let p = plan(
            cwd,
            "*** Add File: fresh\n+x\n*** Delete File: deleted\n*** Add File: old\n+x\n*** Add File: fail\n+x",
        );
        let mut events = Vec::new();
        let error = p
            .apply_with(&Cancelled::default(), &mut |step, path| {
                let name = path.file_name().unwrap().to_string_lossy();
                if matches!(step, Step::Rename | Step::Remove) {
                    events.push((step, name.to_string()));
                }
                if step == Step::WriteTemp && name == "fail" {
                    Err(io::Error::other("write failed"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert!(
            error.contains("write failed")
                && error.contains("All applied changes were rolled back")
        );
        assert_eq!(
            events,
            [
                (Step::Rename, "fresh".into()),
                (Step::Remove, "deleted".into()),
                (Step::Rename, "old".into()),
                (Step::Rename, "old".into()),
                (Step::Rename, "deleted".into()),
                (Step::Remove, "fresh".into()),
            ]
        );
        assert!(!cwd.join("fresh").exists());
        assert_eq!(fs::read(cwd.join("old")).unwrap(), b"\xff\x00");
        assert_eq!(fs::read(cwd.join("deleted")).unwrap(), b"keep\n");
        assert_eq!(fs::read(cwd.join("fail")).unwrap(), b"keep\n");
        assert_clean(cwd);
    }

    #[test]
    fn rollback_removes_only_empty_directories_created_by_the_patch() {
        for concurrent_file in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let cwd = dir.path();
            fs::create_dir(cwd.join("keep")).unwrap();
            let error = plan(
                cwd,
                "*** Add File: keep/new/nested/fresh\n+x\n*** Add File: fail/nested/file\n+x",
            )
            .apply_with(&Cancelled::default(), &mut |step, path| {
                if step == Step::WriteTemp && path.ends_with("file") {
                    if concurrent_file {
                        fs::write(cwd.join("keep/new/concurrent"), "keep")?;
                    }
                    return Err(io::Error::other("write failed"));
                }
                Ok(())
            })
            .unwrap_err();
            assert!(!cwd.join("fail").exists());
            assert!(!cwd.join("keep/new/nested").exists());
            assert!(cwd.join("keep").is_dir());
            if concurrent_file {
                assert!(error.contains("Rollback failed"));
                assert_eq!(
                    fs::read_to_string(cwd.join("keep/new/concurrent")).unwrap(),
                    "keep"
                );
            } else {
                assert!(error.contains("All applied changes were rolled back"));
                assert!(!cwd.join("keep/new").exists());
            }
        }
    }

    #[test]
    fn failed_rename_does_not_replace_untouched_hardlink_and_reports_cleanup_errors() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        let value = cwd.join("value");
        let alias = cwd.join("alias");
        fs::write(&value, "before\n").unwrap();
        fs::hard_link(&value, &alias).unwrap();
        let error = plan(cwd, "*** Add File: value\n+after")
            .apply_with(&Cancelled::default(), &mut |step, _| match step {
                Step::Rename => Err(io::Error::other("rename failed")),
                Step::CleanupTemp => Err(io::Error::other("cleanup failed")),
                _ => Ok(()),
            })
            .unwrap_err();
        assert!(
            error.contains("rename failed")
                && error.contains("Failed to clean up temporary file")
                && error.contains("cleanup failed")
        );
        assert_eq!(fs::read_to_string(&value).unwrap(), "before\n");
        fs::write(&alias, "inode intact").unwrap();
        assert_eq!(fs::read_to_string(&value).unwrap(), "inode intact");
    }

    #[test]
    fn failed_source_restore_preserves_completed_move_destination() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        fs::write(cwd.join("source"), "original\n").unwrap();
        let p = plan(
            cwd,
            "*** Update File: source\n*** Move to: target\n@@\n original\n*** Add File: fail\n+x",
        );
        let error = p
            .apply_with(&Cancelled::default(), &mut |step, path| {
                if step == Step::Rename && (path.ends_with("source") || path.ends_with("fail")) {
                    Err(io::Error::other("rename blocked"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert!(error.contains("Rollback failed"));
        assert!(!cwd.join("source").exists());
        assert_eq!(
            fs::read_to_string(cwd.join("target")).unwrap(),
            "original\n"
        );
        assert_clean(cwd);
    }

    #[test]
    fn abort_after_first_or_final_mutation_rolls_back_before_returning() {
        for stop_after in ["one", "two"] {
            let dir = tempfile::tempdir().unwrap();
            let cwd = dir.path();
            fs::write(cwd.join("one"), "before\n").unwrap();
            let p = plan(cwd, "*** Add File: one\n+after\n*** Add File: two\n+new");
            let cancelled = Cancelled::default();
            let error = p
                .apply_with(&cancelled, &mut |step, path| {
                    if step == Step::Applied && path.ends_with(stop_after) {
                        cancelled.cancel();
                    }
                    Ok(())
                })
                .unwrap_err();
            assert!(
                error.contains("aborted") && error.contains("All applied changes were rolled back")
            );
            assert_eq!(fs::read_to_string(cwd.join("one")).unwrap(), "before\n");
            assert!(!cwd.join("two").exists());
            assert_clean(cwd);
        }
    }
}
