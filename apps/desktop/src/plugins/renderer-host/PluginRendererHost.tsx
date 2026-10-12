/**
 * Mounts once per app window and keeps its plugin renderer modules in step
 * with the plugin list and the open project (`rendererLoadSpecs`): a plugin
 * loads when it becomes eligible, reloads when the main process hands out a
 * new generation, and unloads — taking its registrations and style sheets
 * along — when it stops being eligible or the host goes away. It also hides
 * the plugins' layers while the host waits on the user's own decision.
 */
import { useEffect, useLayoutEffect } from "react";
import { sessionAwaitsDecision, useHostSafetySurfaceMounted } from "../../lib/host-safety-layer";
import { useAppStore } from "../../stores/app-store";
import { pluginLayers } from "../renderer-layers/layer-stack";
import { RENDERER_EXTENSIONS_ENABLED } from "@pi-desktop/shared";
import { installRendererImportMap } from "./import-map";
import { rendererLoadSpecs, rendererModules } from "./loader";
import "../renderer-slots/slot-shell.css";

export function PluginRendererHost(): null {
  const plugins = useAppStore((state) => state.plugins);
  const projectPath = useAppStore((state) => state.workspace?.path ?? null);
  const awaitsDecision = useAppStore(sessionAwaitsDecision);
  const safetySurfaceMounted = useHostSafetySurfaceMounted();
  const suspended = awaitsDecision || safetySurfaceMounted;

  useEffect(() => {
    // Plugin modules import bare `react`: the map must exist before the first.
    // With renderer extensions off in this build there is no first module, so
    // the host's React is not published on the window either.
    if (RENDERER_EXTENSIONS_ENABLED) installRendererImportMap();
    rendererModules.sync(rendererLoadSpecs(plugins, projectPath));
  }, [plugins, projectPath]);

  useEffect(() => () => rendererModules.sync([]), []);

  // Before paint, so a decision never shows with a layer over it.
  useLayoutEffect(() => {
    pluginLayers.setSuspended(suspended);
  }, [suspended]);

  return null;
}
