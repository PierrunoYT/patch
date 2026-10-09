// Runs inside a sandboxed command's own network namespace when Patch filters its network (#97). The namespace has
// only loopback: this listens on 127.0.0.1:<port>, forwards every connection to <socket> (Patch's filtering proxy,
// mounted into the sandbox), then runs <program> with its arguments and exits with its status.
//
// usage: net-bridge <port> <socket> -- <program> [args...]

#[cfg(unix)]
fn main() {
    use std::io::{self, Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{exit, Command};
    use std::thread;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(port), Some(socket), Some("--")) = (
        args.first().and_then(|port| port.parse::<u16>().ok()),
        args.get(1).cloned(),
        args.get(2).map(String::as_str),
    ) else {
        eprintln!("usage: net-bridge <port> <socket> -- <program> [args...]");
        exit(2);
    };
    let Some(program) = args.get(3) else {
        eprintln!("net-bridge: no program to run");
        exit(2);
    };
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Patch sandbox: cannot start the network proxy bridge: {error}");
            exit(126);
        }
    };

    // Copies one direction until it ends, then half-closes the other side so the peer sees end of input.
    fn pump(mut from: impl Read, mut to: impl Write, done: impl FnOnce()) {
        let _ = io::copy(&mut from, &mut to);
        done();
    }

    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let socket = socket.clone();
            thread::spawn(move || {
                // The proxy may be gone (the command outlived it): the client just sees the connection close.
                let Ok(upstream) = UnixStream::connect(&socket) else {
                    return;
                };
                let (Ok(client_read), Ok(upstream_read)) =
                    (client.try_clone(), upstream.try_clone())
                else {
                    return;
                };
                let upstream_write = upstream;
                let client_write: TcpStream = client;
                let to_proxy = thread::spawn(move || {
                    let half = upstream_write.try_clone();
                    pump(client_read, upstream_write, move || {
                        if let Ok(half) = half {
                            let _ = half.shutdown(Shutdown::Write);
                        }
                    })
                });
                let half = client_write.try_clone();
                pump(upstream_read, client_write, move || {
                    if let Ok(half) = half {
                        let _ = half.shutdown(Shutdown::Write);
                    }
                });
                let _ = to_proxy.join();
            });
        }
    });

    match Command::new(program).args(&args[4..]).status() {
        Ok(status) => exit(
            status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)),
        ),
        Err(error) => {
            eprintln!("Patch sandbox: cannot run {program}: {error}");
            exit(127);
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("net-bridge runs only on Linux");
    std::process::exit(2);
}
