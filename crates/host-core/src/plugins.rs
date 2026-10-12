#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, bail, Context, Result};
pub(crate) use chrono::Utc;
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use serde_json::{json, Value};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use std::cmp::Ordering;
pub(crate) use std::fs;
pub(crate) use std::io::{Read, Write};
pub(crate) use std::path::{Component, Path, PathBuf};
pub(crate) use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
pub(crate) use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) use crate::activation::ActivationScope;

pub(crate) const MAX_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const MAX_PACKAGE_FILES: usize = 2000;

mod install;
mod manifest;
mod model;
mod permissions;
mod provider_validation;
mod providers;
mod registry;
mod renderer;
mod validation;
mod version;

pub use manifest::PluginManifest;
pub use model::{
    InstallOptions, InstallResult, MarketProvenance, PluginDisplayI18n, PluginI18nMap,
    PluginMarketplaceMeta, PluginSettingDefinition, PluginSettingOption, PluginSummary,
    PluginUiMeta,
};

/// Locale resolution for plugin display strings.
pub(crate) use model::localized_field;
pub use registry::PluginManager;

// Domain modules share a small set of crate-private helpers. Re-exporting them
// here keeps cross-domain calls explicit without changing the public API.
pub(crate) use install::{
    copy_dir_filtered, extract_zip_bytes, find_plugin_root, read_u16, read_u32, safe_join,
    sha256_hex,
};
pub(crate) use permissions::{derive_capabilities, derive_settings, permission_diff, sanitize_id};
pub(crate) use provider_validation::validate_declared_provider_oauth;
pub(crate) use providers::{
    declared_providers, is_known_api_style, is_known_auth_kind, owned_provider_ids,
    plugin_provider_row_id, reconcile_all, reconcile_plugin, remove_plugin_providers,
    set_plugin_providers_enabled, sync_plugin_providers, MAX_PLUGIN_PROVIDER_MODELS,
};
pub(crate) use renderer::validate_renderer;
pub(crate) use validation::validate_contributions;
pub(crate) use version::compare_plugin_versions;

#[cfg(test)]
mod tests;
