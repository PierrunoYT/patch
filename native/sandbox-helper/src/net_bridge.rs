// Runs inside a sandboxed command's own network namespace when Patch filters its network (#97). The namespace has
// only loopback: this listens on 127.0.0.1:<port>, forwards every connection to <socket> (Patch's filtering proxy,
// mounted into the sandbox), then runs <program> with its arguments and exits with its status.
//
// On Windows it runs inside the command's AppContainer, which has no network capability: loopback between processes
// of the same AppContainer is the only route Patch provides (Windows does not isolate loopback from other local services). <port> 0 picks a free port, since loopback is shared with
// the whole machine there, and the proxy variables are set here to it. <socket> is the named pipe sandbox-helper
// relays to Patch's proxy; only this AppContainer may open it.
//
// usage: net-bridge <port> <socket> -- <program> [args...]

// The bridge uses the client side only.
#[cfg(windows)]
#[allow(dead_code)]
#[path = "pipe_io.rs"]
mod pipe_io;

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

#[cfg(windows)]
fn main() {
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::process::{exit, Command};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(port), Some(pipe), Some("--")) = (
        args.first().and_then(|port| port.parse::<u16>().ok()),
        args.get(1).cloned(),
        args.get(2).map(String::as_str),
    ) else {
        eprintln!("usage: net-bridge <port> <pipe> -- <program> [args...]");
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
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(error) => {
            eprintln!("Patch sandbox: cannot start the network proxy bridge: {error}");
            exit(126);
        }
    };

    // Named pipes cannot half-close, so a client that ends its request keeps the pipe open for the answer; the
    // answer's end closes everything.
    fn forward(client: TcpStream, pipe: &str) {
        // The relay may be gone (the command outlived it): the client just sees the connection close.
        let Ok(upstream) = pipe_io::connect(pipe, Duration::from_secs(5)) else {
            return;
        };
        let (Ok(stop), Ok(mut client_read)) = (pipe_io::Event::new(), client.try_clone()) else {
            return;
        };
        let (upstream, stop) = (Arc::new(upstream), Arc::new(stop));
        {
            let (upstream, stop) = (upstream.clone(), stop.clone());
            thread::spawn(move || {
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    match client_read.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) if upstream.write_all(&buffer[..count], &stop).is_ok() => {}
                        _ => {
                            stop.set();
                            break;
                        }
                    }
                }
            });
        }
        let mut client_write = client;
        let mut buffer = vec![0u8; 64 * 1024];
        while let Ok(count) = upstream.read(&mut buffer, &stop) {
            if count == 0 || client_write.write_all(&buffer[..count]).is_err() {
                break;
            }
        }
        let _ = client_write.shutdown(Shutdown::Write);
        stop.set();
    }

    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let pipe = pipe.clone();
            thread::spawn(move || forward(client, &pipe));
        }
    });

    let proxy = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(program);
    command.args(&args[4..]);
    // Programs that honor proxy variables (curl, git, npm, pip, Node with NODE_USE_ENV_PROXY) use the bridge;
    // anything else has no route and no resolver.
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        command.env(name, &proxy);
    }
    command.env("NO_PROXY", "").env("NODE_USE_ENV_PROXY", "1");
    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Patch sandbox: cannot run {program}: {error}");
            exit(127);
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn main() {
    eprintln!("net-bridge runs only on Linux and Windows");
    std::process::exit(2);
}
