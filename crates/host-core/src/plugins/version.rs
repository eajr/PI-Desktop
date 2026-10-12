//! Plugin version ordering.
//!
//! Used to decide whether a bundled plugin shipped by this build is newer than
//! a copy the user installed over it (ADR 0241). There is no remote plugin
//! marketplace (ADR fork-removes-plugin-marketplace), so nothing here compares
//! against a catalog.

use super::*;

pub(crate) fn compare_plugin_versions(left: &str, right: &str) -> Ordering {
    let parsed_left = ParsedPluginVersion::parse(left);
    let parsed_right = ParsedPluginVersion::parse(right);
    match (parsed_left, parsed_right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => left.cmp(right),
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ParsedPluginVersion<'a> {
    core: Vec<u64>,
    prerelease: Vec<&'a str>,
}

impl<'a> ParsedPluginVersion<'a> {
    fn parse(version: &'a str) -> Option<Self> {
        let version = version.trim().strip_prefix('v').unwrap_or(version.trim());
        let version = version.split_once('+').map(|(v, _)| v).unwrap_or(version);
        let (core, prerelease) = version.split_once('-').unwrap_or((version, ""));
        let core = core
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()?;
        if core.is_empty()
            || core.len() > 3
            || (!prerelease.is_empty() && prerelease.split('.').any(|part| part.is_empty()))
        {
            return None;
        }
        Some(Self {
            core,
            prerelease: if prerelease.is_empty() {
                Vec::new()
            } else {
                prerelease.split('.').collect()
            },
        })
    }
}

impl Ord for ParsedPluginVersion<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        for (left, right) in self
            .core
            .iter()
            .copied()
            .chain(std::iter::repeat(0))
            .zip(other.core.iter().copied().chain(std::iter::repeat(0)))
            .take(3)
        {
            match left.cmp(&right) {
                Ordering::Equal => continue,
                order => return order,
            }
        }
        match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (left, right) in self.prerelease.iter().zip(&other.prerelease) {
                    let order = match (left.parse::<u64>(), right.parse::<u64>()) {
                        (Ok(left), Ok(right)) => left.cmp(&right),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        (Err(_), Err(_)) => left.cmp(right),
                    };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                self.prerelease.len().cmp(&other.prerelease.len())
            }
        }
    }
}

impl PartialOrd for ParsedPluginVersion<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
