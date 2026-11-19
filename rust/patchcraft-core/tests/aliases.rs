//! Filesystem alias and ancestor behavior owned by the Rust core.
//!
//! Case/normalization-sensitive hosts run the positive cases; insensitive hosts run the rejection
//! cases. The probes use separate workspaces so the assertions can keep the test directory exact.

use std::fs;
use std::path::Path;

mod common;
use common::{apply, plan, plan_error, read, workspace, write};

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn case_insensitive() -> bool {
    let probe = workspace();
    write(probe.path(), "case-probe.txt", "probe\n");
    fs::metadata(probe.path().join("CASE-PROBE.TXT")).is_ok()
}

fn normalization_insensitive() -> bool {
    let probe = workspace();
    write(probe.path(), "caf\u{e9}-probe.txt", "probe\n");
    fs::metadata(probe.path().join("cafe\u{301}-probe.txt")).is_ok()
}

#[test]
fn rejects_case_aliases_of_one_existing_file() {
    if !case_insensitive() {
        return;
    }
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
fn rejects_a_move_to_another_case_spelling_of_an_existing_file() {
    if !case_insensitive() {
        return;
    }
    let cwd = workspace();
    write(cwd.path(), "a.txt", "old\n");
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: A.txt\n*** Move to: a.txt\n@@\n-old\n+new\n*** End Patch",
    );
    assert!(error.contains("Move target already exists"), "{error}");
    assert_eq!(read(cwd.path(), "a.txt"), "old\n");
    assert_eq!(
        entries(cwd.path())
            .into_iter()
            .filter(|name| name.to_lowercase() == "a.txt")
            .count(),
        1
    );
}

#[test]
fn rejects_case_aliases_of_a_not_yet_created_target() {
    if !case_insensitive() {
        return;
    }
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: fresh.txt\n+first\n*** Add File: FRESH.txt\n+second\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_a_move_destination_aliasing_a_pending_target() {
    if !case_insensitive() {
        return;
    }
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
fn keeps_distinct_case_spellings_on_a_case_sensitive_filesystem() {
    if case_insensitive() {
        return;
    }
    let cwd = workspace();
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: a.txt\n+lower\n*** Add File: A.txt\n+upper\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "a.txt"), "lower\n");
    assert_eq!(read(cwd.path(), "A.txt"), "upper\n");
}

#[test]
fn rejects_unicode_normalization_aliases_of_pending_move_destinations() {
    if !normalization_insensitive() {
        return;
    }
    let cwd = workspace();
    write(cwd.path(), "first.txt", "FIRST\n");
    write(cwd.path(), "second.txt", "SECOND\n");
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: first.txt\n*** Move to: nested/caf\u{e9}.txt\n@@\n FIRST\n*** Update File: second.txt\n*** Move to: nested/cafe\u{301}.txt\n@@\n SECOND\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert_eq!(read(cwd.path(), "first.txt"), "FIRST\n");
    assert_eq!(read(cwd.path(), "second.txt"), "SECOND\n");
    assert_eq!(
        entries(cwd.path()),
        vec!["first.txt".to_owned(), "second.txt".to_owned()]
    );
}

#[test]
fn rejects_unicode_normalization_aliases_of_pending_add_targets() {
    if !normalization_insensitive() {
        return;
    }
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: caf\u{e9}.txt\n+first\n*** Add File: cafe\u{301}.txt\n+second\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_unicode_normalization_aliases_of_one_existing_file() {
    if !normalization_insensitive() {
        return;
    }
    let cwd = workspace();
    write(cwd.path(), "caf\u{e9}.txt", "old\n");
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: caf\u{e9}.txt\n@@\n-old\n+one\n*** Update File: cafe\u{301}.txt\n@@\n-old\n+two\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert_eq!(read(cwd.path(), "caf\u{e9}.txt"), "old\n");
}

#[test]
fn keeps_distinct_unicode_spellings_when_normalization_is_sensitive() {
    if normalization_insensitive() {
        return;
    }
    let cwd = workspace();
    write(cwd.path(), "probe-caf\u{e9}.txt", "probe\n");
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: caf\u{e9}.txt\n+composed\n*** Add File: cafe\u{301}.txt\n+decomposed\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "caf\u{e9}.txt"), "composed\n");
    assert_eq!(read(cwd.path(), "cafe\u{301}.txt"), "decomposed\n");
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
fn keeps_distinct_siblings_that_share_a_raw_prefix() {
    let cwd = workspace();
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: foo\n+one\n*** Add File: foobar/x.txt\n+two\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "foo"), "one\n");
    assert_eq!(read(cwd.path(), "foobar/x.txt"), "two\n");
}

#[test]
fn rejects_a_case_alias_of_an_ancestor_directory() {
    if !case_insensitive() {
        return;
    }
    let cwd = workspace();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: Folder\n+data\n*** Add File: folder/child.txt\n+child\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(entries(cwd.path()).is_empty());
}

#[test]
fn rejects_unicode_case_aliases_of_move_destinations() {
    let cwd = workspace();
    let candidates = [
        ("\u{df}.txt", "SS.txt"),
        ("\u{1e9e}.txt", "ss.txt"),
        ("\u{1e9e}.txt", "\u{df}.txt"),
    ];
    let mut aliases = Vec::new();
    for (left, right) in candidates {
        write(cwd.path(), left, "probe\n");
        if fs::metadata(cwd.path().join(right)).is_ok() {
            aliases.push((left, right));
        }
        fs::remove_file(cwd.path().join(left)).unwrap();
    }
    if aliases.is_empty() {
        return;
    }

    write(cwd.path(), "one.txt", "FIRST\n");
    write(cwd.path(), "two.txt", "SECOND\n");
    for (left, right) in aliases {
        let error = plan_error(
            cwd.path(),
            &format!(
                "*** Begin Patch\n*** Update File: one.txt\n*** Move to: {left}\n@@\n FIRST\n*** Update File: two.txt\n*** Move to: {right}\n@@\n SECOND\n*** End Patch"
            ),
        );
        assert!(error.contains("conflicting operations"), "{error}");
    }
    assert_eq!(read(cwd.path(), "one.txt"), "FIRST\n");
    assert_eq!(read(cwd.path(), "two.txt"), "SECOND\n");
}
