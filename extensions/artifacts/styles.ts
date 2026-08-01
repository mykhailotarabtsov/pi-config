import { CONFIG } from "./config.js";

const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

const LIGHT_TOKENS = `:root { color-scheme: light; --bg: #ffffff; --fg: #1c1c1a; --muted: #6b6862; --border: #e7e5e0; --code-bg: #f7f6f4; --accent: ${CONFIG.accentLight}; --add-bg: #e9f7ee; --add-word-bg: #c8ecd3; --add-fg: #1a7f37; --del-bg: #feeff1; --del-word-bg: #f8d2d7; --del-fg: #c93c4c; }`;
const DARK_TOKENS = `:root { color-scheme: dark; --bg: #171614; --fg: #e6e3de; --muted: #94918a; --border: #2e2d29; --code-bg: #201f1c; --accent: ${CONFIG.accent}; --add-bg: #1d2a20; --add-word-bg: #2b4232; --add-fg: #85c793; --del-bg: #2e1c1e; --del-word-bg: #4a292c; --del-fg: #e28a91; }`;
const TOKENS = CONFIG.theme === "light"
  ? LIGHT_TOKENS
  : CONFIG.theme === "dark"
    ? DARK_TOKENS
    : `${LIGHT_TOKENS}\n@media (prefers-color-scheme: dark) { ${DARK_TOKENS} }`;

const PROSE = `
* { box-sizing: border-box; }
html { font-size: 15px; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: ${FONT_SANS}; line-height: 1.65; -webkit-font-smoothing: antialiased; }
article { max-width: ${CONFIG.maxWidth}px; margin: 0 auto; padding: 2.75rem 1.5rem 4rem; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; color: var(--fg); }
h1 { font-size: 1.45rem; margin: 0; } h2 { font-size: 1.15rem; margin-top: 2.2em; border-bottom: 1px solid var(--border); padding-bottom: .35em; }
h3 { font-size: 1rem; } p { margin: .8em 0; } a { color: var(--accent); text-underline-offset: 2px; }
ul, ol { padding-left: 1.5em; } li { margin: .3em 0; }
blockquote { margin: 1.2em 0; padding: .1em 1.1em; border-left: 3px solid var(--accent); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.5em 0; }
table { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: .9rem; }
th { text-align: left; color: var(--muted); font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; padding: .5em .75em; border-bottom: 1px solid var(--border); }
td { padding: .55em .75em; border-bottom: 1px solid var(--border); vertical-align: top; }
code, kbd, samp, pre { font-family: ${FONT_MONO}; } code { font-size: .85em; background: var(--code-bg); padding: .15em .4em; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1em 1.2em; overflow-x: auto; font-size: .82rem; line-height: 1.55; }
pre code { background: transparent; padding: 0; font-size: inherit; }
input[type="checkbox"] { accent-color: var(--accent); margin-right: .4em; }
img, svg, video { max-width: 100%; }
`;

const CHROME = `
.artifact-header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
.artifact-badge { font-family: ${FONT_MONO}; font-size: .66rem; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: .2em .7em; }
.artifact-meta { margin-left: auto; color: var(--muted); font-size: .72rem; font-family: ${FONT_MONO}; }
.artifact-footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: .72rem; font-family: ${FONT_MONO}; }
.artifact-mermaid { text-align: center; margin: 1.5rem 0; color: var(--fg); }
.artifact-mermaid svg { max-width: 100%; height: auto; font-family: inherit; }
.artifact-mermaid svg text, .artifact-mermaid svg tspan { fill: var(--fg) !important; }
.artifact-mermaid svg foreignObject, .artifact-mermaid svg foreignObject * { color: var(--fg) !important; }
.artifact-mermaid svg .edgeLabel { background: var(--code-bg) !important; color: var(--fg) !important; }
.artifact-mermaid svg .edgeLabel rect { fill: var(--code-bg) !important; stroke: var(--border) !important; }
`;

export const BASE_CSS = `${TOKENS}\n${PROSE}\n${CHROME}`;

export const D2H_CSS = `
.d2h-file-wrapper { border: 1px solid var(--border); border-radius: 8px; margin: 1.2em 0; overflow: auto; }
.d2h-file-header, .d2h-info { background: var(--code-bg); color: var(--muted); border-color: var(--border); }
.d2h-diff-table { font-family: ${FONT_MONO}; font-size: .76rem; }
.d2h-diff-table td, .d2h-diff-table th { padding: 0; border-bottom: 0; }
.d2h-code-linenumber { color: var(--muted); border: 0; }
.d2h-ins { background: var(--add-bg); } .d2h-del { background: var(--del-bg); }
`;

export const HLJS_CSS = `
.hljs { color: var(--fg); background: transparent; }
.hljs-comment, .hljs-quote { color: var(--muted); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #cf222e; }
.hljs-string, .hljs-regexp { color: #0a3069; }
.hljs-number, .hljs-symbol, .hljs-meta { color: #0550ae; }
.hljs-title, .hljs-section { color: #8250df; }
.hljs-type, .hljs-built_in { color: #953800; }
`;
