//! The dev servers listening on this machine, for the browser panel to offer.
//!
//! `lsof` names every listening socket and the process behind it. A listening port is not
//! necessarily a web page, so each one is fetched before it is offered: a database, an ssh
//! daemon, and the app's own pty host all listen, and none of them belongs in the list.
use std::process::Command;
use std::time::Duration;

const LSOF_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// Probes in flight at once. A machine can hold dozens of listeners and each probe is a thread.
const PROBES_AT_ONCE: usize = 16;

/// What lsof calls an address bound on every interface or on loopback.
const LOOPBACK: [&str; 5] = ["*", "127.0.0.1", "[::1]", "localhost", "[::]"];

/// Probed when lsof is missing or refuses. Ports a dev server usually takes.
const COMMON_PORTS: [u16; 16] = [
    3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
];

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LocalServer {
    pub port: u16,
    pub url: String,
    /// The command holding the port, when lsof named one.
    pub process: Option<String>,
}

/// One listening port, before it is known to serve a page.
#[derive(Clone, Debug, PartialEq)]
struct Listening {
    port: u16,
    process: Option<String>,
}

/// `lsof -F` prints one field per line, tagged by its first character: p a pid, c the command,
/// n the address. A pid's fields precede the addresses it holds.
fn parse_lsof(raw: &str) -> Vec<Listening> {
    let mut found: Vec<Listening> = Vec::new();
    let mut process: Option<String> = None;
    for line in raw.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let value = &line[1..];
        match tag {
            'p' => process = None,
            'c' => process = Some(value.trim().to_string()).filter(|name| !name.is_empty()),
            'n' => {
                if let Some(port) = loopback_port(value) {
                    if !found.iter().any(|held| held.port == port) {
                        found.push(Listening {
                            port,
                            process: process.clone(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    found.sort_by_key(|one| one.port);
    found
}

/// The port in an lsof address, when the address is one this machine reaches as localhost.
/// Examples: `*:5173`, `127.0.0.1:5173`, `[::1]:5173 (LISTEN)`, `192.168.1.10:5173`.
fn loopback_port(name: &str) -> Option<u16> {
    let address = name.split_whitespace().next()?;
    let split = address.rfind(':')?;
    let host = &address[..split];
    if !LOOPBACK.contains(&host) {
        return None;
    }
    address[split + 1..].parse().ok()
}

fn listeners() -> Vec<Listening> {
    let Some(raw) = run_lsof() else {
        return COMMON_PORTS
            .iter()
            .map(|port| Listening {
                port: *port,
                process: None,
            })
            .collect();
    };
    parse_lsof(&raw)
}

#[cfg(unix)]
fn run_lsof() -> Option<String> {
    let mut child = Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + LSOF_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut said = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut said).ok()?;
    Some(said)
}

/// Windows names its listeners another way. Until that is written, the common ports stand in.
#[cfg(not(unix))]
fn run_lsof() -> Option<String> {
    None
}

/// The port as a server, when one of the ways to reach it answers with a page.
///
/// `localhost` first, because that is the url a dev server prints and the one a person expects to
/// see. It resolves to ::1 before 127.0.0.1 on macOS though, so a server listening only on IPv4 is
/// invisible under that name and has to be asked for by address.
fn probe(client: &reqwest::blocking::Client, one: Listening) -> Option<LocalServer> {
    for scheme in ["http", "https"] {
        for host in ["localhost", "127.0.0.1"] {
            let url = format!("{scheme}://{host}:{}", one.port);
            if serves_a_page(client, &url) {
                return Some(LocalServer {
                    port: one.port,
                    url,
                    process: one.process,
                });
            }
        }
    }
    None
}

/// Whether the port answers with a page. A redirect counts: a dev server often sends one first.
fn serves_a_page(client: &reqwest::blocking::Client, url: &str) -> bool {
    let Ok(reply) = client.get(url).send() else {
        return false;
    };
    let status = reply.status();
    if status.is_redirection() {
        return reply.headers().contains_key(reqwest::header::LOCATION);
    }
    if !status.is_success() || status.as_u16() == 204 || status.as_u16() == 205 {
        return false;
    }
    reply
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|kind| kind.to_str().ok())
        .map(|kind| {
            let kind = kind.split(';').next().unwrap_or("").trim().to_lowercase();
            kind == "text/html" || kind == "application/xhtml+xml"
        })
        .unwrap_or(false)
}

/// The listening ports that answer with a web page, soonest port first.
#[tauri::command]
pub async fn local_servers() -> Result<Vec<LocalServer>, String> {
    tauri::async_runtime::spawn_blocking(scan)
        .await
        .map_err(|cause| cause.to_string())
}

fn scan() -> Vec<LocalServer> {
    {
        let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(true)
            .build()
        else {
            return Vec::new();
        };
        let found = listeners();
        let mut serving = Vec::new();
        for batch in found.chunks(PROBES_AT_ONCE) {
            let probes: Vec<_> = batch
                .iter()
                .map(|one| {
                    let client = client.clone();
                    let one = one.clone();
                    std::thread::spawn(move || probe(&client, one))
                })
                .collect();
            for probe in probes {
                if let Ok(Some(server)) = probe.join() {
                    serving.push(server);
                }
            }
        }
        serving
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_listening_ports_and_who_holds_them() {
        let raw = "p123\ncnode\nn*:5173\nn127.0.0.1:24678\np456\ncpostgres\nn[::1]:5432\n";
        assert_eq!(
            parse_lsof(raw),
            vec![
                Listening {
                    port: 5173,
                    process: Some("node".into())
                },
                Listening {
                    port: 5432,
                    process: Some("postgres".into())
                },
                Listening {
                    port: 24678,
                    process: Some("node".into())
                },
            ]
        );
    }

    #[test]
    fn a_port_bound_to_another_machines_interface_is_not_local() {
        assert_eq!(parse_lsof("p1\ncnode\nn192.168.1.10:5173\n"), vec![]);
    }

    #[test]
    fn the_listen_marker_lsof_appends_does_not_hide_the_port() {
        assert_eq!(loopback_port("[::1]:8080 (LISTEN)"), Some(8080));
    }

    /// Answers one request with a page, then one with plain text, on two ports of its own.
    fn serve(body: &'static str, kind: &'static str) -> u16 {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = stream.flush();
            }
        });
        port
    }

    /// The whole scan against real listeners: lsof names them, and only the page is offered.
    #[test]
    fn a_page_is_offered_and_a_port_that_serves_something_else_is_not() {
        // Without lsof the scan falls back to a fixed list of ports, which these are not on.
        if run_lsof().is_none() {
            return;
        }
        let page = serve("<html></html>", "text/html");
        let other = serve("{}", "application/json");
        let found = scan();
        assert!(
            found.iter().any(|one| one.port == page),
            "the page on {page} was not offered: {found:?}"
        );
        assert!(
            !found.iter().any(|one| one.port == other),
            "the json on {other} was offered"
        );
    }

    #[test]
    fn one_port_held_twice_is_listed_once() {
        let raw = "p1\ncnode\nn*:3000\np2\ncother\nn127.0.0.1:3000\n";
        assert_eq!(parse_lsof(raw).len(), 1);
    }
}
