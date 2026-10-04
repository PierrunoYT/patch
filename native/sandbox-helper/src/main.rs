// Runs commands inside a Windows AppContainer for Patch. Speaks line-delimited JSON on stdin/stdout:
// see docs/ARCHITECTURE.md ("Windows sandbox helper") for the protocol.
mod proto;
mod text;
#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    win::serve();
}

#[cfg(not(windows))]
fn main() {
    println!(
        "{}",
        proto::encode_event(&proto::Event::Error {
            id: None,
            message: "sandbox-helper only runs on Windows."
        })
    );
    std::process::exit(1);
}
