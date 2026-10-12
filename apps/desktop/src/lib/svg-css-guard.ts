import type { DOMPurify } from "dompurify";

/*
 * Mermaid output is inserted as inline SVG, and SVG carries CSS: a `<style>`
 * element and `style`/presentation attributes (`fill="url(…)"`). A diagram
 * written by a model can put `url(https://…)` there through `classDef` or
 * `style`, which would fetch on render. DOMPurify's SVG profile does not look
 * inside CSS, so these guards keep only same-document (`#id`) and `data:`
 * references (ADR 0327).
 */

/** Resolve comments and CSS escapes so `u\72l(` cannot hide a reference. */
function decodeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "�";
    })
    .replace(/\\([\s\S])/g, "$1");
}

function isLocalTarget(target: string): boolean {
  const trimmed = target.trim();
  return trimmed.startsWith("#") || /^data:/i.test(trimmed);
}

const URL_FUNCTION = /url\s*\(\s*("[^"]*"|'[^']*'|[^)'"]*)\s*\)/gi;
const UNQUOTED_URL_PREFIX = /url\s*\(\s*(['"]?)([^'")]*)/gi;

/** True when the CSS could make the renderer fetch something off-document. */
export function cssHasExternalReference(css: string): boolean {
  const decoded = decodeCss(css);
  // `@import`, `image-set()` with bare strings, and CSS `src()` all fetch
  // without spelling `url(`.
  if (/@import|image-set\s*\(|\bsrc\s*\(/i.test(decoded)) return true;
  for (const match of decoded.matchAll(UNQUOTED_URL_PREFIX)) {
    if (!isLocalTarget(match[2] ?? "")) return true;
  }
  return false;
}

/**
 * CSS with every off-document reference neutralized, or null when it cannot be
 * rewritten in place safely (escapes, comments, or markup characters) and the
 * caller must drop it.
 */
export function sanitizeSvgCss(css: string): string | null {
  if (!cssHasExternalReference(css)) return css;
  if (/[\\<]|\/\*/.test(css)) return null;
  const rewritten = css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\s*\([^)]*\)/gi, "none")
    .replace(/\bsrc\s*\([^)]*\)/gi, "none")
    .replace(URL_FUNCTION, (whole, raw: string) => {
      const target = raw.replace(/^(['"])([\s\S]*)\1$/, "$2");
      return isLocalTarget(target) ? whole : "none";
    });
  return cssHasExternalReference(rewritten) ? null : rewritten;
}

/** The slice of a DOMPurify instance the guards use. */
export type SvgCssPurifier = Pick<DOMPurify, "addHook">;

/**
 * Register the CSS guards on a dedicated DOMPurify instance. The caller owns
 * that instance, so these hooks never affect another sanitizer.
 */
export function installSvgCssGuards(purify: SvgCssPurifier): void {
  purify.addHook("afterSanitizeElements", (node) => {
    if (node.nodeName.toLowerCase() !== "style") return;
    const css = node.textContent ?? "";
    const safe = sanitizeSvgCss(css);
    if (safe !== css) node.textContent = safe ?? "";
  });
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    const value = data.attrValue;
    if (typeof value !== "string" || !value) return;
    const safe = sanitizeSvgCss(value);
    if (safe === null) data.keepAttr = false;
    else if (safe !== value) data.attrValue = safe;
  });
}
