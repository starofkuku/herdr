use super::App;

impl App {
    pub(super) fn update_config_file<F>(&mut self, error_context: &str, update: F) -> bool
    where
        F: FnOnce(&str) -> String,
    {
        #[cfg(test)]
        if std::env::var_os(crate::config::CONFIG_PATH_ENV_VAR).is_none() {
            return false;
        }

        let path = crate::config::config_path();
        if let Some(parent) = path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                crate::logging::config_write_failed(&path, error_context, &err.to_string());
                self.state.config_diagnostic =
                    Some(format!("failed to save {error_context}: {err}"));
                self.config_diagnostic_deadline =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                return false;
            }
        }

        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let new_content = update(&content);
        if let Err(err) = std::fs::write(&path, new_content) {
            crate::logging::config_write_failed(&path, error_context, &err.to_string());
            self.state.config_diagnostic = Some(format!("failed to save {error_context}: {err}"));
            self.config_diagnostic_deadline =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
            return false;
        }

        true
    }

    pub(super) fn mark_onboarding_complete(&mut self) {
        self.update_config_file("onboarding setting", |content| {
            crate::config::upsert_top_level_bool(content, "onboarding", false)
        });
    }

    pub(super) fn save_theme(&mut self, name: &str) {
        if self.update_config_file("theme", |content| {
            let content = crate::config::upsert_section_value(
                content,
                "theme",
                "name",
                &format!("\"{name}\""),
            );
            crate::config::upsert_section_bool(&content, "theme", "auto_switch", false)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_sound(&mut self, enabled: bool) {
        if self.update_config_file("sound setting", |content| {
            crate::config::upsert_section_bool(content, "ui.sound", "enabled", enabled)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_bell(&mut self, enabled: bool) {
        if self.update_config_file("bell setting", |content| {
            crate::config::upsert_section_bool(content, "ui.bell", "enabled", enabled)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_toast_delivery(&mut self, delivery: crate::config::ToastDelivery) {
        let value = match delivery {
            crate::config::ToastDelivery::Off => "\"off\"",
            crate::config::ToastDelivery::Herdr => "\"herdr\"",
            crate::config::ToastDelivery::Terminal => "\"terminal\"",
            crate::config::ToastDelivery::System => "\"system\"",
        };
        if self.update_config_file("toast setting", |content| {
            let content =
                crate::config::upsert_section_value(content, "ui.toast", "delivery", value);
            crate::config::remove_section_key(&content, "ui.toast", "enabled")
        }) {
            self.apply_config_from_disk(false);
        }
    }

    /// Writes the notification settings a client is allowed to edit.
    ///
    /// Only the two groups named here are touched. Everything else in the file is
    /// left byte for byte as it was, which is what lets this share a config file
    /// with a hand-edit: `update_config_file` reads the file and rewrites the
    /// lines it changes rather than re-serializing the document, so comments and
    /// ordering survive.
    pub(super) fn save_notification_settings(
        &mut self,
        params: crate::api::schema::ConfigNotificationSetParams,
    ) -> bool {
        self.update_config_file("notification settings", move |content| {
            let mut content = content.to_owned();

            if let Some(delivery) = params.toast_delivery {
                // Rejected rather than written: an unknown mode would be saved and
                // then reported as a config error on the next read, which is a
                // worse way to learn about a typo.
                let value = match delivery.as_str() {
                    "off" => "off",
                    "herdr" => "herdr",
                    "terminal" => "terminal",
                    "system" => "system",
                    _ => return content,
                };
                // Quoted, like every other string written here. `upsert_section_value`
                // takes the value verbatim: an enum name written bare is not valid
                // TOML, and one bad line makes the whole file unparseable, which
                // drops every setting in it rather than only this one.
                content = crate::config::upsert_section_value(
                    &content,
                    "ui.toast",
                    "delivery",
                    &toml_string(value),
                );
            }
            if let Some(delay) = params.toast_delay_seconds {
                content = crate::config::upsert_section_value(
                    &content,
                    "ui.toast",
                    "delay_seconds",
                    &delay.to_string(),
                );
            }
            if let Some(enabled) = params.bell_enabled {
                content =
                    crate::config::upsert_section_bool(&content, "ui.bell", "enabled", enabled);
            }
            if let Some(enabled) = params.sound_enabled {
                content =
                    crate::config::upsert_section_bool(&content, "ui.sound", "enabled", enabled);
            }

            if let Some(enabled) = params.feishu_enabled {
                content = crate::config::upsert_section_bool(
                    &content,
                    "notification.feishu",
                    "enabled",
                    enabled,
                );
            }
            if let Some(url) = params.feishu_url {
                content = crate::config::upsert_section_value(
                    &content,
                    "notification.feishu",
                    "url",
                    &toml_string(&url),
                );
            }
            // An absent secret means "leave the stored one alone", which is how the
            // page can show an empty field while a key is in fact configured. An
            // empty string is a deliberate clear.
            if let Some(secret) = params.feishu_secret {
                content = crate::config::upsert_section_value(
                    &content,
                    "notification.feishu",
                    "secret",
                    &toml_string(&secret),
                );
            }
            if let Some(delay) = params.feishu_delay_seconds {
                content = crate::config::upsert_section_value(
                    &content,
                    "notification.feishu",
                    "delay_seconds",
                    &delay.to_string(),
                );
            }

            content
        })
    }

    pub(super) fn save_agent_border_labels(&mut self, enabled: bool) {
        if self.update_config_file("agent border labels", |content| {
            crate::config::upsert_section_bool(
                content,
                "ui",
                "show_agent_labels_on_pane_borders",
                enabled,
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_pane_history_persistence(&mut self, enabled: bool) {
        if self.update_config_file("pane screen history", |content| {
            crate::config::upsert_section_bool(content, "experimental", "pane_history", enabled)
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_switch_ascii_input_source_in_prefix(&mut self, enabled: bool) {
        if self.update_config_file("prefix ascii input source", |content| {
            crate::config::upsert_section_bool(
                content,
                "experimental",
                "switch_ascii_input_source_in_prefix",
                enabled,
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }

    pub(super) fn save_agent_panel_sort(&mut self, sort: crate::app::state::AgentPanelSort) {
        let value = match sort {
            crate::app::state::AgentPanelSort::Spaces => {
                crate::config::AgentPanelSortConfig::Spaces.as_str()
            }
            crate::app::state::AgentPanelSort::Priority => {
                crate::config::AgentPanelSortConfig::Priority.as_str()
            }
        };
        if self.update_config_file("agent panel sort", |content| {
            crate::config::upsert_section_value(
                content,
                "ui",
                "agent_panel_sort",
                &format!("\"{value}\""),
            )
        }) {
            self.apply_config_from_disk(false);
        }
    }
}

/// A value as the TOML basic string that will read back as itself.
///
/// The config writer edits lines rather than re-serializing, so it takes the
/// value verbatim: a URL's `:` and a signing key's `-` and `_` are fine bare, but
/// a value with a space, a quote, or a `#` would either not parse or be silently
/// truncated at the comment. Quoting every string keeps that from depending on
/// what the reader happened to paste.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}
