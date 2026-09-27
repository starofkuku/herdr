//! `herdr web` — runs the web gateway.
//!
//! The gateway is a standalone process rather than a feature of a session
//! server. A session server only knows its own session, so only a process
//! outside them can list every session and let the user choose one.

use std::io;

/// Set on the process `--detach` spawns, so it serves in the foreground instead
/// of detaching again.
///
/// A marker rather than a stripped argument: the child keeps the same argv as
/// the parent, which makes `ps` show what the user actually typed.
pub(crate) const WEB_DETACHED_ENV_VAR: &str = "HERDR_WEB_DETACHED";

/// Entry point for `herdr web`. Returns `None` when this is not a web
/// invocation so the caller can continue with other subcommands.
pub(crate) fn run_web_command(args: &[String]) -> io::Result<Option<i32>> {
    let mut detach = false;
    for arg in args {
        match arg.as_str() {
            "--detach" | "-d" => detach = true,
            "help" | "--help" | "-h" => {
                print_web_help();
                return Ok(Some(0));
            }
            other => {
                eprintln!("unknown web option: {other}");
                print_web_help();
                return Ok(Some(2));
            }
        }
    }

    if detach && !already_detached() {
        return detach_into_background();
    }

    run()
}

/// Whether this process is the one `--detach` started.
fn already_detached() -> bool {
    std::env::var_os(WEB_DETACHED_ENV_VAR).is_some()
}

/// Re-runs this command as a background process.
///
/// A gateway started with a shell's `&` is only backgrounded, not detached: it
/// stays in the terminal's session, so closing the pane, tab, or window that
/// started it sends SIGHUP and takes the gateway down with it. Detaching is what
/// makes it outlive the terminal it was started from.
///
/// The child carries the same argv, so `herdr web --detach` is what shows in
/// `ps`, and no terminal is inherited: its stdio goes to the log file when one
/// is configured, and to /dev/null otherwise.
fn detach_into_background() -> io::Result<Option<i32>> {
    let exe = std::env::current_exe()?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut command = std::process::Command::new(&exe);
    command.args(&args);
    command.env(WEB_DETACHED_ENV_VAR, "1");
    configure_detached_stdio(&mut command);
    crate::platform::detach_server_daemon_command(&mut command);

    let child = command
        .spawn()
        .map_err(|err| io::Error::new(err.kind(), format!("failed to start gateway: {err}")))?;

    // The port is bound by the child, and the caller has no other way to tell
    // whether it came up: reporting success before it listened would be a lie
    // the user only discovers in the browser.
    let pid = child.id();
    println!("herdr web started in the background (pid {pid})");
    println!("Stop it with: kill {pid}");
    Ok(Some(0))
}

/// Points a detached child's stdio somewhere that outlives the terminal.
fn configure_detached_stdio(command: &mut std::process::Command) {
    command.stdin(std::process::Stdio::null());
    match crate::web::detached_log_file() {
        Some(file) => match file.try_clone() {
            Ok(handle) => {
                command.stdout(std::process::Stdio::from(handle));
                match file.try_clone() {
                    Ok(handle) => command.stderr(std::process::Stdio::from(handle)),
                    Err(_) => command.stderr(std::process::Stdio::null()),
                };
            }
            Err(_) => {
                command.stdout(std::process::Stdio::null());
                command.stderr(std::process::Stdio::null());
            }
        },
        None => {
            command.stdout(std::process::Stdio::null());
            command.stderr(std::process::Stdio::null());
        }
    }
}

fn run() -> io::Result<Option<i32>> {
    let config = crate::config::Config::load().config;

    let options = match crate::web::options_from_config(&config) {
        Ok(options) => options,
        Err(err) => {
            // Fail closed: without a key the gateway must not listen, otherwise
            // it would expose shell access to anyone who can reach the port.
            eprintln!("error: {err}");
            eprintln!();
            eprintln!("The web gateway is disabled until a key is configured.");
            eprintln!();
            eprintln!("Recommended: put it in config.toml so it survives restarts.");
            eprintln!("  key=$(head -c 32 /dev/urandom | base64)   # generate one",);
            eprintln!("  add to ~/.config/herdr/config.toml:");
            eprintln!();
            eprintln!("    [web]");
            eprintln!("    key = \"$key\"");
            eprintln!();
            eprintln!("  then: chmod 600 ~/.config/herdr/config.toml");
            eprintln!();
            eprintln!(
                "Or set {} for a single run.",
                crate::web::auth::WEB_KEY_ENV_VAR
            );
            return Ok(Some(1));
        }
    };

    crate::web::run(options)?;
    Ok(Some(0))
}

fn print_web_help() {
    println!("herdr web - serve the browser UI for Herdr sessions");
    println!();
    println!("usage: herdr web [--detach]");
    println!();
    println!("  --detach, -d   run in the background, detached from this terminal");
    println!("                 (a shell `&` is not enough: the gateway stays in the");
    println!("                 terminal's session and dies when the pane closes)");
    println!();
    println!("The gateway is disabled unless a key is configured.");
    println!("Key sources, in order of precedence:");
    println!("  [web] key in config.toml   survives restarts; requires `chmod 600`");
    println!("  {}   gateway key", crate::web::auth::WEB_KEY_ENV_VAR);
    println!(
        "  {}  file containing the gateway key",
        crate::web::auth::WEB_KEY_FILE_ENV_VAR
    );
    println!();
    println!("Configuration ([web] in config.toml):");
    println!("  bind            address to listen on (default 127.0.0.1)");
    println!("  port            TCP port (default 8787)");
    println!("  static_dir      directory containing the built web UI");
    println!("  key             gateway key (keep this file chmod 600)");
    println!("  allowed_origins optional Origin allowlist; empty disables the check");
}
