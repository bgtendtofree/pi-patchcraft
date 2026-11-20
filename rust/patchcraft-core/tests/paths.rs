//! Path and symlink semantics owned by the Rust core.

use std::fs;

use std::os::unix::fs::symlink;
use std::path::Path;

mod common;
use common::{apply, plan, read, workspace, write};
use common::{apply_error, plan_error};

#[test]
fn supports_absolute_and_parent_paths() {
    let root = workspace();
    let cwd = root.path().join("workspace");
    fs::create_dir(&cwd).unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let absolute = outside.join("absolute.txt");
    let patch = format!(
        "*** Begin Patch\n*** Add File: {}\n+absolute\n*** Add File: ../parent.txt\n+parent\n*** End Patch",
        absolute.display()
    );
    apply(plan(&cwd, &patch).unwrap());
    assert_eq!(read(&outside, "absolute.txt"), "absolute\n");
    assert_eq!(read(root.path(), "parent.txt"), "parent\n");
}

#[test]
fn supports_symlinked_directory_paths() {
    let root = workspace();
    let cwd = root.path().join("workspace");
    fs::create_dir(&cwd).unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, cwd.join("link")).unwrap();
    apply(
        plan(
            &cwd,
            "*** Begin Patch\n*** Add File: link/symlink.txt\n+symlink\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(&outside, "symlink.txt"), "symlink\n");
}

#[test]
fn rejects_the_same_file_through_a_symlinked_parent() {
    let cwd = workspace();
    fs::create_dir(cwd.path().join("real")).unwrap();
    symlink(cwd.path().join("real"), cwd.path().join("alias")).unwrap();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: real/nested/new.txt\n+first\n*** Add File: alias/nested/new.txt\n+second\n*** End Patch",
    );
    assert!(error.contains("conflicting operations"), "{error}");
    assert!(!cwd.path().join("real/nested/new.txt").exists());
}

#[test]
fn follows_file_symlinks_for_add_and_update() {
    let cwd = workspace();
    write(cwd.path(), "real.txt", "before\n");
    let link = cwd.path().join("link.txt");
    symlink("real.txt", &link).unwrap();

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: link.txt\n@@\n-before\n+after\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "real.txt"), "after\n");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(&link).unwrap().as_path(),
        Path::new("real.txt")
    );

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "real.txt"), "created\n");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn creates_the_target_of_a_dangling_file_symlink_on_add() {
    let cwd = workspace();
    let link = cwd.path().join("link.txt");
    symlink("missing.txt", &link).unwrap();
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "missing.txt"), "created\n");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(&link).unwrap().as_path(),
        Path::new("missing.txt")
    );
}

#[test]
fn resolves_dotdot_in_a_symlink_target_against_the_real_chain() {
    let cwd = workspace();
    fs::create_dir_all(cwd.path().join("elsewhere/inner")).unwrap();
    symlink(cwd.path().join("elsewhere/inner"), cwd.path().join("jump")).unwrap();
    write(cwd.path(), "target.txt", "old\n");
    write(cwd.path(), "elsewhere/target.txt", "old\n");
    symlink("jump/../target.txt", cwd.path().join("link.txt")).unwrap();

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: link.txt\n@@\n-old\n+new\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "target.txt"), "old\n");
    assert_eq!(read(cwd.path(), "elsewhere/target.txt"), "new\n");
    assert_eq!(read(cwd.path(), "link.txt"), "new\n");
    assert!(
        fs::symlink_metadata(cwd.path().join("link.txt"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn rejects_a_symlink_target_through_a_non_directory() {
    let cwd = workspace();
    write(cwd.path(), "regular-file", "file\n");
    write(cwd.path(), "target.txt", "old\n");
    symlink("regular-file/../target.txt", cwd.path().join("link.txt")).unwrap();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch",
    );
    assert!(
        error.contains("ENOTDIR") || error.contains("not a directory"),
        "{error}"
    );
    assert_eq!(read(cwd.path(), "target.txt"), "old\n");
}

#[test]
fn rejects_a_regular_file_symlink_target_ending_in_a_slash() {
    let cwd = workspace();
    write(cwd.path(), "target.txt", "old\n");
    symlink("target.txt/", cwd.path().join("link.txt")).unwrap();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: link.txt\n@@\n-old\n+new\n*** End Patch",
    );
    assert!(
        error.contains("ENOTDIR") || error.contains("not a directory"),
        "{error}"
    );
    assert_eq!(read(cwd.path(), "target.txt"), "old\n");
}

#[test]
fn rejects_a_dangling_symlink_target_that_requires_a_directory() {
    let cwd = workspace();
    symlink("missing/", cwd.path().join("link.txt")).unwrap();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch",
    );
    assert!(error.contains("requires a directory"), "{error}");
    assert!(!cwd.path().join("missing").exists());
}

#[test]
fn rejects_dotdot_after_a_missing_symlink_component() {
    let cwd = workspace();
    symlink("missing/../new.txt", cwd.path().join("link.txt")).unwrap();
    let error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch",
    );
    assert!(error.contains("after a missing component"), "{error}");
    assert!(!cwd.path().join("new.txt").exists());
    assert!(!cwd.path().join("missing").exists());
}

#[test]
fn rejects_conflicts_through_a_dangling_link_under_a_symlinked_parent() {
    let cwd = workspace();
    fs::create_dir(cwd.path().join("real")).unwrap();
    symlink(cwd.path().join("real"), cwd.path().join("alias")).unwrap();
    write(cwd.path(), "source.txt", "precious\n");
    symlink("alias/new.txt", cwd.path().join("link.txt")).unwrap();

    for patch in [
        "*** Begin Patch\n*** Update File: source.txt\n*** Move to: real/new.txt\n@@\n precious\n*** Add File: link.txt\n+second\n*** End Patch",
        "*** Begin Patch\n*** Add File: link.txt\n+first\n*** Add File: real/new.txt\n+second\n*** End Patch",
    ] {
        let error = plan_error(cwd.path(), patch);
        assert!(error.contains("conflicting operations"), "{error}");
    }
    assert_eq!(read(cwd.path(), "source.txt"), "precious\n");
    assert!(!cwd.path().join("real/new.txt").exists());

    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Add File: link.txt\n+created\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "real/new.txt"), "created\n");
    assert!(
        fs::symlink_metadata(cwd.path().join("link.txt"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn refuses_delete_and_move_through_a_file_symlink() {
    let cwd = workspace();
    write(cwd.path(), "real.txt", "value\n");
    let link = cwd.path().join("link.txt");
    symlink("real.txt", &link).unwrap();

    let delete = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Delete File: link.txt\n*** End Patch",
    );
    assert!(
        delete.contains("Delete File does not follow symbolic links"),
        "{delete}"
    );
    let move_error = plan_error(
        cwd.path(),
        "*** Begin Patch\n*** Update File: link.txt\n*** Move to: moved.txt\n@@\n-value\n+changed\n*** End Patch",
    );
    assert!(
        move_error.contains("Move does not follow symbolic links"),
        "{move_error}"
    );
    assert_eq!(read(cwd.path(), "real.txt"), "value\n");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn rejects_a_file_symlink_retargeted_between_planning_and_apply() {
    let cwd = workspace();
    write(cwd.path(), "first.txt", "first\n");
    write(cwd.path(), "second.txt", "second\n");
    let link = cwd.path().join("link.txt");
    symlink("first.txt", &link).unwrap();
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: link.txt\n@@\n-first\n+changed\n*** End Patch",
    )
    .unwrap();
    fs::remove_file(&link).unwrap();
    symlink("second.txt", &link).unwrap();
    let error = apply_error(plan);
    assert!(
        error.contains("source link changed before apply"),
        "{error}"
    );
    assert_eq!(read(cwd.path(), "first.txt"), "first\n");
    assert_eq!(read(cwd.path(), "second.txt"), "second\n");
}
