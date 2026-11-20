use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

type Snapshot = BTreeMap<PathBuf, Option<Vec<u8>>>;

fn snapshot(root: &Path) -> Snapshot {
    fn visit(root: &Path, dir: &Path, entries: &mut Snapshot) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let key = path.strip_prefix(root).unwrap().to_owned();
            if entry.file_type().unwrap().is_dir() {
                entries.insert(key, None);
                visit(root, &path, entries);
            } else {
                entries.insert(key, Some(fs::read(path).unwrap()));
            }
        }
    }
    let mut entries = Snapshot::new();
    if root.is_dir() {
        visit(root, root, &mut entries);
    }
    entries
}

#[test]
fn runs_codex_scenarios_with_transactional_exceptions() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex");
    let mut cases: Vec<_> = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir())
        .collect();
    cases.sort_unstable();
    for case in cases {
        let dir = tempfile::tempdir().unwrap();
        let name = case.file_name().unwrap().to_str().unwrap();
        let input = snapshot(&case.join("input"));
        for (path, contents) in &input {
            let dest = dir.path().join(path);
            match contents {
                Some(contents) => fs::write(dest, contents).unwrap(),
                None => fs::create_dir(dest).unwrap(),
            }
        }
        let output = Command::new(env!("CARGO_BIN_EXE_patchcraft-core"))
            .args(["apply", "--json"])
            .current_dir(dir.path())
            .stdin(Stdio::from(fs::File::open(case.join("patch.txt")).unwrap()))
            .output()
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
                panic!(
                    "{name}: {error}; stderr: {}",
                    String::from_utf8_lossy(&output.stderr)
                )
            });

        let expected = match name {
            // Patchcraft refuses to overwrite move destinations and preflights the whole
            // envelope instead of leaving partially committed changes on failure.
            "010_move_overwrites_existing_destination" => {
                assert!(
                    json["message"]
                        .as_str()
                        .unwrap()
                        .contains("Move target already exists")
                );
                input.clone()
            }
            "015_failure_after_partial_success_leaves_changes" => {
                assert!(json["message"].as_str().unwrap().contains("does not exist"));
                input.clone()
            }
            _ => snapshot(&case.join("expected")),
        };
        assert_eq!(output.status.success(), input != expected, "{name}: {json}");
        assert_eq!(snapshot(dir.path()), expected, "{name}: {json}");
    }
}
