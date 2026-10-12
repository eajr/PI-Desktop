# ADR: Disable plugin renderer extensions until they are isolated

- Status: Accepted (fork security mitigation)
- Date: 2026-10-12
- Related: [permissions matrix](../spec/07-plugins/13-plugin-permissions-matrix.md),
  [manifest schema §3.2](../spec/07-plugins/02-plugin-manifest-schema.md),
  `docs/plugin-plan/slot-contract.html`

## Context

A plugin that declares `manifest.renderer` and holds `renderer.extension`
has its renderer entry imported with `import(url)` straight into the app's
main window (`apps/desktop/src/plugins/renderer-host/loader.ts`). That realm
also holds the preload bridge: `window.piDesktop.invoke` reaches every
whitelisted IPC channel, including settings, secrets, provider keys, files and
MCP configuration (`apps/desktop/electron/preload/index.ts`). So a renderer
extension can do anything the app UI can do, and none of the plugin
permission checks apply. The slot contract (`rendererActions`,
`rendererCallMethods`) only limits what the host hands the module through
`pi`. It is not a sandbox, because the module can ignore `pi` and use the
window's globals. The page CSP made this possible by allowing
`plugin-renderer:` and `'unsafe-eval'` in `script-src`.

The proper fix is to run each extension in an isolated realm (a sandboxed
iframe or `WebContentsView` without the preload) and pass its slot traffic
through a message bridge. That is a large change. Until it exists, this build
turns the feature off.

## Decision

1. Add one build switch, `RENDERER_EXTENSIONS_ENABLED` in
   `packages/shared/src/renderer-extensions.ts`, and set it to `false`.
2. Enforce the switch on both sides of the process boundary:
   - Electron Main (`PluginRuntime`) hands out no renderer descriptor, the
     `plugin-renderer://` resolver serves no file, and the `plugin.call`
     relay refuses with `PLUGIN_UNLOADED`, as for an ended load.
   - The renderer host builds no load specs, does not install the React
     import map, and the app window's module importer rejects instead of
     importing.
3. Remove `plugin-renderer:` and `'unsafe-eval'` from the app CSP
   `script-src`. Nothing in the app needs string evaluation: Shiki uses its
   JavaScript regex engine and no WebAssembly. `'unsafe-inline'` and `blob:`
   stay. The Vite dev server injects an inline React Refresh preamble, and
   `blob:` keeps the dormant import-map shims working once the feature comes
   back. `plugin-renderer:` is also removed from `style-src`, `img-src` and
   `connect-src`, since the scheme serves nothing while the switch is off;
   turning the feature back on must restore it with the isolated realm.
4. Plugins that declare a renderer entry still install, keep their recorded
   `renderer.extension` grant (host-core requires every declared permission
   at install), and load all their other contributions. The grant does
   nothing. The install and development reviews show "Renderer extensions
   are disabled in this build" in place of
   the permission's usual explanation. An installed plugin's details show the
   same notice.
5. No bundled first-party plugin uses a renderer extension (`pi.browser`
   declares neither `manifest.renderer` nor the permission; the bundled
   `pi.file-manager` is gone with ADR fork-removes-plugin-marketplace), so
   no allowlist is needed. Only the example
   `examples/plugins/ui-slots-lab` and third-party or development plugins
   lose the feature.

## Consequences

- Plugin UI slots no longer render: composer controls, message action bars,
  blocks below replies, tool cards, code-block renderers and corner layers.
  `test:e2e:plugin-ui-slots` covers that path and is not applicable while the
  switch is off.
- The host-side machinery (loader, slot registry, dispatch, `plugin.call`
  relay) is kept and stays unit-tested with the switch overridden in tests
  (`rendererExtensionsEnabled: true` on `PluginRuntime`, or the `enabled`
  argument of `rendererLoadSpecs`). Production code never passes the
  override.
- No persisted data or IPC contract changes. `PluginSummary.renderer` was
  already optional and is now always absent.

## Re-enabling

Do not flip the switch alone. First run renderer extensions in an isolated
realm without the preload bridge, with a message bridge for the slot
contract. Then set `RENDERER_EXTENSIONS_ENABLED`, restore the matching
`script-src` source, and supersede this ADR.

## Alternatives

- Keep the feature and depend on the high-risk grant review. Rejected: the
  grant does not tell the user that the plugin gets full app privileges,
  including secrets.
- Remove the feature code. Rejected: the slot contract and its tests are
  what the isolated version will be built on.
