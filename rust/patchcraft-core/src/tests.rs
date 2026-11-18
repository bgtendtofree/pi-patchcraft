use crate::{Operation, apply_chunks, parse_patch};

fn update(content: &str, lines: &str) -> Result<(String, u64), String> {
    let patch = format!("*** Begin Patch\n*** Update File: value.txt\n{lines}\n*** End Patch");
    let operations = parse_patch(&patch)?;
    let Operation::Update { path, chunks, .. } = &operations[0] else {
        unreachable!();
    };
    apply_chunks(content, path, chunks)
        .map(|result| (result.content, result.fuzz))
        .map_err(|error| error.to_string())
}

#[test]
fn parses_add_delete_update_move_and_stacked_contexts() {
    let patch = "\u{feff}*** Begin Patch\n*** Add File: new.txt \t\n+created\n+\n*** Delete File: gone.txt\n*** Update File: value.txt\n*** Move to: moved.txt\n@@ first\n@@\n@@ second\n keep\n-old\n+new\n*** End of File\n*** Update File: still.txt\n*** Move to: rename.txt\n*** End Patch\t";
    for eol in ["\n", "\r\n", "\r"] {
        let patch = patch.replace('\n', eol);
        let parsed = parse_patch(&patch).unwrap();
        assert!(
            matches!(&parsed[0], Operation::Add { path: "new.txt", content } if content == "created\n\n")
        );
        assert!(matches!(parsed[1], Operation::Delete { path: "gone.txt" }));
        let Operation::Update {
            path,
            move_to,
            chunks,
        } = &parsed[2]
        else {
            unreachable!()
        };
        assert_eq!((*path, *move_to), ("value.txt", Some("moved.txt")));
        let chunk = &chunks[0];
        assert_eq!(chunk.contexts, ["first", "second"]);
        assert_eq!(chunk.old_lines, ["keep", "old"]);
        assert_eq!(chunk.new_lines, ["keep", "new"]);
        assert_eq!(chunk.context_line_indices, [(0, 0)]);
        assert!(chunk.end_of_file);
        assert!(
            matches!(&parsed[3], Operation::Update { move_to: Some("rename.txt"), chunks, .. } if chunks.is_empty())
        );
    }
}

#[test]
fn parser_rejects_malformed_patches_and_codex_leniencies() {
    for (body, diagnostic) in [
        ("", "Patch is empty"),
        ("*** Add File: a", "no content lines"),
        ("*** Add File: a\nvalue", "must start with '+'"),
        ("*** Add File: a\n+valid\n", "must start with '+'"),
        ("*** Delete File: \u{feff}", "requires a path"),
        ("*** Delete File: a\0b", "contains NUL"),
        (
            "*** Environment ID: remote\n*** Delete File: a",
            "Unknown patch header",
        ),
        ("*** Update File: a", "is empty"),
        (
            "*** Update File: a\n@@bad\n-old\n+new",
            "Invalid update marker",
        ),
        ("*** Update File: a\n@@\n*** End of File", "no change lines"),
        (
            "*** Update File: a\n@@\n-old\n\n+new",
            "Invalid update line",
        ),
    ] {
        let patch = format!("*** Begin Patch\n{body}\n*** End Patch");
        let error = parse_patch(&patch).unwrap_err();
        assert!(error.contains(diagnostic), "{error}");
    }
    assert!(
        parse_patch("<<'EOF'\n*** Begin Patch\n*** Delete File: a\n*** End Patch\nEOF").is_err()
    );
    assert!(
        parse_patch("*** Begin Patch\n*** Add File: a\n+x")
            .unwrap_err()
            .contains("truncated")
    );
    assert!(
        parse_patch("*** Begin Patch\n*** Add File: a\n+x\n+*** End Patch")
            .unwrap_err()
            .contains("must not start")
    );
}

#[test]
fn matching_preserves_fuzz_bom_and_line_terminators() {
    for (content, hunk, expected, fuzz) in [
        ("\u{feff}old", "-old\n+new", "\u{feff}new\n", 0),
        ("old\u{feff}\n", "-old\n+new", "new\n", 1),
        ("  old\n", "-old\n+new", "new\n", 100),
        ("“a—b”\n", "-\"a-b\"\n+new", "new\n", 10_000),
        (
            "first \r\n second\u{202f}\rkeep\nold",
            "@@ first\n@@ second\n keep\n-old\n+new",
            "first \r\n second\u{202f}\rkeep\nnew\r\n",
            101,
        ),
        (
            "head\rold",
            "@@\n+first\n@@\n-old\n+new\n@@\n+second",
            "head\rnew\rfirst\rsecond\r",
            0,
        ),
        (
            "old\r\nold\r\n",
            "-old\n+tail\n*** End of File",
            "old\r\ntail\r\n",
            0,
        ),
        ("head\ntail\n", "-tail\n-\n+new\n+", "head\nnew\n", 0),
        ("", "+first", "first\n", 0),
        ("old\n", "-old", "", 0),
        ("a\n", " a\n-\n+x", "a\nx\n", 0),
        (
            "head\nanchor\nend\n",
            "@@ anchor\n+tail",
            "head\nanchor\nend\ntail\n",
            0,
        ),
    ] {
        assert_eq!(
            update(content, hunk),
            Ok((expected.to_owned(), fuzz)),
            "{hunk}"
        );
    }
}

#[test]
fn matching_reports_diagnostics_and_keeps_its_budget() {
    for (content, hunk, diagnostic) in [
        (
            "unrelated\n",
            "@@ missing\n-old\n+new",
            "Failed to find context",
        ),
        (
            "head\nkeep\nactual\n",
            " keep\n-missing\n+new",
            "Closest match at line 2 (1/2 lines matched)",
        ),
        (
            "\u{0085}old\n",
            "-old\n+new",
            "No line in the remaining file matched",
        ),
        ("1\n", "-①\n+new", "Failed to find expected lines"),
    ] {
        assert!(update(content, hunk).unwrap_err().contains(diagnostic));
    }
    let hunk = "-same\n".repeat(1_100) + "-absent\n+new";
    assert!(
        update(&"same\n".repeat(6_000), &hunk)
            .unwrap_err()
            .contains("comparison budget for value.txt")
    );
}
