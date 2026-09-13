//! `herdr web` — runs the web gateway.
//!
//! The gateway is a standalone process rather than a feature of a session
//! server. A session server only knows its own session, so only a process
//! outside them can list every session and let the user choose one.

use std::io;

/// Entry point for `herdr web`. Returns `None` when this is not a web
/// invocation so the caller can continue with other subcommands.
pub(crate) fn run_web_command(args: &[String]) -> io::Result<Option<i32>> {
    match args.first().map(String::as_str) {
        None => run(),
        Some("help" | "--help" | "-h") => {
            print_web_help();
            Ok(Some(0))
        }
        Some(other) => {
            eprintln!("unknown web option: {other}");
            print_web_help();
            Ok(Some(2))
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
    println!("usage: herdr web");
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
