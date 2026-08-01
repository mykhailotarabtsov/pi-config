import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const ARTIFACT_DIR = ".pi/artifacts";
export const HOST = "127.0.0.1";
export const MERMAID_ASSET_PATH = "/assets/mermaid.tiny.js";
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface ArtifactsConfig {
  theme: "auto" | "light" | "dark";
  accent: string;
  accentLight: string;
  maxWidth: number;
  mermaid: boolean;
}

const DEFAULTS: ArtifactsConfig = {
  theme: "auto",
  accent: "#d67858",
  accentLight: "#b95730",
  maxWidth: 860,
  mermaid: true,
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "configs", "artifacts.json");

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function loadConfig(): ArtifactsConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<ArtifactsConfig>;
    return {
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : DEFAULTS.theme,
      accent: safeColor(raw.accent, DEFAULTS.accent),
      accentLight: safeColor(raw.accentLight, DEFAULTS.accentLight),
      maxWidth: typeof raw.maxWidth === "number" && raw.maxWidth >= 400 && raw.maxWidth <= 1400 ? raw.maxWidth : DEFAULTS.maxWidth,
      mermaid: raw.mermaid === true ? true : raw.mermaid === false ? false : DEFAULTS.mermaid,
    };
  } catch {
    return DEFAULTS;
  }
}

export const CONFIG = loadConfig();
