import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MUTATING_TOOLS = new Set(["write", "edit"]);
const READ_ONLY_BASH = [
  /^\s*pwd\s*$/,
  /^\s*ls(\s|$)/,
  /^\s*find\s+.*$/,
  /^\s*rg(\s|$)/,
  /^\s*grep(\s|$)/,
  /^\s*git\s+(status|diff|show|log|branch)(\s|$)/,
  /^\s*(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|typecheck|build)|lint|typecheck)(\s|$)/,
  /^\s*(pytest|cargo\s+test|go\s+test|mvn\s+test|dotnet\s+test)(\s|$)/,
];

const DANGEROUS_BASH = [
  /\bsudo\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill(all)?\b/,
  /\bpkill\b/,
  /\bdd\b/,
  /\b(sh|bash|zsh)\s+-c\b/,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|dlx|create|exec)\b/,
  /\b(pip|pip3|uv|poetry)\s+(install|add|remove)\b/,
  /\bgit\s+(reset|clean|checkout|switch|restore|rebase|merge|push|commit|add|rm)\b/,
  /(^|[^>])>\s*[^&]/,
  />>/,
  /\btee\b/,
];

const SENSITIVE_PATH_PARTS = [
  ".env",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  "id_rsa",
  "id_ed25519",
  ".ssh/",
  ".git/",
  "node_modules/",
];

function normalizePath(rawPath: unknown, cwd: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) return "(unknown path)";
  const expanded = rawPath.startsWith("~/") ? path.join(process.env.HOME ?? "", rawPath.slice(2)) : rawPath;
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
}

function displayPath(filePath: string): string {
  const home = process.env.HOME;
  if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
  return filePath;
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll(path.sep, "/").toLowerCase();
  return SENSITIVE_PATH_PARTS.some((part) => normalized.includes(part.toLowerCase()));
}

function isReadOnlyBash(command: string): boolean {
  return READ_ONLY_BASH.some((pattern) => pattern.test(command));
}

function isDangerousBash(command: string): boolean {
  if (!isReadOnlyBash(command) && DANGEROUS_BASH.some((pattern) => pattern.test(command))) return true;

  // Multi-command shell lines are harder to classify safely. Prompt unless they matched the read-only allowlist.
  if (!isReadOnlyBash(command) && /[;&|`$()]/.test(command)) return true;

  return false;
}

export default function (pi: ExtensionAPI) {
  const trustedExactCommands = new Set<string>();
  const trustedToolPaths = new Set<string>();
  const trustedMcpTools = new Set<string>();
  const trustedAllMutatingTools = new Set<string>();

  pi.registerCommand("permissions", {
    description: "Show or clear session permission-gate trust rules",
    handler: async (args, ctx) => {
      const action = String(args ?? "").trim();
      if (action === "clear") {
        trustedExactCommands.clear();
        trustedToolPaths.clear();
        trustedMcpTools.clear();
        trustedAllMutatingTools.clear();
        ctx.ui.notify("Permission trust rules cleared", "info");
        return;
      }

      const lines = [
        "**Permission Gate Session Trust**",
        "",
        `- Trusted bash commands: ${trustedExactCommands.size}`,
        `- Trusted file tool/path pairs: ${trustedToolPaths.size}`,
        `- Trusted MCP tools: ${trustedMcpTools.size}`,
        `- Trusted all-tool entries: ${trustedAllMutatingTools.size}`,
        "",
        "Run `/permissions clear` to clear all session trust rules.",
      ];

      pi.sendMessage({ customType: "permission-gate", content: lines.join("\n"), display: true });
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = String(event.input.command ?? "");
      if (!command || !isDangerousBash(command) || trustedExactCommands.has(command)) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: "Permission required for unsafe bash command, but no UI is available" };
      }

      const choice = await ctx.ui.select(`⚠️ Allow unsafe bash command?\n\n${command}`, [
        "Allow once",
        "Trust exact command for this session",
        "Block",
      ]);

      if (choice === "Trust exact command for this session") {
        trustedExactCommands.add(command);
        return undefined;
      }
      if (choice === "Allow once") return undefined;
      return { block: true, reason: "Blocked by permission gate" };
    }

    if (MUTATING_TOOLS.has(event.toolName)) {
      const filePath = normalizePath(event.input.path, ctx.cwd);
      const key = `${event.toolName}:${filePath}`;
      if (trustedAllMutatingTools.has(event.toolName) || trustedToolPaths.has(key)) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: `Permission required for ${event.toolName} to ${displayPath(filePath)}, but no UI is available` };
      }

      const sensitive = isSensitivePath(filePath);
      const choice = await ctx.ui.select(
        `${sensitive ? "🚨 Sensitive path" : "✏️ File modification"}\n\nTool: ${event.toolName}\nPath: ${displayPath(filePath)}\n\nAllow?`,
        [
          "Allow once",
          "Trust this file for this session",
          `Trust all ${event.toolName} calls for this session`,
          "Block",
        ],
      );

      if (choice === "Trust this file for this session") {
        trustedToolPaths.add(key);
        return undefined;
      }
      if (choice === `Trust all ${event.toolName} calls for this session`) {
        trustedAllMutatingTools.add(event.toolName);
        return undefined;
      }
      if (choice === "Allow once") return undefined;
      return { block: true, reason: "Blocked by permission gate" };
    }

    if (event.toolName === "mcp" && event.input.tool) {
      const server = String(event.input.server ?? "");
      const tool = String(event.input.tool ?? "");
      const key = server ? `${server}/${tool}` : tool;
      if (trustedMcpTools.has(key)) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: `Permission required for MCP tool ${key}, but no UI is available` };
      }

      const choice = await ctx.ui.select(`🔌 Allow MCP tool call?\n\n${key}\n\nArgs:\n${String(event.input.args ?? "")}`, [
        "Allow once",
        "Trust this MCP tool for this session",
        "Block",
      ]);

      if (choice === "Trust this MCP tool for this session") {
        trustedMcpTools.add(key);
        return undefined;
      }
      if (choice === "Allow once") return undefined;
      return { block: true, reason: "Blocked by permission gate" };
    }

    return undefined;
  });

  pi.on("session_shutdown", async () => {
    trustedExactCommands.clear();
    trustedToolPaths.clear();
    trustedMcpTools.clear();
    trustedAllMutatingTools.clear();
  });
}
