use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingOption {
    pub label: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingDefinition {
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub setting_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(rename = "enum", default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<PluginSettingOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default = "plugin_setting_scope")]
    pub scope: String,
}

fn plugin_setting_scope() -> String {
    "plugin".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    /// Where the plugin's contributions apply. Absent in registries written
    /// before scopes existed, and `default()` is global — which is what those
    /// installs already did.
    #[serde(default)]
    pub scope: ActivationScope,
    pub source: String,
    /// True while this application build ships the plugin from
    /// `resources/plugins` (ADR 0241).
    ///
    /// A bundled plugin cannot be uninstalled, but the user may install their
    /// own copy over it. The flag follows that copy, so the panel keeps
    /// offering the actions that stay valid for the plugin.
    #[serde(default)]
    pub bundled: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Distribution metadata recorded by an install from the plugin
    /// marketplace this application no longer has (ADR
    /// fork-removes-plugin-marketplace). Read so such an install keeps its
    /// provenance; nothing writes it any more. Update and withdrawal state
    /// (`autoUpdate`, `updateAvailable`, `yanked`) left in an older registry
    /// is not read and drops out on the next save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<PluginMarketplaceMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<PluginUiMeta>,
    /// `manifest.fs`, passed through verbatim: which files each mode may touch.
    /// The desktop host enforces it; the registry carries it so the Plugins
    /// page can show the user what they granted. Absent in records written
    /// before scopes existed, which the host reads as the legacy minimum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<PluginSettingDefinition>,
    /// `manifest.i18n`, held in memory only.
    ///
    /// Display metadata that the host resolves before a row leaves the
    /// process, so it is neither persisted in the registry nor sent over RPC:
    /// the renderer keeps reading finished strings (ADR 0160 §4). Every path
    /// that rebuilds a row from a manifest refills it.
    #[serde(default, skip_serializing)]
    pub i18n: Option<PluginI18nMap>,
}

/// One locale's display strings for a plugin (`manifest.i18n`).
///
/// Every field is optional so a partially translated block still falls back
/// per field instead of losing the author's own language.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDisplayI18n {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_notes: Option<String>,
}

/// Locale id → display strings. Plugins ship `en` plus `zh-CN`; other keys are
/// kept but never selected, so a manifest may carry more than the contract
/// requires without the host having to understand them.
pub type PluginI18nMap = std::collections::BTreeMap<String, PluginDisplayI18n>;

/// Which entry of a [`PluginI18nMap`] a shell locale reads.
///
/// Mirrors `resolvePluginLocalizedString` in `@pi-desktop/plugin-sdk`: every
/// Chinese shell locale reads `zh-CN`, everything else reads `en`. Plugins are
/// not required to translate themselves into every shipped shell locale, so
/// `zh-TW` deliberately reads English rather than half a `zh-CN` guess
/// (ADR 0182).
pub(crate) fn plugin_display_locale(locale: &str) -> &'static str {
    let lower = locale.trim().replace('_', "-").to_lowercase();
    let simplified_chinese = lower == "zh"
        || lower == "zh-cn"
        || lower.starts_with("zh-cn-")
        || lower == "zh-hans"
        || lower.starts_with("zh-hans-")
        || lower == "zh-sg"
        || lower.starts_with("zh-sg-");
    if simplified_chinese {
        "zh-CN"
    } else {
        "en"
    }
}

/// One localized field: the locale's entry, else English, else whichever block
/// is there. An empty string counts as missing — a half-filled translation
/// must not blank out a row that has a usable author-written name.
pub(crate) fn localized_field<'a>(
    map: Option<&'a PluginI18nMap>,
    locale: &str,
    pick: impl Fn(&'a PluginDisplayI18n) -> Option<&'a String>,
) -> Option<&'a String> {
    let map = map?;
    let mut order = vec![plugin_display_locale(locale)];
    for key in ["en", "zh-CN"] {
        if !order.contains(&key) {
            order.push(key);
        }
    }
    for key in order {
        if let Some(value) = map.get(key).and_then(&pick) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

impl PluginSummary {
    /// The row as the active locale should read it.
    ///
    /// Only display text moves: ids, versions, permissions and state are
    /// language-independent, and a plugin without an `i18n` block keeps the
    /// strings its author wrote.
    pub(crate) fn localized(&self, locale: &str) -> PluginSummary {
        let mut out = self.clone();
        if let Some(name) = localized_field(self.i18n.as_ref(), locale, |entry| entry.name.as_ref())
        {
            out.name = name.clone();
        }
        if let Some(description) = localized_field(self.i18n.as_ref(), locale, |entry| {
            entry.description.as_ref()
        }) {
            out.description = Some(description.clone());
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceMeta {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shasum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher_id: Option<String>,
    /// Trust tier recorded at install time. Kept with the install so the
    /// Plugins page can show what the user actually accepted, even after the
    /// catalog changes or becomes unreachable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
    /// Source pin of the installed version (catalog v2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<MarketProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUiMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<Value>,
    /// `"panel"` (default) or `"widget"`. A widget is a transparent, frameless
    /// floating surface: no 46px host titlebar band, no window-control capsule,
    /// a drag map over the whole window, and a host context menu (close,
    /// minimize, always on top).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    /// Widget placement only: keep the floating surface above other windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_on_top: Option<bool>,
    /// Overrides the per-shape default (panels are resizable, widgets are not).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resizable: Option<bool>,
}

/// Source pin a marketplace install recorded for the installed version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketProvenance {
    pub source_repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub source: String,
    pub enable: bool,
    pub expected_shasum: Option<String>,
    pub granted_permissions: Option<Vec<String>>,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            source: "installed".into(),
            enable: true,
            expected_shasum: None,
            granted_permissions: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub plugin: PluginSummary,
    pub upgraded: bool,
    #[serde(default)]
    pub permission_diff: Vec<String>,
}
