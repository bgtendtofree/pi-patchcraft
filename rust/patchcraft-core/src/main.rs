use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::{Arc, mpsc};

use base64::{Engine, engine::general_purpose::STANDARD};
use patchcraft_core::{Cancelled, MAX_PATCH_BYTES, Plan};
use serde::{Deserialize, Serialize};
use serde_json::json;

const PROTOCOL: u32 = 2;
// A JSON string can use six wire bytes for one byte of ASCII.
const MAX_REQUEST_BYTES: usize = 6 * MAX_PATCH_BYTES + 4096;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    patch: String,
}

fn send(value: &impl Serialize) -> Result<(), String> {
    let mut out = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut out, value).map_err(|error| error.to_string())?;
    out.write_all(b"\n")
        .and_then(|()| out.flush())
        .map_err(|error| error.to_string())
}

fn session(cwd: &Path, cancelled: Arc<Cancelled>) -> Result<(), String> {
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
    if request.protocol != PROTOCOL {
        return Err(format!(
            "Unsupported protocol {}; expected {PROTOCOL}",
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

    let plan = Plan::build_with_cancel(cwd, &request.patch, &cancelled)?;
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
    send(&json!({ "protocol": PROTOCOL, "status": "planned", "lockPaths": lock_paths }))?;
    if !decision.recv().unwrap_or(false) {
        return Err("Patch application aborted before commit".into());
    }
    plan.apply(&cancelled)?;
    send(&json!({ "protocol": PROTOCOL, "status": "applied" }))
}

fn standalone(cwd: &Path, cancelled: &Cancelled) -> Result<(), String> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_PATCH_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_PATCH_BYTES {
        return Err("Patch is too large: exceeds 1 MiB limit".into());
    }
    let patch = std::str::from_utf8(&bytes).map_err(|_| "Patch is not valid UTF-8")?;
    let plan = Plan::build_with_cancel(cwd, patch, cancelled)?;
    let result = serde_json::to_value(
        plan.changes()
            .iter()
            .map(|change| change.summary())
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())?;
    plan.apply(cancelled)?;
    send(&json!({ "protocol": PROTOCOL, "status": "applied", "changes": result }))
}

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args == ["doctor", "--json"] {
        return send(&json!({ "protocol": PROTOCOL, "version": env!("CARGO_PKG_VERSION") }));
    }
    let standalone_mode = args == ["apply", "--json"];
    if !standalone_mode && args != ["session", "--json"] {
        return Err("Usage: patchcraft-core doctor --json | apply --json | session --json".into());
    }
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let cancelled: Arc<Cancelled> = Arc::default();
    let signal = cancelled.clone();
    ctrlc::set_handler(move || signal.cancel()).map_err(|error| error.to_string())?;
    if standalone_mode {
        standalone(&cwd, &cancelled)
    } else {
        session(&cwd, cancelled)
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            if let Err(error) =
                send(&json!({ "protocol": PROTOCOL, "status": "error", "message": message }))
            {
                eprintln!("patchcraft-core: {message}\nFailed to report error: {error}");
            }
            ExitCode::FAILURE
        }
    }
}
