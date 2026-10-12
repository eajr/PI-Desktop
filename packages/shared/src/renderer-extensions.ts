/**
 * Build-time switch for plugin renderer extensions (`manifest.renderer` plus
 * the `renderer.extension` permission). See
 * `docs/adr/disable-plugin-renderer-extensions.md`.
 *
 * A renderer extension is an ES module evaluated inside the app's own main
 * window realm. That realm holds the full preload bridge
 * (`window.piDesktop`), so a loaded extension can reach every whitelisted IPC
 * channel -- settings, secrets, provider keys, files, MCP configuration --
 * without passing through any plugin permission check. Until extensions run in
 * an isolated realm behind a message bridge, this build does not load them.
 *
 * While this is `false`:
 * - Electron Main hands out no renderer descriptor, `plugin-renderer://`
 *   serves nothing and the `plugin.call` relay refuses every call;
 * - the renderer host builds no load specs and never imports a plugin module;
 * - the app CSP does not allow `plugin-renderer:` as a script source.
 * A plugin that declares a renderer entry still installs and loads its other
 * contributions; the Plugins page says its renderer extension is skipped.
 *
 * Re-enabling requires the isolated realm first, then this flag and the CSP
 * `script-src` in `apps/desktop/index.html` together.
 */
export const RENDERER_EXTENSIONS_ENABLED: boolean = false;
