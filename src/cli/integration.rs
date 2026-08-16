use crate::api::schema::{
    IntegrationInstallParams, IntegrationTarget, IntegrationUninstallParams, Method, Request,
    ResponseResult, SuccessResponse,
};

pub(super) fn run_integration_command(args: &[String]) -> std::io::Result<i32> {
    let Some(subcommand) = args.first().map(|arg| arg.as_str()) else {
        print_integration_help();
        return Ok(2);
    };

    match subcommand {
        "install" => integration_install(&args[1..]),
        "uninstall" => integration_uninstall(&args[1..]),
        "status" => integration_status(&args[1..]),
        "help" | "--help" | "-h" => {
            print_integration_help();
            Ok(0)
        }
        _ => {
            print_integration_help();
            Ok(2)
        }
    }
}

fn integration_status(args: &[String]) -> std::io::Result<i32> {
    let outdated_only = match args {
        [] => false,
        [flag] if flag == "--outdated-only" => true,
        _ => {
            eprintln!("usage: herdr integration status [--outdated-only]");
            return Ok(2);
        }
    };

    if outdated_only {
        crate::integration::print_outdated_update_notice();
        return Ok(0);
    }

    for status in crate::integration::installed_integration_statuses() {
        let target = crate::integration::integration_target_label(status.target);
        let version = match status.installed_version {
            Some(version) => format!("v{version}"),
            None => "legacy".to_string(),
        };
        let state = match status.state {
            crate::integration::IntegrationStatusKind::NotInstalled => "not installed".to_string(),
            crate::integration::IntegrationStatusKind::Current => {
                format!("current ({version})")
            }
            crate::integration::IntegrationStatusKind::Outdated => {
                format!("outdated ({version} < v{})", status.expected_version)
            }
        };
        println!("{target}: {state} ({})", status.path.display());
    }

    Ok(0)
}

fn integration_install(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = parse_integration_target(args, "install")? else {
        return Ok(2);
    };

    if let Some(code) = request_integration(target, true)? {
        return Ok(code);
    }

    match crate::integration::install_target(target) {
        Ok(mut messages) => {
            if target == IntegrationTarget::Codex && crate::integration::codex_monitor_supported() {
                persist_codex_monitor_plugin()?;
                messages.push(format!(
                    "enabled codex rollout monitor service {}",
                    crate::integration::CODEX_MONITOR_PLUGIN_ID
                ));
            }
            print_integration_messages(messages);
            Ok(0)
        }
        Err(err) => {
            eprintln!("{err}");
            Ok(1)
        }
    }
}

fn integration_uninstall(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = parse_integration_target(args, "uninstall")? else {
        return Ok(2);
    };

    if let Some(code) = request_integration(target, false)? {
        return Ok(code);
    }

    match crate::integration::uninstall_target(target) {
        Ok(mut messages) => {
            if target == IntegrationTarget::Codex && remove_codex_monitor_plugin_from_registry()? {
                messages.push(format!(
                    "disabled codex rollout monitor service {}",
                    crate::integration::CODEX_MONITOR_PLUGIN_ID
                ));
            }
            print_integration_messages(messages);
            Ok(0)
        }
        Err(err) => {
            eprintln!("{err}");
            Ok(1)
        }
    }
}

fn request_integration(target: IntegrationTarget, install: bool) -> std::io::Result<Option<i32>> {
    let method = if install {
        Method::IntegrationInstall(IntegrationInstallParams { target })
    } else {
        Method::IntegrationUninstall(IntegrationUninstallParams { target })
    };
    let response = match super::send_request(&Request {
        id: "cli:integration".into(),
        method,
    }) {
        Ok(response) => response,
        Err(err) if is_connection_error(&err) => return Ok(None),
        Err(err) => return Err(err),
    };
    if response.get("error").is_some() {
        eprintln!("{}", serde_json::to_string(&response).unwrap());
        return Ok(Some(1));
    }
    let success: SuccessResponse =
        serde_json::from_value(response).map_err(std::io::Error::other)?;
    let messages = match success.result {
        ResponseResult::IntegrationInstall { details, .. } => details.messages,
        ResponseResult::IntegrationUninstall { details, .. } => details.messages,
        _ => return Err(std::io::Error::other("unexpected integration API response")),
    };
    print_integration_messages(messages);
    Ok(Some(0))
}

fn persist_codex_monitor_plugin() -> std::io::Result<()> {
    let root = crate::integration::codex_monitor_plugin_root();
    let mut plugins = crate::persist::plugin_registry::load();
    let enabled = plugins
        .iter()
        .find(|plugin| plugin.plugin_id == crate::integration::CODEX_MONITOR_PLUGIN_ID)
        .map(|plugin| plugin.enabled)
        .unwrap_or(true);
    let plugin = crate::app::load_plugin_manifest(&root.display().to_string(), enabled)
        .map_err(|(_, message)| std::io::Error::other(message))?;
    crate::plugin_paths::ensure_plugin_user_dirs(&plugin.plugin_id)?;
    plugins.retain(|entry| entry.plugin_id != plugin.plugin_id);
    plugins.push(plugin);
    crate::persist::plugin_registry::save(&plugins)
}

fn remove_codex_monitor_plugin_from_registry() -> std::io::Result<bool> {
    let mut plugins = crate::persist::plugin_registry::load();
    let previous_len = plugins.len();
    plugins.retain(|plugin| plugin.plugin_id != crate::integration::CODEX_MONITOR_PLUGIN_ID);
    if plugins.len() == previous_len {
        return Ok(false);
    }
    crate::persist::plugin_registry::save(&plugins)?;
    Ok(true)
}

fn is_connection_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::BrokenPipe
    )
}

fn print_integration_messages(messages: Vec<String>) {
    for message in messages {
        println!("{message}");
    }
}

fn parse_integration_target(
    args: &[String],
    action: &str,
) -> std::io::Result<Option<IntegrationTarget>> {
    let Some(target) = args.first().map(|arg| arg.as_str()) else {
        eprintln!(
            "usage: herdr integration {action} <pi|omp|claude|codex|copilot|devin|droid|kimi|opencode|kilo|hermes|qodercli|cursor|mastracode|grok>"
        );
        return Ok(None);
    };
    if args.len() != 1 {
        eprintln!(
            "usage: herdr integration {action} <pi|omp|claude|codex|copilot|devin|droid|kimi|opencode|kilo|hermes|qodercli|cursor|mastracode|grok>"
        );
        return Ok(None);
    }

    let parsed = match target {
        "pi" => IntegrationTarget::Pi,
        "omp" => IntegrationTarget::Omp,
        "claude" => IntegrationTarget::Claude,
        "codex" => IntegrationTarget::Codex,
        "copilot" => IntegrationTarget::Copilot,
        "devin" => IntegrationTarget::Devin,
        "droid" => IntegrationTarget::Droid,
        "kimi" => IntegrationTarget::Kimi,
        "opencode" => IntegrationTarget::Opencode,
        "kilo" => IntegrationTarget::Kilo,
        "hermes" => IntegrationTarget::Hermes,
        "qodercli" => IntegrationTarget::Qodercli,
        "cursor" => IntegrationTarget::Cursor,
        "mastracode" => IntegrationTarget::Mastracode,
        "grok" => IntegrationTarget::Grok,
        _ => {
            eprintln!("unknown integration target: {target}");
            eprintln!(
                "currently supported: pi, omp, claude, codex, copilot, devin, droid, kimi, opencode, kilo, hermes, qodercli, cursor, mastracode, grok"
            );
            return Ok(None);
        }
    };

    Ok(Some(parsed))
}

fn print_integration_help() {
    eprintln!("herdr integration commands:");
    eprintln!("  herdr integration install pi");
    eprintln!("  herdr integration install omp");
    eprintln!("  herdr integration install claude");
    eprintln!("  herdr integration install codex");
    eprintln!("  herdr integration install copilot");
    eprintln!("  herdr integration install devin");
    eprintln!("  herdr integration install droid");
    eprintln!("  herdr integration install kimi");
    eprintln!("  herdr integration install opencode");
    eprintln!("  herdr integration install kilo");
    eprintln!("  herdr integration install hermes");
    eprintln!("  herdr integration install qodercli");
    eprintln!("  herdr integration install cursor");
    eprintln!("  herdr integration install mastracode");
    eprintln!("  herdr integration install grok");
    eprintln!("  herdr integration uninstall pi");
    eprintln!("  herdr integration uninstall omp");
    eprintln!("  herdr integration uninstall claude");
    eprintln!("  herdr integration uninstall codex");
    eprintln!("  herdr integration uninstall copilot");
    eprintln!("  herdr integration uninstall devin");
    eprintln!("  herdr integration uninstall droid");
    eprintln!("  herdr integration uninstall kimi");
    eprintln!("  herdr integration uninstall opencode");
    eprintln!("  herdr integration uninstall kilo");
    eprintln!("  herdr integration uninstall hermes");
    eprintln!("  herdr integration uninstall qodercli");
    eprintln!("  herdr integration uninstall cursor");
    eprintln!("  herdr integration uninstall mastracode");
    eprintln!("  herdr integration uninstall grok");
    eprintln!("  herdr integration status [--outdated-only]");
}
