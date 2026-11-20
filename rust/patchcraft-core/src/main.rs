use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, mpsc};

use base64::{Engine, engine::general_purpose::STANDARD};
use patchcraft_core::{Cancelled, MAX_PATCH_BYTES, PROTOCOL_VERSION, Plan};
use serde::{Deserialize, Serialize};
use serde_json::json;

// Allow six wire bytes per input byte, plus space for a long workspace path.
const MAX_REQUEST_BYTES: usize = 6 * (MAX_PATCH_BYTES + 32 * 1024);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    cwd: PathBuf,
    patch: String,
}

fn send(value: &impl Serialize) -> Result<(), String> {
    let mut out = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut out, value).map_err(|error| error.to_string())?;
    out.write_all(b"\n")
        .and_then(|()| out.flush())
        .map_err(|error| error.to_string())
}

fn session(cancelled: Arc<Cancelled>) -> Result<ExitCode, String> {
    let mut input = io::BufReader::new(io::stdin());
    let mut line = Vec::new();
    (&mut input)
        .take(MAX_REQUEST_BYTES as u64 + 1)
        .read_until(b'\n', &mut line)
        .map_err(|error| error.to_string())?;
    if line.len() > MAX_REQUEST_BYTES {
        return Err("JSON request is too large (patch exceeds 1 MiB limit)".into());
    }
    let request: Request = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
    if request.protocol != PROTOCOL_VERSION {
        return Err(format!(
            "Unsupported protocol {}; expected {PROTOCOL_VERSION}",
            request.protocol
        ));
    }
    drop(line);
    let (accept, decision) = mpsc::sync_channel(1);
    let cancel = cancelled.clone();
    // After commit, the only permitted client input is cancellation. A closed
    // pipe (including a vanished host) also requests cancellation, not a kill.
    std::thread::Builder::new()
        .name("patchcraft-control".into())
        .spawn(move || {
            let mut message = Vec::new();
            let authorised = (&mut input).take(8).read_until(b'\n', &mut message).is_ok()
                && message == b"commit\n";
            if !authorised || !input.buffer().is_empty() {
                cancel.cancel();
            }
            let _ = accept.send(authorised);
            if authorised {
                let _ = input.read(&mut [0]);
                cancel.cancel();
            }
        })
        .map_err(|error| error.to_string())?;

    let plan = Plan::build_with_cancel(&request.cwd, &request.patch, &cancelled)?;
    // The plan owns everything commit needs; release the request (and its patch copy) before
    // streaming snapshots. `line` was the serialized copy and was already dropped above.
    drop(request);
    let mut lock_paths: Vec<_> = plan.lock_paths().into_iter().collect();
    lock_paths.sort_unstable();
    // Reject non-UTF-8 paths before publishing any plan for the Pi host.
    let lock_paths: Vec<_> = lock_paths
        .iter()
        .map(|path| {
            path.to_str()
                .ok_or_else(|| format!("Patch path is not valid UTF-8: {}", path.display()))
        })
        .collect::<Result<_, _>>()?;
    #[derive(Serialize)]
    struct ChangeFrame<'a, T> {
        status: &'static str,
        change: &'a T,
        before: String,
        after: String,
    }
    for change in plan.changes() {
        let (before, after) = change.texts();
        send(&ChangeFrame {
            status: "change",
            change: change.summary(),
            before: STANDARD.encode(before),
            after: STANDARD.encode(after),
        })?;
    }
    send(&json!({ "protocol": PROTOCOL_VERSION, "status": "planned", "lockPaths": lock_paths }))?;
    if !decision.recv().unwrap_or(false) {
        return Err("Patch application aborted before commit".into());
    }
    plan.apply(&cancelled)?;
    // A failure reporting success does not turn an applied patch into a rejection.
    if let Err(error) = send(&json!({ "protocol": PROTOCOL_VERSION, "status": "applied" })) {
        eprintln!("patchcraft-core: Patch applied but could not report success: {error}");
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}

fn run() -> Result<ExitCode, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args == ["doctor", "--json"] {
        return send(
            &json!({ "protocol": PROTOCOL_VERSION, "version": env!("CARGO_PKG_VERSION") }),
        )
        .map(|()| ExitCode::SUCCESS);
    }
    if args != ["session", "--json"] {
        return Err("Usage: patchcraft-core doctor --json | session --json".into());
    }
    let cancelled: Arc<Cancelled> = Arc::default();
    let signal = cancelled.clone();
    ctrlc::set_handler(move || signal.cancel()).map_err(|error| error.to_string())?;
    session(cancelled)
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(message) => {
            if let Err(error) = send(
                &json!({ "protocol": PROTOCOL_VERSION, "status": "error", "message": message }),
            ) {
                eprintln!("patchcraft-core: {message}\nFailed to report error: {error}");
            }
            ExitCode::FAILURE
        }
    }
}
