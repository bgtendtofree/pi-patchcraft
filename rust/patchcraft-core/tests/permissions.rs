//! Unix permission and rollback behavior owned by the Rust core.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

mod common;
use common::{apply, apply_error, plan, read, workspace, write};

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

#[test]
fn preserves_executable_mode_when_updating() {
    let cwd = workspace();
    write(cwd.path(), "script.sh", "old\n");
    let target = cwd.path().join("script.sh");
    set_mode(&target, 0o755);
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: script.sh\n@@\n-old\n+new\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(mode(&target), 0o755);
}

#[test]
fn preserves_executable_mode_when_moving() {
    let cwd = workspace();
    write(cwd.path(), "source.sh", "echo test\n");
    let source = cwd.path().join("source.sh");
    let target = cwd.path().join("target.sh");
    set_mode(&source, 0o755);
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: source.sh\n*** Move to: target.sh\n@@\n echo test\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(mode(&target), 0o755);
    assert!(!source.exists());
}

#[test]
fn preserves_a_restrictive_mode_when_updating() {
    let cwd = workspace();
    write(cwd.path(), "secret.txt", "old\n");
    let target = cwd.path().join("secret.txt");
    set_mode(&target, 0o600);
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: secret.txt\n@@\n-old\n+new\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(mode(&target), 0o600);
    assert_eq!(read(cwd.path(), "secret.txt"), "new\n");
}

#[test]
fn rejects_permission_drift_between_planning_and_apply() {
    let cwd = workspace();
    write(cwd.path(), "value.txt", "before\n");
    let target = cwd.path().join("value.txt");
    set_mode(&target, 0o644);
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .unwrap();
    set_mode(&target, 0o600);
    let error = apply_error(plan);
    assert!(
        error.contains("permissions changed before apply"),
        "{error}"
    );
    assert_eq!(mode(&target), 0o600);
    assert_eq!(read(cwd.path(), "value.txt"), "before\n");
}

#[test]
fn rolls_back_a_move_when_source_unlink_fails() {
    if is_root() {
        return;
    }
    let cwd = workspace();
    let source_directory = cwd.path().join("source");
    let target_directory = cwd.path().join("target");
    fs::create_dir(&source_directory).unwrap();
    fs::create_dir(&target_directory).unwrap();
    write(cwd.path(), "source/file.txt", "original\n");
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Update File: source/file.txt\n*** Move to: target/moved.txt\n@@\n original\n*** End Patch",
    )
    .unwrap();
    // The read-only source directory makes the unlink fail after the destination was written.
    set_mode(&source_directory, 0o500);
    let error = apply_error(plan);
    set_mode(&source_directory, 0o700);
    assert!(
        error.contains("All applied changes were rolled back"),
        "{error}"
    );
    assert_eq!(read(cwd.path(), "source/file.txt"), "original\n");
    assert!(!target_directory.join("moved.txt").exists());
}

#[test]
fn rolls_back_an_add_when_a_read_only_update_fails() {
    if is_root() {
        return;
    }
    let cwd = workspace();
    write(cwd.path(), "read-only.txt", "before\n");
    let target = cwd.path().join("read-only.txt");
    set_mode(&target, 0o444);
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Add File: rolled-back.txt\n+created first\n*** Update File: read-only.txt\n@@\n-before\n+after\n*** End Patch",
    )
    .unwrap();
    let error = apply_error(plan);
    set_mode(&target, 0o644);
    let lower = error.to_lowercase();
    assert!(lower.contains("permission denied"), "{error}");
    assert!(
        error.contains("All applied changes were rolled back"),
        "{error}"
    );
    assert_eq!(read(cwd.path(), "read-only.txt"), "before\n");
    assert!(!cwd.path().join("rolled-back.txt").exists());
}

#[test]
fn moves_a_read_only_file_with_directory_permission_only() {
    if is_root() {
        return;
    }
    let cwd = workspace();
    write(cwd.path(), "source.txt", "original\n");
    let source = cwd.path().join("source.txt");
    set_mode(&source, 0o444);
    apply(
        plan(
            cwd.path(),
            "*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n original\n*** End Patch",
        )
        .unwrap(),
    );
    assert_eq!(read(cwd.path(), "moved.txt"), "original\n");
}

#[test]
fn plans_a_lone_add_without_listing_an_unreadable_directory() {
    if is_root() {
        return;
    }
    let cwd = workspace();
    let directory = cwd.path().join("nested");
    fs::create_dir(&directory).unwrap();
    set_mode(&directory, 0o300);
    let plan = plan(
        cwd.path(),
        "*** Begin Patch\n*** Add File: nested/only.txt\n+value\n*** End Patch",
    );
    let result = plan.and_then(|plan| plan.apply(&patchcraft_core::Cancelled::default()));
    set_mode(&directory, 0o700);
    result.unwrap();
    assert_eq!(read(cwd.path(), "nested/only.txt"), "value\n");
}
