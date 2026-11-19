//! Core filesystem semantics that do not depend on the Pi host.
//!
//! The TS suite keeps the client contract (diff frames, Pi queues, lifecycle) and no longer
//! duplicates parser/file-update matrices here.

use std::fs;

mod common;
use common::{apply, apply_error, plan, plan_error, read, summary_value, workspace, write};

#[test]
fn applies_contextual_fuzzy_moves() {
    let cwd = workspace();
    write(cwd.path(), "old.txt", "class A {\n  name = “old”  \n}\n");
    let plan = plan(
        cwd.path(),
        r#"*** Begin Patch
*** Update File: old.txt
*** Move to: nested/new.txt
@@ class A {
-  name = "old"
+  name = "new"
*** End Patch"#,
    )
    .unwrap();
    assert_eq!(summary_value(&plan, 0)["fuzz"], 10_000);
    apply(plan);
    assert_eq!(
        read(cwd.path(), "nested/new.txt"),
        "class A {\n  name = \"new\"\n}\n"
    );
    assert!(!cwd.path().join("old.txt").exists());
}

#[test]
fn appends_context_less_additions_at_end_of_file() {
    let cwd = workspace();
    write(cwd.path(), "value.txt", "before\nmarker\nafter\n");
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: value.txt\n@@ marker\n+inserted\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(
        read(cwd.path(), "value.txt"),
        "before\nmarker\nafter\ninserted\n"
    );
}

#[test]
fn preserves_patch_order_for_pure_additions_at_the_same_position() {
    let cwd = workspace();
    write(cwd.path(), "value.txt", "base\n");
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: value.txt\n@@\n+first\n@@\n+second\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "value.txt"), "base\nfirst\nsecond\n");
}

#[test]
fn inserts_into_an_empty_file_with_a_trailing_newline() {
    let cwd = workspace();
    write(cwd.path(), "empty.txt", "");
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: empty.txt\n@@\n+hello\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "empty.txt"), "hello\n");
}

#[test]
fn preserves_line_endings_and_adds_a_trailing_newline() {
    let cwd = workspace();
    write(cwd.path(), "crlf.txt", "before\r\nafter\r\n");
    write(cwd.path(), "no-final-newline.txt", "before\nafter");
    apply(
        plan(
            cwd.path(),
            r#"*** Begin Patch
*** Update File: crlf.txt
@@
-before
+changed
*** Update File: no-final-newline.txt
@@
-after
+changed
*** End Patch"#,
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "crlf.txt"), "changed\r\nafter\r\n");
    assert_eq!(
        read(cwd.path(), "no-final-newline.txt"),
        "before\nchanged\n"
    );
}

#[test]
fn treats_a_leading_bom_as_part_of_the_first_line() {
    let cwd = workspace();
    write(cwd.path(), "bom.txt", "\u{feff}before\nafter\n");
    let error = match plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: bom.txt\n@@\n-before\n+changed\n*** End Patch",
    ) {
        Ok(_) => panic!("expected the BOM patch to fail"),
        Err(error) => error,
    };
    assert!(error.contains("Failed to find expected lines"), "{error}");

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: bom.txt\n@@\n-\u{feff}before\n+\u{feff}changed\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "bom.txt"), "\u{feff}changed\nafter\n");
}

#[test]
fn rejects_missing_sources_and_directory_targets() {
    let cwd = workspace();
    fs::create_dir(cwd.path().join("dir")).unwrap();
    let missing = plan(
        cwd.path(),
        "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch",
    )
    .err()
    .expect("missing source must fail");
    assert!(missing.contains("does not exist"), "{missing}");

    let directory = plan(
        cwd.path(),
        "*** Begin Patch\n*** Delete File: dir\n*** End Patch",
    )
    .err()
    .expect("directory target must fail");
    assert!(directory.contains("not a regular file"), "{directory}");
}

#[test]
fn rejects_duplicate_resolved_paths_and_repeated_headers() {
    let cwd = workspace();
    let duplicate = plan(
        cwd.path(),
        "*** Begin Patch\n*** Add File: duplicate.txt\n+first\n*** Add File: ./duplicate.txt\n+second\n*** End Patch",
    )
    .err()
    .expect("resolved duplicate must fail");
    assert!(duplicate.contains("conflicting operations"), "{duplicate}");
    assert!(!cwd.path().join("duplicate.txt").exists());

    write(cwd.path(), "update.txt", "before\n");
    let repeated = plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: update.txt\n@@\n-before\n+one\n*** Update File: update.txt\n@@\n-before\n+two\n*** End Patch",
    )
    .err()
    .expect("repeated update header must fail");
    assert!(repeated.contains("update then update"), "{repeated}");
    assert_eq!(read(cwd.path(), "update.txt"), "before\n");
}

#[test]
fn detects_source_changes_between_planning_and_apply() {
    let cwd = workspace();
    write(cwd.path(), "value.txt", "before\n");
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .unwrap();
    write(cwd.path(), "value.txt", "concurrent\n");
    let error = apply_error(plan);
    assert!(error.contains("changed before apply"), "{error}");
    assert_eq!(read(cwd.path(), "value.txt"), "concurrent\n");
}

#[test]
fn detects_add_targets_created_between_planning_and_apply() {
    let cwd = workspace();
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Add File: new.txt\n+planned\n*** End Patch",
    )
    .unwrap();
    write(cwd.path(), "new.txt", "concurrent\n");
    let error = apply_error(plan);
    assert!(error.contains("target changed before apply"), "{error}");
    assert_eq!(read(cwd.path(), "new.txt"), "concurrent\n");
}

#[test]
fn detects_move_targets_created_between_planning_and_apply() {
    let cwd = workspace();
    write(cwd.path(), "source.txt", "source\n");
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n@@\n source\n*** End Patch",
    )
    .unwrap();
    write(cwd.path(), "target.txt", "concurrent\n");
    let error = apply_error(plan);
    assert!(error.contains("target changed before apply"), "{error}");
    assert_eq!(read(cwd.path(), "source.txt"), "source\n");
    assert_eq!(read(cwd.path(), "target.txt"), "concurrent\n");
}

#[test]
fn detects_deleted_sources_between_planning_and_apply() {
    let cwd = workspace();
    write(cwd.path(), "delete.txt", "planned\n");
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Delete File: delete.txt\n*** End Patch",
    )
    .unwrap();
    fs::remove_file(cwd.path().join("delete.txt")).unwrap();
    let error = apply_error(plan);
    assert!(error.contains("source changed before apply"), "{error}");
}

#[test]
fn keeps_a_leading_space_only_context_line() {
    let cwd = workspace();
    write(cwd.path(), "value.txt", "old\n\nold\n");
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: value.txt\n \n-old\n+new\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "value.txt"), "old\n\nnew\n");
}

#[test]
fn rejects_a_non_utf8_update_source_without_mutating_it() {
    let cwd = workspace();
    let original = vec![b'o', b'l', b'd', b'\n', 0xe9, b'\n'];
    write(cwd.path(), "binary.txt", &original);
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: binary.txt\n@@\n-old\n+new\n*** End Patch",
    );
    assert!(error.contains("not valid UTF-8"), "{error}");
    assert_eq!(fs::read(cwd.path().join("binary.txt")).unwrap(), original);
    assert!(fs::read_dir(cwd.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".patchcraft-")
    }));

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: binary.txt\n+new\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "binary.txt"), "new\n");

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Delete File: binary.txt\n*** End Patch",
        )
        .unwrap(),
    );
    assert!(!cwd.path().join("binary.txt").exists());
}
