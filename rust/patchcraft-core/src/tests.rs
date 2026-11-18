use crate::file_update::apply_chunks;
use crate::parser::{Hunk, parse_patch};

fn update(content: &str, chunk: &str) -> Result<(String, u64), String> {
    let patch = format!("*** Begin Patch\n*** Update File: value.txt\n{chunk}\n*** End Patch");
    let parsed = parse_patch(&patch).map_err(|error| error.to_string())?;
    let Hunk::UpdateFile { chunks, .. } = &parsed.hunks[0] else {
        unreachable!();
    };
    let updated = apply_chunks(content, "value.txt", chunks)?;
    Ok((updated.content, updated.fuzz))
}

#[test]
fn reports_fuzz_tiers_and_accumulates_anchor_and_body_scores() {
    for (content, chunk, expected, fuzz) in [
        ("old\n", "-old\n+new", "new\n", 0),
        ("old \n", "-old\n+new", "new\n", 1),
        (" old\n", "-old\n+new", "new\n", 100),
        ("“a—b”\n", "-\"a-b\"\n+new", "new\n", 10_000),
        (
            "anchor \n old\n",
            "@@ anchor\n-old\n+new",
            "anchor \nnew\n",
            101,
        ),
        ("\u{0085}old\n", "-old\n+new", "new\n", 100),
    ] {
        assert_eq!(update(content, chunk), Ok((expected.to_owned(), fuzz)));
    }
}

#[test]
fn bounds_worst_case_matching() {
    let chunk = "-same\n".repeat(1_100) + "-absent\n+new";
    let error = update(&"same\n".repeat(6_000), &chunk).unwrap_err();
    assert!(error.contains("comparison budget for value.txt"), "{error}");
}
