use crate::api::schema::{IntegrationInstallResult, IntegrationUninstallResult, ResponseResult};
use crate::app::App;

use super::responses::{encode_error, encode_success};

impl App {
    pub(super) fn handle_integration_install(
        &mut self,
        id: String,
        params: crate::api::schema::IntegrationInstallParams,
    ) -> String {
        let target = params.target;
        let mut messages = match crate::integration::install_target(target) {
            Ok(messages) => messages,
            Err(err) => return encode_error(id, "integration_install_failed", err.to_string()),
        };
        if target == crate::api::schema::IntegrationTarget::Codex
            && crate::integration::codex_monitor_supported()
        {
            match self.register_codex_monitor_plugin() {
                Ok(message) => messages.push(message),
                Err(err) => {
                    return encode_error(id, "integration_plugin_install_failed", err.to_string());
                }
            }
        }

        encode_success(
            id,
            ResponseResult::IntegrationInstall {
                target,
                details: IntegrationInstallResult { messages },
            },
        )
    }

    pub(super) fn handle_integration_uninstall(
        &mut self,
        id: String,
        params: crate::api::schema::IntegrationUninstallParams,
    ) -> String {
        let target = params.target;
        let removed_plugin = if target == crate::api::schema::IntegrationTarget::Codex {
            match self.unregister_codex_monitor_plugin() {
                Ok(plugin) => plugin,
                Err(err) => {
                    return encode_error(
                        id,
                        "integration_plugin_uninstall_failed",
                        err.to_string(),
                    );
                }
            }
        } else {
            None
        };
        let messages = match crate::integration::uninstall_target(target) {
            Ok(messages) => messages,
            Err(err) => {
                if let Some(plugin) = removed_plugin {
                    self.state
                        .installed_plugins
                        .insert(plugin.plugin_id.clone(), plugin);
                    let _ = self.save_plugin_registry();
                    self.reconcile_plugin_services_now();
                }
                return encode_error(id, "integration_uninstall_failed", err.to_string());
            }
        };

        encode_success(
            id,
            ResponseResult::IntegrationUninstall {
                target,
                details: IntegrationUninstallResult { messages },
            },
        )
    }

    pub(crate) fn register_codex_monitor_plugin(&mut self) -> std::io::Result<String> {
        let root = crate::integration::codex_monitor_plugin_root();
        let enabled = self
            .state
            .installed_plugins
            .get(crate::integration::CODEX_MONITOR_PLUGIN_ID)
            .map(|plugin| plugin.enabled)
            .unwrap_or(true);
        let plugin = crate::app::load_plugin_manifest(&root.display().to_string(), enabled)
            .map_err(|(_, message)| std::io::Error::other(message))?;
        let previous = self
            .state
            .installed_plugins
            .insert(plugin.plugin_id.clone(), plugin.clone());
        if let Err(err) = self.save_plugin_registry() {
            match previous {
                Some(previous) => {
                    self.state
                        .installed_plugins
                        .insert(previous.plugin_id.clone(), previous);
                }
                None => {
                    self.state.installed_plugins.remove(&plugin.plugin_id);
                }
            }
            return Err(err);
        }
        self.reconcile_plugin_services_now();
        Ok(format!(
            "enabled codex rollout monitor service {}",
            plugin.plugin_id
        ))
    }

    fn unregister_codex_monitor_plugin(
        &mut self,
    ) -> std::io::Result<Option<crate::api::schema::InstalledPluginInfo>> {
        let removed = self
            .state
            .installed_plugins
            .remove(crate::integration::CODEX_MONITOR_PLUGIN_ID);
        if let Err(err) = self.save_plugin_registry() {
            if let Some(plugin) = removed.clone() {
                self.state
                    .installed_plugins
                    .insert(plugin.plugin_id.clone(), plugin);
            }
            return Err(err);
        }
        self.reconcile_plugin_services_now();
        Ok(removed)
    }
}
