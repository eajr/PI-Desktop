import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * Renderer extensions are disabled in this build
 * (`docs/adr/disable-plugin-renderer-extensions.md`). The Plugins page must
 * not present `renderer.extension` as a grant that turns something on, and an
 * installed plugin that declares one says its renderer extension is skipped.
 */
const {
  RENDERER_EXTENSIONS_DISABLED_KEY,
  permissionDisabledInBuild,
  permissionHelp,
  skipsRendererExtension,
} = await import("../src/features/plugins/model.ts");
const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");

const t = (key, options) => `${key}${options?.defaultValue ? `|${options.defaultValue}` : ""}`;

test("reviews explain that renderer.extension grants nothing in this build", () => {
  assert.equal(permissionDisabledInBuild("renderer.extension"), true);
  assert.equal(permissionHelp("renderer.extension", t), RENDERER_EXTENSIONS_DISABLED_KEY);
  // Every other permission keeps its own explanation.
  assert.equal(permissionDisabledInBuild("fs.read"), false);
  assert.equal(permissionHelp("fs.read", t), "plugins.permissionHelp.fs.read|fs.read");
  // Re-enabled, the permission is an ordinary grant again.
  assert.equal(permissionDisabledInBuild("renderer.extension", true), false);
});

test("an installed plugin that declares a renderer extension is marked as skipped", () => {
  assert.equal(skipsRendererExtension({ permissions: ["renderer.extension"] }), true);
  assert.equal(skipsRendererExtension({ permissions: [], capabilities: ["rendererUi"] }), true);
  assert.equal(skipsRendererExtension({ permissions: ["ui.panel"], capabilities: ["panel"] }), false);
  assert.equal(skipsRendererExtension({ permissions: ["renderer.extension"] }, true), false);
});

test("the notice is translated", () => {
  assert.match(en.plugins.rendererExtensionsDisabled, /disabled in this build/);
});
