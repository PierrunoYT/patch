// Runs commands inside a Windows AppContainer for Patch. Speaks line-delimited JSON on stdin/stdout:
// see docs/ARCHITECTURE.md ("Windows sandbox helper") for the protocol.
#[cfg(windows)]
mod pipe_io;
mod proto;
mod text;
#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--stdio") {
        let Some(path) = args.get(1) else {
            eprintln!("usage: sandbox-helper --stdio <request.json>");
            std::process::exit(2);
        };
        win::serve_stdio(path);
        return;
    }
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
