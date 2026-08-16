use std::collections::{HashMap, HashSet};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use crate::api::schema::{InstalledPluginInfo, PluginManifestService, PluginServiceRestart};

use super::manifest::{effective_platforms, ensure_platform_supported};

const SERVICE_RECONCILE_INTERVAL: Duration = Duration::from_secs(1);
const SERVICE_RESTART_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const SERVICE_RESTART_MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PluginServiceKey {
    plugin_id: String,
    service_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PluginServiceSpec {
    plugin_id: String,
    service: PluginManifestService,
    plugin_root: String,
}

struct PluginServiceRuntime {
    spec: PluginServiceSpec,
    child: Option<Child>,
    next_restart: Option<Instant>,
    restart_backoff: Duration,
}

pub(crate) struct PluginServiceManager {
    runtimes: HashMap<PluginServiceKey, PluginServiceRuntime>,
    active: bool,
    next_reconcile: Option<Instant>,
}

impl PluginServiceManager {
    pub(crate) fn new(active: bool) -> Self {
        Self {
            runtimes: HashMap::new(),
            active,
            next_reconcile: active.then_some(Instant::now()),
        }
    }

    pub(crate) fn reconcile(
        &mut self,
        plugins: &HashMap<String, InstalledPluginInfo>,
        now: Instant,
    ) {
        if !self.active {
            return;
        }
        if self.next_reconcile.is_some_and(|deadline| now < deadline) {
            return;
        }
        self.next_reconcile = Some(now + SERVICE_RECONCILE_INTERVAL);

        let desired = desired_services(plugins);
        let desired_keys = desired.keys().cloned().collect::<HashSet<_>>();
        let removed = self
            .runtimes
            .keys()
            .filter(|key| !desired_keys.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        for key in removed {
            if let Some(mut runtime) = self.runtimes.remove(&key) {
                stop_service_child(&mut runtime.child);
            }
        }

        for (key, spec) in desired {
            let replace = self
                .runtimes
                .get(&key)
                .is_some_and(|runtime| runtime.spec != spec);
            if replace {
                if let Some(mut runtime) = self.runtimes.remove(&key) {
                    stop_service_child(&mut runtime.child);
                }
            }
            let runtime = self
                .runtimes
                .entry(key)
                .or_insert_with(|| PluginServiceRuntime {
                    spec,
                    child: None,
                    next_restart: Some(now),
                    restart_backoff: SERVICE_RESTART_INITIAL_BACKOFF,
                });
            poll_service(runtime, now);
        }
    }

    pub(crate) fn reconcile_now(&mut self, plugins: &HashMap<String, InstalledPluginInfo>) {
        self.next_reconcile = Some(Instant::now());
        self.reconcile(plugins, Instant::now());
    }

    pub(crate) fn suspend(&mut self) {
        self.active = false;
        self.next_reconcile = None;
        for runtime in self.runtimes.values_mut() {
            stop_service_child(&mut runtime.child);
        }
        self.runtimes.clear();
    }

    #[cfg(unix)]
    pub(crate) fn resume(&mut self) {
        self.active = true;
        self.next_reconcile = Some(Instant::now());
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.active.then_some(self.next_reconcile).flatten()
    }

    #[cfg(test)]
    pub(crate) fn running_count(&self) -> usize {
        self.runtimes
            .values()
            .filter(|runtime| runtime.child.is_some())
            .count()
    }
}

impl Drop for PluginServiceManager {
    fn drop(&mut self) {
        for runtime in self.runtimes.values_mut() {
            stop_service_child(&mut runtime.child);
        }
    }
}

fn desired_services(
    plugins: &HashMap<String, InstalledPluginInfo>,
) -> HashMap<PluginServiceKey, PluginServiceSpec> {
    let mut desired = HashMap::new();
    for plugin in plugins
        .values()
        .filter(|plugin| plugin.enabled && super::plugin_manifest_available(plugin))
    {
        for service in &plugin.services {
            if ensure_platform_supported(
                effective_platforms(&service.platforms, &plugin.platforms),
                &format!("service '{}.{}'", plugin.plugin_id, service.id),
            )
            .is_err()
            {
                continue;
            }
            let key = PluginServiceKey {
                plugin_id: plugin.plugin_id.clone(),
                service_id: service.id.clone(),
            };
            desired.insert(
                key,
                PluginServiceSpec {
                    plugin_id: plugin.plugin_id.clone(),
                    service: service.clone(),
                    plugin_root: plugin.plugin_root.clone(),
                },
            );
        }
    }
    desired
}

fn poll_service(runtime: &mut PluginServiceRuntime, now: Instant) {
    if let Some(child) = runtime.child.as_mut() {
        match child.try_wait() {
            Ok(None) => return,
            Ok(Some(status)) => {
                tracing::warn!(
                    plugin = %runtime.spec.plugin_id,
                    service = %runtime.spec.service.id,
                    ?status,
                    "plugin service exited"
                );
                runtime.child = None;
            }
            Err(err) => {
                tracing::warn!(
                    plugin = %runtime.spec.plugin_id,
                    service = %runtime.spec.service.id,
                    err = %err,
                    "failed to poll plugin service"
                );
                stop_service_child(&mut runtime.child);
            }
        }
        if runtime.spec.service.restart == PluginServiceRestart::Never {
            runtime.next_restart = None;
            return;
        }
        runtime.next_restart = Some(now + runtime.restart_backoff);
        runtime.restart_backoff = (runtime.restart_backoff * 2).min(SERVICE_RESTART_MAX_BACKOFF);
        return;
    }

    if runtime.next_restart.is_none_or(|deadline| now < deadline) {
        return;
    }
    match spawn_service(&runtime.spec) {
        Ok(child) => {
            tracing::info!(
                plugin = %runtime.spec.plugin_id,
                service = %runtime.spec.service.id,
                pid = child.id(),
                "started plugin service"
            );
            runtime.child = Some(child);
            runtime.next_restart = None;
            runtime.restart_backoff = SERVICE_RESTART_INITIAL_BACKOFF;
        }
        Err(err) => {
            tracing::warn!(
                plugin = %runtime.spec.plugin_id,
                service = %runtime.spec.service.id,
                err = %err,
                "failed to start plugin service"
            );
            if runtime.spec.service.restart == PluginServiceRestart::Always {
                runtime.next_restart = Some(now + runtime.restart_backoff);
                runtime.restart_backoff =
                    (runtime.restart_backoff * 2).min(SERVICE_RESTART_MAX_BACKOFF);
            } else {
                runtime.next_restart = None;
            }
        }
    }
}

fn spawn_service(spec: &PluginServiceSpec) -> std::io::Result<Child> {
    let Some(program) = spec.service.command.first() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "plugin service command is empty",
        ));
    };
    let args = spec
        .service
        .command
        .iter()
        .skip(1)
        .cloned()
        .collect::<Vec<_>>();
    let mut env = super::env::plugin_path_env_for(&spec.plugin_id, &spec.plugin_root);
    env.extend([
        (
            crate::api::SOCKET_PATH_ENV_VAR.to_string(),
            crate::api::socket_path().display().to_string(),
        ),
        ("HERDR_ENV".to_string(), "1".to_string()),
        ("HERDR_PLUGIN_ID".to_string(), spec.plugin_id.clone()),
        (
            "HERDR_PLUGIN_SERVICE_ID".to_string(),
            spec.service.id.clone(),
        ),
    ]);
    if let Ok(current_exe) = std::env::current_exe() {
        env.push((
            "HERDR_BIN_PATH".to_string(),
            current_exe.display().to_string(),
        ));
    }
    crate::plugin_command::command_for_argv(program, &args)
        .current_dir(&spec.plugin_root)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn stop_service_child(child: &mut Option<Child>) {
    let Some(mut child) = child.take() else {
        return;
    };
    if child.try_wait().ok().flatten().is_none() {
        if let Err(err) = child.kill() {
            tracing::warn!(pid = child.id(), err = %err, "failed to stop plugin service");
        }
    }
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn plugin(command: Vec<String>, restart: PluginServiceRestart) -> InstalledPluginInfo {
        InstalledPluginInfo {
            plugin_id: "test.service".into(),
            name: "Test service".into(),
            version: "0.1.0".into(),
            min_herdr_version: crate::build_info::BASE_VERSION.into(),
            description: None,
            manifest_path: "/tmp/test-service/herdr-plugin.toml".into(),
            plugin_root: "/tmp".into(),
            enabled: true,
            platforms: None,
            build: Vec::new(),
            actions: Vec::new(),
            events: Vec::new(),
            panes: Vec::new(),
            services: vec![PluginManifestService {
                id: "monitor".into(),
                platforms: None,
                restart,
                command,
            }],
            link_handlers: Vec::new(),
            source: Default::default(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn service_starts_once_and_stops_when_plugin_disappears() {
        let mut manager = PluginServiceManager::new(true);
        let now = Instant::now();
        let plugins = HashMap::from([(
            "test.service".into(),
            plugin(
                vec!["sh".into(), "-c".into(), "sleep 30".into()],
                PluginServiceRestart::Always,
            ),
        )]);

        manager.reconcile(&plugins, now);
        assert_eq!(manager.running_count(), 1);
        manager.reconcile(&plugins, now + SERVICE_RECONCILE_INTERVAL);
        assert_eq!(manager.running_count(), 1);
        manager.reconcile(&HashMap::new(), now + SERVICE_RECONCILE_INTERVAL * 2);
        assert_eq!(manager.running_count(), 0);
    }

    #[test]
    fn exited_service_waits_for_restart_backoff() {
        let mut manager = PluginServiceManager::new(true);
        let now = Instant::now();
        let plugins = HashMap::from([(
            "test.service".into(),
            plugin(
                vec!["sh".into(), "-c".into(), "exit 0".into()],
                PluginServiceRestart::Always,
            ),
        )]);
        manager.reconcile(&plugins, now);
        std::thread::sleep(Duration::from_millis(20));
        manager.reconcile(&plugins, now + SERVICE_RECONCILE_INTERVAL);
        assert_eq!(manager.running_count(), 0);
        manager.reconcile(
            &plugins,
            now + SERVICE_RECONCILE_INTERVAL + Duration::from_millis(500),
        );
        assert_eq!(manager.running_count(), 0);
        manager.reconcile(&plugins, now + SERVICE_RECONCILE_INTERVAL * 2);
        assert_eq!(manager.running_count(), 1);
    }

    #[test]
    fn suspend_stops_services_and_resume_starts_them_again() {
        let mut manager = PluginServiceManager::new(true);
        let plugins = HashMap::from([(
            "test.service".into(),
            plugin(
                vec!["sh".into(), "-c".into(), "sleep 30".into()],
                PluginServiceRestart::Always,
            ),
        )]);

        manager.reconcile(&plugins, Instant::now());
        assert_eq!(manager.running_count(), 1);

        manager.suspend();
        assert_eq!(manager.running_count(), 0);
        assert_eq!(manager.next_deadline(), None);

        manager.resume();
        manager.reconcile(&plugins, Instant::now() + Duration::from_millis(1));
        assert_eq!(manager.running_count(), 1);
    }
}
