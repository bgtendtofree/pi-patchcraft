//! Alias and ancestor conflicts owned by the Rust core.
//!
//! Comparison ignores case and Unicode normalization on every host, so these assertions do not
//! depend on the filesystem the suite runs on.

use std::fs;
use std::path::Path;

mod common;
use common::{plan_error, read, workspace, write};

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn rejects_case_aliases_of_one_existing_file() {
    let cwd = workspace();
    write(cwd.path(), "a.txt", "old\n");
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+one\n*** Update File: A.txt\n@@\n-old\n+two\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert_eq!(read(cwd.path(), "a.txt"), "old\n");
}

#[test]
fn rejects_case_aliases_of_pending_targets() {
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: fresh.txt\n+first\n*** Add File: FRESH.txt\n+second\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_unicode_normalization_aliases_of_pending_targets() {
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: caf\u{e9}.txt\n+first\n*** Add File: cafe\u{301}.txt\n+second\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_a_move_destination_aliasing_a_pending_target() {
    let cwd = workspace();
    write(cwd.path(), "source.txt", "old\n");
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: fresh.txt\n+first\n*** Update File: source.txt\n*** Move to: FRESH.txt\n@@\n old\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert_eq!(read(cwd.path(), "source.txt"), "old\n");
    assert!(
        entries(cwd.path())
            .iter()
            .all(|name| name.to_lowercase() != "fresh.txt")
    );
}

#[test]
fn rejects_an_add_aliasing_a_moves_source() {
    let cwd = workspace();
    write(cwd.path(), "source.txt", "old\n");
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n old\n*** Add File: SOURCE.txt\n+new\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert_eq!(entries(cwd.path()), ["source.txt"]);
    assert_eq!(read(cwd.path(), "source.txt"), "old\n");
}

#[test]
fn permits_case_only_moves_when_the_destination_does_not_exist() {
    let cwd = workspace();
    write(cwd.path(), "source.txt", "old\n");
    let result = common::plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: source.txt\n*** Move to: SOURCE.txt\n@@\n old\n*** End Patch",
    );
    if cwd.path().join("SOURCE.txt").exists() {
        assert!(result.err().unwrap().contains("Move target already exists"));
    } else {
        common::apply(result.unwrap());
        assert_eq!(entries(cwd.path()), ["SOURCE.txt"]);
        assert_eq!(read(cwd.path(), "SOURCE.txt"), "old\n");
    }
}

#[test]
fn rejects_a_touched_file_that_is_an_ancestor_of_another() {
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: folder\n+data\n*** Add File: folder/child.txt\n+child\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_an_ancestor_conflict_for_a_dotdot_prefixed_basename() {
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: folder\n+data\n*** Add File: folder/..child.txt\n+child\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_a_case_alias_of_an_ancestor_directory() {
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: Folder\n+data\n*** Add File: folder/child.txt\n+child\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn keeps_distinct_siblings_that_share_a_raw_prefix() {
    let cwd = workspace();
    let plan = common::plan(
        cwd.path(),
        "*** Begin Patch\n*** Add File: foo\n+one\n*** Add File: foobar/x.txt\n+two\n*** End Patch",
    )
    .unwrap();
    common::apply(plan);
    assert_eq!(read(cwd.path(), "foo"), "one\n");
    assert_eq!(read(cwd.path(), "foobar/x.txt"), "two\n");
}

#[test]
fn keeps_distinct_files_in_different_directories() {
    let cwd = workspace();
    let plan = common::plan(
        cwd.path(),
        "*** Begin Patch\n*** Add File: a.txt\n+lower\n*** Add File: nested/A.txt\n+upper\n*** End Patch",
    )
    .unwrap();
    common::apply(plan);
    assert_eq!(read(cwd.path(), "a.txt"), "lower\n");
    assert_eq!(read(cwd.path(), "nested/A.txt"), "upper\n");
}
