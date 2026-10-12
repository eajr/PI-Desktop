# ADR: Remove the remote plugin marketplace

- Status: Accepted
- Date: 2026-10-12
- Supersedes: ADR 0276; ADR 0241 (the bundled file view)
- Related: ADR 0005, ADR 0102, ADR 0104, ADR 0105

## Context

The marketplace client in `host-core` had several network behaviors that run
without the user asking for them. It fetched a remote catalog from
`plugins.aiuo.net`, falling back to backup channels on `cnb.cool` and GitHub.
Every official install or update posted a device identifier to
`/api/v1/download/resolve`. That identifier was a SHA-256 digest of the OS
machine id, or of a random id stored on first use. Packages were downloaded
with a spawned `curl`, falling back to a hand-written `TcpStream` HTTP client.
The plugins page also checked for updates every time it opened. The
`PI_DESKTOP_PLUGIN_MARKET_URL` environment variable could redirect all of this
to another host.

The application also shipped `pi.file-manager` (ADR 0241). That was a minified
third-party bundle, vendored from an outside repository, that this repository
could not review as source.

This build must not contact a plugin distribution service and must not derive
or send any device identifier.

## Decision

Remove the remote plugin marketplace and the vendored file-manager plugin.

- `host-core`:
  - Remove the catalog fetch and the resolve call.
  - Remove the device-id module.
  - Remove the download progress, cancel, and mirror machinery.
  - Remove the curl and `TcpStream` download paths.
  - Remove the package-host allowlist.
  - Remove the `PI_DESKTOP_PLUGIN_MARKET_URL` override.
  - Remove the `market.*` and `plugins.setAutoUpdate` RPC methods.
  - Keep only the plugin version comparison, in `plugins/version.rs`.
- Shared protocol, preload API, and Electron IPC: remove the `market*` channels,
  `pluginSetAutoUpdate`, and the `pluginInstallProgress` event. The local MCP
  control plane no longer lists `market/search` or `market/getDetail`.
- Renderer: the plugins page lists installed plugins only. There is no
  marketplace tab, detail sheet, remote install dialog, update check, or
  auto-update toggle.
- Plugins can still be installed from a local package file or folder, loaded
  from a development folder, or created from a template. `pi.browser` stays
  bundled.
- `pi.file-manager` is no longer bundled. A project file opens in the host file
  tab. If the user installs and enables a view registered as
  `pi.file-manager/manager` themselves, it is still preferred. A click never
  enables or reloads a plugin.

### Existing user data

- A `plugins/market/` directory left by an older build is neither read nor
  deleted. That includes its cached catalog, its cache metadata, and
  `device.json`.
- Plugins installed from the marketplace stay registered and keep working. The
  registry's read-only `marketplace` metadata is preserved. The removed
  `autoUpdate`, `updateAvailable`, and `yanked` fields are ignored on read and
  are not written back.
- On the first launch, `sync_builtin` drops the previously bundled
  `pi.file-manager` row because the app no longer ships it. Its files under
  `resources/plugins` were never user data.
- `pluginMarketSource` and `pluginMarketCustomUrl` in settings stay readable,
  so no settings migration is needed. Nothing reads them.

## Consequences

- No plugin catalog, package download, update check, or device identifier ever
  leaves the machine. Plugins are distributed out of band as `.piplug` files or
  folders.
- Users lose one-click discovery and automatic updates. An update means
  installing the new package locally, which still goes through the same
  manifest validation and permission grant.
- The network proxy relay that host-core kept for marketplace downloads is
  still configured but has no remaining consumer. Removing it is a separate
  change.
- A regression test in `host-core`
  (`host_core_has_no_plugin_marketplace_client`) fails if a marketplace host,
  the resolve path, the override variable, or a device-identifier source
  reappears in the crate.
