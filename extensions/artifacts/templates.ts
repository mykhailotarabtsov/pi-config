import { Marked } from "marked";
import { parse as diffParse, html as diffHtml } from "diff2html";
import hljs from "highlight.js";
import sanitizeHtml from "sanitize-html";
import { randomBytes } from "node:crypto";

import { CONFIG, MERMAID_ASSET_PATH } from "./config.js";
import { BASE_CSS, D2H_CSS, HLJS_CSS } from "./styles.js";

interface RenderFlags {
  hasMermaid: boolean;
  hasDiff: boolean;
  hasCode: boolean;
}

const MERMAID_LIGHT_THEME = {
  background: "#ffffff",
  primaryColor: "#e0f2fe",
  primaryTextColor: "#0f172a",
  primaryBorderColor: "#0284c7",
  lineColor: "#475569",
  secondaryColor: "#ede9fe",
  tertiaryColor: "#dcfce7",
  textColor: "#0f172a",
  mainBkg: "#ffffff",
  nodeBorder: "#0284c7",
  clusterBkg: "#f8fafc",
  clusterBorder: "#94a3b8",
  edgeLabelBackground: "#ffffff",
  titleColor: "#0f172a",
  actorBkg: "#f0f9ff",
  actorBorder: "#0284c7",
  actorTextColor: "#0f172a",
  signalColor: "#475569",
  signalTextColor: "#0f172a",
  noteBkgColor: "#fef3c7",
  noteTextColor: "#78350f",
  noteBorderColor: "#f59e0b",
  quadrant1Fill: "#dcfce7",
  quadrant2Fill: "#dbeafe",
  quadrant3Fill: "#f1f5f9",
  quadrant4Fill: "#fef3c7",
  quadrantPointFill: "#f97316",
  quadrantPointTextFill: "#ffffff",
  pie1: "#0ea5e9",
  pie2: "#8b5cf6",
  pie3: "#10b981",
  pie4: "#f59e0b",
  pie5: "#f43f5e",
  pieStrokeColor: "#ffffff",
  pieLegendTextColor: "#0f172a",
  xyChart: {
    backgroundColor: "#ffffff",
    titleColor: "#0f172a",
    xAxisLabelColor: "#475569",
    xAxisTitleColor: "#334155",
    yAxisLabelColor: "#475569",
    yAxisTitleColor: "#334155",
    xAxisLineColor: "#94a3b8",
    yAxisLineColor: "#94a3b8",
    plotColorPalette: "#0ea5e9,#8b5cf6,#10b981,#f59e0b,#f43f5e",
  },
};

const MERMAID_DARK_THEME = {
  background: "#171614",
  primaryColor: "#1e293b",
  primaryTextColor: "#f8fafc",
  primaryBorderColor: "#38bdf8",
  lineColor: "#94a3b8",
  secondaryColor: "#312e81",
  tertiaryColor: "#064e3b",
  textColor: "#f8fafc",
  mainBkg: "#1e293b",
  nodeBorder: "#38bdf8",
  clusterBkg: "#1e293b",
  clusterBorder: "#818cf8",
  edgeLabelBackground: "#0f172a",
  titleColor: "#f8fafc",
  actorBkg: "#172554",
  actorBorder: "#38bdf8",
  actorTextColor: "#f8fafc",
  signalColor: "#cbd5e1",
  signalTextColor: "#f8fafc",
  noteBkgColor: "#713f12",
  noteTextColor: "#fef3c7",
  noteBorderColor: "#fbbf24",
  quadrant1Fill: "#14532d",
  quadrant2Fill: "#1e3a8a",
  quadrant3Fill: "#334155",
  quadrant4Fill: "#713f12",
  quadrantPointFill: "#fb923c",
  quadrantPointTextFill: "#0f172a",
  pie1: "#38bdf8",
  pie2: "#a78bfa",
  pie3: "#34d399",
  pie4: "#fbbf24",
  pie5: "#fb7185",
  pieStrokeColor: "#171614",
  pieLegendTextColor: "#f8fafc",
  xyChart: {
    backgroundColor: "#171614",
    titleColor: "#f8fafc",
    xAxisLabelColor: "#cbd5e1",
    xAxisTitleColor: "#e2e8f0",
    yAxisLabelColor: "#cbd5e1",
    yAxisTitleColor: "#e2e8f0",
    xAxisLineColor: "#64748b",
    yAxisLineColor: "#64748b",
    plotColorPalette: "#38bdf8,#a78bfa,#34d399,#fbbf24,#fb7185",
  },
};

const ALLOWED_TAGS = [
  "a", "abbr", "article", "b", "blockquote", "br", "code", "col", "colgroup", "dd", "del",
  "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "i", "input", "kbd", "li", "mark", "ol", "p", "pre", "s", "section", "small",
  "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
];

const SAFE_HTML_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    "*": ["class", "id"],
    a: ["href", "name", "target", "rel"],
    input: ["type", "checked", "disabled"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { a: ["http", "https", "mailto"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function sanitizeFragment(value: string): string {
  return sanitizeHtml(value, SAFE_HTML_OPTIONS);
}

export function sanitizeStoredHtml(value: string): string {
  return sanitizeFragment(value);
}

function renderDiff(diffText: string): string | null {
  try {
    const parsed = diffParse(diffText, {});
    if (!parsed.length) return null;
    return diffHtml(parsed, { outputFormat: "line-by-line", drawFileList: false });
  } catch {
    return null;
  }
}

function renderMarkdown(content: string, flags: RenderFlags): string {
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html({ text }: { text: string }): string {
        // Markdown HTML is untrusted input; sanitize it before the shell is built.
        return sanitizeFragment(text);
      },
      code({ text, lang }: { text: string; lang?: string }): string {
        const language = (lang ?? "").trim().toLowerCase();
        if (language === "mermaid" && CONFIG.mermaid) {
          flags.hasMermaid = true;
          return `<div class="artifact-mermaid"><pre class="mermaid">${escapeHtml(text)}</pre></div>`;
        }
        if (language === "diff") {
          const rendered = renderDiff(text);
          if (rendered) {
            flags.hasDiff = true;
            return rendered;
          }
        }
        const known = language && hljs.getLanguage(language);
        if (known) {
          flags.hasCode = true;
          try {
            const highlighted = hljs.highlight(text, { language }).value;
            return `<pre><code class="hljs language-${escapeAttr(language)}">${highlighted}</code></pre>`;
          } catch {
            // Fall through to escaped code.
          }
        }
        if (language) flags.hasCode = true;
        return `<pre><code${language ? ` class="language-${escapeAttr(language)}"` : ""}>${escapeHtml(text)}</code></pre>`;
      },
    },
  });
  return sanitizeFragment(marked.parse(content) as string);
}

function sseSnippet(slug: string, nonce: string): string {
  return `<script nonce="${nonce}">
(function () {
  var url = new URL(window.location.href);
  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  var es = new EventSource("/events");
  es.addEventListener("reload", function (event) {
    if (event.data === ${JSON.stringify(slug)} || event.data === "*") window.location.reload();
  });
})();
</script>`;
}

function mermaidSnippet(nonce: string): string {
  const light = JSON.stringify(MERMAID_LIGHT_THEME);
  const dark = JSON.stringify(MERMAID_DARK_THEME);
  const themeVariables = CONFIG.theme === "light"
    ? light
    : CONFIG.theme === "dark"
      ? dark
      : `(window.matchMedia("(prefers-color-scheme: dark)").matches ? ${dark} : ${light})`;
  return `<script nonce="${nonce}" src="${MERMAID_ASSET_PATH}"></script>
<script nonce="${nonce}">
(function () {
  function init() {
    if (typeof mermaid === "undefined") return;
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: ${themeVariables} });
      mermaid.run({ querySelector: "pre.mermaid" });
    } catch (error) { console.warn("Mermaid rendering failed", error); }
  }
  if (typeof mermaid !== "undefined") init(); else window.addEventListener("load", init);
})();
</script>`;
}

function csp(nonce: string, hasMermaid: boolean): string {
  const scripts = hasMermaid ? `'nonce-${nonce}' 'self'` : `'nonce-${nonce}'`;
  return `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'`;
}

function buildShell(title: string, slug: string, kind: "markdown" | "html", bodyHtml: string, flags: RenderFlags): string {
  const nonce = randomBytes(16).toString("base64");
  const styles = [`<style data-base>${BASE_CSS}</style>`];
  if (flags.hasDiff) styles.push(`<style data-d2h>${D2H_CSS}</style>`);
  if (flags.hasCode) styles.push(`<style data-hljs>${HLJS_CSS}</style>`);
  const scripts = [sseSnippet(slug, nonce)];
  if (flags.hasMermaid) scripts.push(mermaidSnippet(nonce));
  const generated = Date.now();
  const projectPath = process.cwd();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp(nonce, flags.hasMermaid)}">
<meta name="artifact-kind" content="${kind}">
<meta name="artifact-generated" content="${generated}">
<meta name="artifact-project" content="${escapeAttr(projectPath)}">
<title>${escapeHtml(title)}</title>
${styles.join("\n")}
</head>
<body>
<article>
<header class="artifact-header"><h1>${escapeHtml(title)}</h1><span class="artifact-badge">${kind}</span><span class="artifact-meta">${new Date(generated).toISOString().replace("T", " ").slice(0, 19)}</span></header>
${bodyHtml}
<footer class="artifact-footer">source: ${escapeHtml(projectPath)}</footer>
</article>
${scripts.join("\n")}
</body>
</html>`;
}

export function renderMarkdownDocument(title: string, slug: string, content: string): string {
  const flags: RenderFlags = { hasMermaid: false, hasDiff: false, hasCode: false };
  return buildShell(title, slug, "markdown", renderMarkdown(content, flags), flags);
}

export function renderHtmlDocument(title: string, slug: string, content: string): string {
  if (/^\s*(?:<!doctype|<html[\s>])/i.test(content)) {
    throw new Error("full HTML documents are disabled; provide a static HTML fragment or Markdown instead");
  }
  return buildShell(title, slug, "html", sanitizeFragment(content), { hasMermaid: false, hasDiff: false, hasCode: false });
}

export function renderIndexPage(entries: { slug: string; title: string; kind: string; mtime: number }[], token: string): string {
  const projectPath = process.cwd();
  const rows = entries.map((entry) => {
    const when = entry.mtime ? new Date(entry.mtime).toISOString().replace("T", " ").slice(0, 19) : "";
    const href = `/${entry.slug}.html?token=${encodeURIComponent(token)}`;
    return `<tr><td><a href="${escapeAttr(href)}">${escapeHtml(entry.title)}</a></td><td><span class="artifact-badge">${escapeHtml(entry.kind)}</span></td><td><code>${escapeHtml(when)}</code></td></tr>`;
  });
  const body = entries.length
    ? `<table><thead><tr><th>Title</th><th>Kind</th><th>Generated</th></tr></thead><tbody>${rows.join("\n")}</tbody></table>`
    : "<p><em>No artifacts yet.</em></p>";
  const nonce = randomBytes(16).toString("base64");
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; img-src 'none'`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>Artifacts — ${escapeHtml(projectPath)}</title><style data-base>${BASE_CSS}</style></head><body><article><header class="artifact-header"><h1>Artifacts</h1><span class="artifact-badge">index</span></header>${body}<footer class="artifact-footer">source: ${escapeHtml(projectPath)}</footer></article><script nonce="${nonce}">(function(){var u=new URL(window.location.href);if(u.searchParams.has("token")){u.searchParams.delete("token");window.history.replaceState(null,"",u.pathname+u.search+u.hash);}})();</script></body></html>`;
}
