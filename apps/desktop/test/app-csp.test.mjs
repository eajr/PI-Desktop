import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * The app window's Content-Security-Policy (`apps/desktop/index.html`). Plugin
 * renderer extensions are disabled in this build because a module evaluated in
 * the main window shares its privileged preload bridge
 * (`docs/adr/disable-plugin-renderer-extensions.md`), so the page must not name
 * their scheme as a script source, and nothing in the app needs string eval.
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function directive(name) {
  const content = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1];
  assert.ok(content, "index.html declares a CSP meta tag");
  const entry = content
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  assert.ok(entry, `the CSP has a ${name} directive`);
  return entry.split(/\s+/).slice(1);
}

test("script-src does not admit plugin renderer modules", () => {
  const sources = directive("script-src");
  assert.ok(!sources.includes("plugin-renderer:"), sources.join(" "));
});

test("script-src does not allow string evaluation", () => {
  const sources = directive("script-src");
  assert.ok(!sources.includes("'unsafe-eval'"), sources.join(" "));
});

test("script-src still allows the app's own modules", () => {
  assert.ok(directive("script-src").includes("'self'"));
});
