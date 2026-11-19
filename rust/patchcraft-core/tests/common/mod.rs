#![allow(dead_code)]

use std::fs;
use std::path::Path;

use patchcraft_core::{Cancelled, Plan};
use serde_json::Value;
use tempfile::TempDir;

pub fn workspace() -> TempDir {
    tempfile::tempdir().unwrap()
}

pub fn write(root: &Path, path: &str, contents: impl AsRef<[u8]>) {
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(target, contents).unwrap();
}

pub fn read(root: &Path, path: &str) -> String {
    fs::read_to_string(root.join(path)).unwrap()
}

pub fn plan(root: &Path, patch: &str) -> Result<Plan, String> {
    Plan::build_with_cancel(root, patch, &Cancelled::default())
}

pub fn plan_error(root: &Path, patch: &str) -> String {
    match plan(root, patch) {
        Ok(_) => panic!("expected planning to fail"),
        Err(error) => error,
    }
}

pub fn apply(plan: Plan) {
    plan.apply(&Cancelled::default()).unwrap();
}

pub fn apply_error(plan: Plan) -> String {
    match plan.apply(&Cancelled::default()) {
        Ok(()) => panic!("expected apply to fail"),
        Err(error) => error,
    }
}

pub fn summary_value(plan: &Plan, index: usize) -> Value {
    serde_json::to_value(plan.changes()[index].summary()).unwrap()
}
