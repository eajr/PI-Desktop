use serde_json::Value;
use std::sync::RwLock;

const PROXY_URL_MAX: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ProxyMode {
    #[default]
    System,
    Direct,
    Custom {
        url: String,
        bypass: String,
    },
}

static MARKET_PROXY: RwLock<ProxyMode> = RwLock::new(ProxyMode::System);
static SYSTEM_PROXY_RELAY: RwLock<Option<String>> = RwLock::new(None);

/// Mirrors `DEFAULT_NETWORK_PROXY_BYPASS` in `packages/shared`: loopback plus
/// the private ranges a user's own LAN devices live in, so a custom proxy never
/// swallows a local model server, NAS or MCP endpoint.
const DEFAULT_BYPASS: &str =
    "localhost,127.0.0.1,::1,<local>,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16";

pub fn apply_from_settings(value: Option<&Value>) {
    let next = proxy_from_settings(value);
    if let Ok(mut slot) = MARKET_PROXY.write() {
        *slot = next;
    }
}

/// Configure Electron's ephemeral, loopback-only system/PAC proxy relay.
/// This value is runtime-only and is never copied into host-core's environment.
pub fn set_system_proxy_relay(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.len() > PROXY_URL_MAX {
        return Err("system proxy relay URL is too long".into());
    }
    let Some((credentials, address)) = value.split_once('@') else {
        return Err("system proxy relay URL must contain local credentials".into());
    };
    let Some(token) = credentials.strip_prefix("socks5://system-auto:") else {
        return Err("system proxy relay must use the internal SOCKS5 route".into());
    };
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("system proxy relay credential is invalid".into());
    }
    let Some(port) = address.strip_prefix("127.0.0.1:") else {
        return Err("system proxy relay must bind to IPv4 loopback".into());
    };
    let port = port
        .parse::<u16>()
        .map_err(|_| "system proxy relay port is invalid")?;
    if port == 0 {
        return Err("system proxy relay port is invalid".into());
    }
    let mut slot = SYSTEM_PROXY_RELAY
        .write()
        .map_err(|_| "system proxy relay state unavailable")?;
    *slot = Some(value.to_string());
    Ok(())
}

pub fn proxy_from_settings(value: Option<&Value>) -> ProxyMode {
    let Some(object) = value.and_then(Value::as_object) else {
        return ProxyMode::System;
    };
    let proxy = object.get("networkProxy").and_then(Value::as_object);
    let Some(proxy) = proxy else {
        return ProxyMode::System;
    };
    match proxy
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("system")
    {
        "direct" => ProxyMode::Direct,
        "custom" => {
            let url = proxy
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let bypass = proxy
                .get("bypass")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_BYPASS)
                .to_string();
            if url.is_empty() {
                ProxyMode::Direct
            } else {
                ProxyMode::Custom { url, bypass }
            }
        }
        _ => ProxyMode::System,
    }
}

pub fn validate_network_proxy(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let Some(proxy) = object.get("networkProxy") else {
        return Ok(());
    };
    if proxy.is_null() {
        return Ok(());
    }
    let Some(proxy) = proxy.as_object() else {
        return Err("networkProxy must be an object".into());
    };
    let mode = proxy
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("system");
    match mode {
        "system" | "direct" => Ok(()),
        "custom" => {
            let url = proxy.get("url").and_then(Value::as_str).unwrap_or("");
            parse_proxy_url(url).map(|_| ())
        }
        other => Err(format!("unknown networkProxy.mode '{other}'")),
    }
}

pub fn parse_proxy_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("proxy URL is required".into());
    }
    if trimmed.len() > PROXY_URL_MAX {
        return Err("proxy URL is too long".into());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("proxy URL must not contain whitespace".into());
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err("proxy URL must include a scheme".into());
    };
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(
        scheme.as_str(),
        "http" | "https" | "socks" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return Err("proxy scheme must be http, https, or socks5".into());
    }
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let hostport = match hostport.rfind('@') {
        Some(at) => &hostport[at + 1..],
        None => hostport,
    };
    if hostport.is_empty() || hostport.starts_with(':') {
        return Err("proxy URL must include a host".into());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_accepts_http_and_socks5() {
        assert!(parse_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(parse_proxy_url("socks5://127.0.0.1:1080").is_ok());
        assert!(parse_proxy_url("ftp://127.0.0.1:1080").is_err());
        assert!(parse_proxy_url("http://").is_err());
        assert!(parse_proxy_url("socks5://127.0.0.1:1080 extra").is_err());
    }

    #[test]
    fn custom_mode_requires_url() {
        assert!(validate_network_proxy(&json!({
            "networkProxy": { "mode": "custom" }
        }))
        .is_err());
        assert!(validate_network_proxy(&json!({
            "networkProxy": { "mode": "custom", "url": "socks5://127.0.0.1:1080" }
        }))
        .is_ok());
        assert!(validate_network_proxy(&json!({
            "networkProxy": { "mode": "direct" }
        }))
        .is_ok());
    }

    #[test]
    fn system_relay_requires_authenticated_loopback() {
        for invalid in [
            "socks5://system-http:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.0.0.1:43210",
            "socks5://system-auto:short@127.0.0.1:43210",
            "socks5://system-auto:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@0.0.0.0:43210",
            "socks5://system-auto:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@127.0.0.1:0",
        ] {
            assert!(set_system_proxy_relay(invalid).is_err());
        }
    }
}
