import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import { CONFIG } from "./config.js";

export let currentTheme: Theme | undefined;

export function setCurrentTheme(theme: Theme | undefined): void {
  currentTheme = theme;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function hasVisibleContent(line: string): boolean {
  return stripAnsi(line).trim().length > 0;
}

export function getVisibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function hexToBgAnsi(hex: string): string {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export function isHexColor(color: string): boolean {
  return typeof color === "string" && color.startsWith("#");
}

export function applyColor(theme: Theme, color: string, text: string): string {
  if (isHexColor(color)) {
    const ansi = hexToAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[39m`;
  }
  try {
    return theme.fg(color as ThemeColor, text);
  } catch {
    return text;
  }
}

export function applyBgColor(theme: Theme, color: string | undefined, text: string): string {
  if (!color) return text;
  if (isHexColor(color)) {
    const ansi = hexToBgAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[49m`;
  }
  try {
    const fgAnsi = theme.getFgAnsi(color as ThemeColor);
    // Convert fg escape (38) to bg escape (48)
    // truecolor: \x1b[38;2;R;G;Bm → \x1b[48;2;R;G;Bm
    // 256color: \x1b[38;5;Nm → \x1b[48;5;Nm
    const bgAnsi = fgAnsi.replace(/\x1b\[38;/, "\x1b[48;");
    if (!bgAnsi || bgAnsi === fgAnsi) return text;
    return `${bgAnsi}${text}\x1b[49m`;
  } catch {
    // Also try ThemeBg keys directly
    try {
      return theme.bg(color as any, text);
    } catch {
      return text;
    }
  }
}

export function toolPrefix(theme: Theme): string {
  return `${applyColor(theme, CONFIG.tools.toolSuccess.prefixColor, CONFIG.tools.toolSuccess.prefix)} `;
}

export function errorPrefix(theme: Theme): string {
  return `${applyColor(theme, CONFIG.tools.toolError.prefixColor, CONFIG.tools.toolError.prefix)} `;
}

export function getExpandToggleKey(): string {
  return getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
}

export function shortenPath(filePath: string, cwd: string): string {
  if (!filePath) return "";
  const home = process.env.HOME ?? "";
  if (home && filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  const rel = relative(cwd, filePath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) {
    return rel || ".";
  }
  return filePath;
}
