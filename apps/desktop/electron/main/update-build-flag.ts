/**
 * Build-time switch for the in-app updater.
 *
 * This fork ships its own builds and must never contact the upstream
 * vastsa/PI-Desktop GitHub Releases feed: no discovery checks, no background
 * downloads, no install-on-quit. While this is `false`:
 *  - `AppUpdaterController` resolves mode `"disabled"` with
 *    `disabledReason: "build"`, attaches no electron-updater listeners and
 *    never schedules or performs a feed check;
 *  - the macOS application menu omits "Check for Updates";
 *  - the renderer shows "Updates are disabled in this build" instead of the
 *    check button and the automatic/manual preference.
 *
 * Flip to `true` only together with a `build.publish` feed in
 * `apps/desktop/package.json` that this build's owner controls.
 */
export const APP_UPDATES_ENABLED: boolean = false;
