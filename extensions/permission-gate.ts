import * as os from "node:os";
import * as path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PATH_TOOLS = new Set([...READ_ONLY_TOOLS, "write", "edit"]);
const MUTATING_TOOLS = new Set(["write", "edit"]);

// Shell operators make an otherwise harmless-looking command difficult to
// classify safely. Treat the whole command as requiring approval rather than
// trying to prove that every chained segment is read-only.
const SHELL_CONTROL = /[\n\r;&|`$()<>\\]/;
const GIT_PUSH_COMMAND = /\bgit(?:\s+(?:--[^\s;&|]+|-[^\s;&|]+)(?:\s+[^\s;&|]+)?)*\s+push(?:\s|$)/i;
// This is intentionally an obvious-command guard, not an OS sandbox. It catches
// common publishing paths while leaving comprehensive enforcement to the host.
const PUBLISH_COMMAND = /(?:\bnpm|pnpm|yarn|bun)\s+publish\b|\b(?:cargo|twine)\s+publish\b|\btwine\s+upload\b|\b(?:docker|podman)\s+push\b|\bgh\s+(?:pr\s+create|release\s+(?:create|upload))\b/i;

function containsGitPush(command: string): boolean {
  return GIT_PUSH_COMMAND.test(command.replaceAll(/["']/g, ""));
}

function containsPublishCommand(command: string): boolean {
  return PUBLISH_COMMAND.test(command.replaceAll(/["']/g, ""));
}

type ToolSourceInfo = {
  path?: unknown;
  source?: unknown;
  package?: unknown;
  server?: unknown;
  serverName?: unknown;
  mcpServer?: unknown;
  [key: string]: unknown;
};

type RegisteredTool = { name?: unknown; sourceInfo?: ToolSourceInfo; source?: ToolSourceInfo };

function sourceInfoText(sourceInfo: ToolSourceInfo | undefined): string {
  if (!sourceInfo) return "";
  return Object.entries(sourceInfo)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key}:${value}`)
    .join(" ")
    .toLowerCase();
}

function isMcpSourceInfo(sourceInfo: ToolSourceInfo | undefined): boolean {
  if (!sourceInfo) return false;
  const text = sourceInfoText(sourceInfo);
  return /(?:^|[\\\\/:@._-])pi-mcp-adapter(?:$|[\\\\/:@._-])/.test(text)
    || /(?:^|[\\\\/:@._-])mcp-adapter(?:$|[\\\\/:@._-])/.test(text)
    || /(?:^|[\\\\/:._-])mcp(?:$|[\\\\/:._-])/.test(String(sourceInfo.source ?? "").toLowerCase());
}

function mcpServerFromSource(sourceInfo: ToolSourceInfo | undefined): string | undefined {
  if (!sourceInfo) return undefined;
  for (const key of ["server", "serverName", "mcpServer"]) {
    const value = sourceInfo[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

function isMcpToolName(toolName: string): boolean {
  return toolName === "mcp"
    || toolName === "mcpScript"
    || /^(?:mcp|mcp-script)(?:__|[_:./-])/i.test(toolName)
    || /(?:^|[_:./-])mcp(?:$|[_:./-])/i.test(toolName);
}

function mcpToolKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "mcp") {
    const server = typeof input.server === "string" ? input.server : "";
    const tool = typeof input.tool === "string" ? input.tool : "";
    return server ? `${server}/${tool}` : tool || "mcp";
  }
  return toolName;
}

// Browser QA is the one headless MCP exception. Match the configured server,
// including the adapter's qualified tool names, not a generic "browser" alias.
function isBrowserMcpRequest(toolName: string, input: Record<string, unknown>, source?: ToolSourceInfo): boolean {
  const server = "chrome-devtools";
  const qualified = (name: unknown) => typeof name === "string"
    && /^(?:chrome-devtools_|chrome_devtools_|mcp__chrome[-_]devtools__)/.test(name);
  if (toolName !== "mcp") {
    return toolName !== "mcpScript" && (mcpServerFromSource(source) === server || qualified(toolName));
  }
  // Auth actions are always captain-managed, never delegated.
  if (input.action) return false;
  if (input.tool) return input.server ? input.server === server : qualified(input.tool);
  if (input.connect) return input.connect === server;
  if (input.describe) return qualified(input.describe);
  if (input.server) return input.server === server;
  if (input.instructions) return input.instructions === server;
  return true; // Gateway status/search only; no call, connection, or auth action.
}

function mcpScriptText(input: Record<string, unknown>): string {
  for (const key of ["script", "code", "source"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return "";
}

const DANGEROUS_BASH = [
  /\bsudo\b/,
  /\brm\b/,
  /\b(mv|cp|touch|mkdir|rmdir|truncate|ln|install)\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill(all)?\b/,
  /\bpkill\b/,
  /\bdd\b/,
  /\b(sh|bash|zsh)\s+-c\b/,
  /\b(sh|bash|zsh)\s+\S+/,
  /\b(source|\.)\s+\S+/,
  /\b(node|deno|python|python3|perl|ruby)\s+(-e|-c)\b/,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/,
  /\b(curl|wget)\b.*(?:--upload-file|-T\b|--data(?:-raw|-binary)?\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b)/,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|dlx|create|exec)\b/,
  /\b(pip|pip3|uv|poetry)\s+(install|add|remove)\b/,
  /\bgit\s+(reset|clean|checkout|switch|restore|rebase|merge|push|commit|add|rm)\b/,
  /\b(find|xargs)\b.*\b-exec\b/,
  /\btee\b/,
];

// Extract common path-shaped arguments from Bash commands. This is not a
// shell parser, but it catches absolute paths and explicit ../ escapes while
// leaving ordinary project commands such as `npm test` uninterrupted.
const COMMAND_PATH = /(?:^|\s)(~\/|\/|\.{1,2}\/)[^\s;&|`$()<>]+/g;
const COMMAND_ASSIGNMENT_PATH = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=(~\/|\/|\.{1,2}\/)[^\s;&|`$()<>]+/g;
const QUOTED_COMMAND_PATH = /(["'])((?:~\/|\/|\.{1,2}\/)[^"';&|`$()<>]+)\1/g;

const SENSITIVE_FILE_NAMES = new Set([
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".npm_history",
  ".psql_history",
  ".pgpass",
  ".my.cnf",
  ".s3cfg",
  ".boto",
  ".vault-token",
  "google-services.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "auth.json",
  "credentials.json",
  "secrets.json",
  "secret.json",
  "token.json",
  "tokens.json",
  "cookies.json",
  "cookies.sqlite",
  "session.json",
  "client_secret.json",
  "service-account.json",
  "application_default_credentials.json",
]);

const SENSITIVE_FILE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".tfstate",
  ".tfstate.backup",
  ".tfvars",
  ".tfvars.json",
  ".secret",
  ".secrets",
];

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".terraform.d",
  ".git",
  ".env",
  ".envs",
  ".credentials",
  ".keys",
  ".secrets",
  ".security",
  "keychains",
]);

const MACOS_SENSITIVE_PATH_PREFIXES = [
  "/etc",
  "/private/etc",
  "/var/db",
  "/private/var/db",
  "/var/root",
  "/private/var/root",
  "/library/keychains",
  "/system/library/keychains",
  "/library/application support/com.apple.tcc",
  "/private/library/application support/com.apple.tcc",
  "/system/library/application support/com.apple.tcc",
];

const MACOS_SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)library\/application support\/com\.apple\.tcc(?:\/|$)/,
  /(?:^|\/)library\/keychains(?:\/|$)/,
];

const MUTATION_PROTECTED_DIRECTORY_NAMES = new Set(["node_modules"]);

const SENSITIVE_COMMAND_MARKERS = [
  ".env",
  ...SENSITIVE_FILE_NAMES,
  ...SENSITIVE_FILE_SUFFIXES,
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

function hasPathSegment(filePath: string, names: Set<string>): boolean {
  return filePath.replaceAll(path.sep, "/").toLowerCase().split("/").some((segment) => names.has(segment));
}

function normalizeComparisonPath(filePath: string): string {
  return path.posix.normalize(filePath.replaceAll("\\", "/")).toLowerCase();
}

function isWithinPathPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function isSensitivePath(filePath: string): boolean {
  const candidates = [filePath];
  if (filePath !== "(unknown path)") {
    const resolved = resolveForBoundary(filePath);
    if (resolved) candidates.push(resolved);
  }
  return candidates.some((candidate) => {
    const normalized = normalizeComparisonPath(candidate);
    const segments = normalized.split("/");
    const basename = segments.at(-1) ?? "";
    const envFile = basename === ".env" || basename.startsWith(".env.");
    const sensitiveNamePattern = /^(?:(?:credentials|secret|token|client_secret|service-account)(?:[.-]|$)|firebase-adminsdk-)/;
    const sensitiveConfigPath = segments.some((segment, index) =>
      segment === ".config" && ["gcloud", "gh"].includes(segments[index + 1] ?? ""),
    );
    return envFile
      || SENSITIVE_FILE_NAMES.has(basename)
      || sensitiveNamePattern.test(basename)
      || basename.startsWith("pulumi.") && /\.(ya?ml|json)$/.test(basename)
      || SENSITIVE_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))
      || segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))
      || sensitiveConfigPath
      || MACOS_SENSITIVE_PATH_PREFIXES.some((prefix) => isWithinPathPrefix(normalized, prefix))
      || MACOS_SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

function resolveForBoundary(filePath: string): string | null {
  let current = path.resolve(filePath);
  const suffix: string[] = [];

  // New files do not exist yet. Resolve their nearest existing parent so a
  // symlinked project directory cannot escape the project boundary.
  while (!existsSync(current)) {
    let isSymlink = false;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch {
      // The path component does not exist; continue toward its parent.
    }
    if (isSymlink) {
      try {
        return path.join(realpathSync(current), ...suffix);
      } catch {
        // An unresolved symlink cannot be safely classified.
        return null;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(filePath);
    suffix.unshift(path.basename(current));
    current = parent;
  }

  try {
    return path.join(realpathSync(current), ...suffix);
  } catch {
    return null;
  }
}

function isWithinProject(filePath: string, cwd: string): boolean {
  if (filePath === "(unknown path)") return false;
  const resolvedProject = resolveForBoundary(cwd);
  const resolvedFile = resolveForBoundary(filePath);
  if (!resolvedProject || !resolvedFile) return false;
  const relative = path.relative(resolvedProject, resolvedFile);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isLexicallyWithin(filePath: string, root: string): boolean {
  if (filePath === "(unknown path)") return false;
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSymlinkEscape(filePath: string, boundaryRoot: string): boolean {
  return isLexicallyWithin(filePath, boundaryRoot) && !isWithinProject(filePath, boundaryRoot);
}

function isWithinGlobalPi(filePath: string): boolean {
  const home = process.env.HOME;
  if (!home || filePath === "(unknown path)") return false;

  let resolvedGlobalPi: string;
  try {
    resolvedGlobalPi = realpathSync(path.join(home, ".pi"));
  } catch {
    return false;
  }

  const resolvedFile = resolveForBoundary(filePath);
  if (!resolvedFile) return false;
  const relative = path.relative(resolvedGlobalPi, resolvedFile);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resourceRootsFromEnvironment(): string[] {
  return (process.env.PI_PERMISSION_RESOURCE_ROOTS ?? "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return null;
      }
    })
    .filter((root): root is string => Boolean(root));
}

function isWithinTrustedSubagentResource(filePath: string): boolean {
  const resolvedFile = resolveForBoundary(filePath);
  if (!resolvedFile || isSensitivePath(resolvedFile)) return false;
  return resourceRootsFromEnvironment().some((root) => {
    const relative = path.relative(root, resolvedFile);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function isValidatedFirstmateReportPath(filePath: string): boolean {
  const taskId = process.env.PI_FIRSTMATE_TASK_ID ?? "";
  const reportPath = process.env.PI_FIRSTMATE_REPORT_PATH ?? "";
  if (!taskId || !reportPath || !path.isAbsolute(reportPath)) return false;
  if (!/^task-[a-z0-9-]{8,80}$/.test(taskId)) return false;

  // Firstmate writes to this exact lexical path. Canonicalize only the root to
  // detect symlink escapes; accepting two resolved paths alone would allow a
  // report-path symlink to redirect writes to an arbitrary file.
  const taskRoot = path.resolve(os.homedir(), ".pi", "firstmate", "tasks");
  const expected = path.join(taskRoot, `${taskId}.report.json`);
  if (path.resolve(reportPath) !== expected || path.resolve(filePath) !== expected) return false;
  let canonicalRoot: string;
  let canonicalReport: string;
  try {
    canonicalRoot = realpathSync(taskRoot);
    if (lstatSync(expected).isSymbolicLink()) return false;
    canonicalReport = realpathSync(expected);
  } catch {
    // The report may be a new file, but its complete existing parent chain must
    // still be canonical and inside the canonical Firstmate task root.
    const parent = path.dirname(expected);
    try {
      canonicalRoot = realpathSync(taskRoot);
      canonicalReport = path.join(realpathSync(parent), path.basename(expected));
    } catch {
      return false;
    }
  }
  const relative = path.relative(canonicalRoot, canonicalReport);
  return relative === path.basename(expected)
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function commandPathArguments(command: string): string[] {
  const normalizedCommand = command.replaceAll(/["']/g, "");
  const paths: string[] = [];
  for (const match of command.matchAll(QUOTED_COMMAND_PATH)) paths.push(match[2]);
  for (const match of normalizedCommand.matchAll(COMMAND_PATH)) paths.push(match[0].trim());
  for (const match of normalizedCommand.matchAll(COMMAND_ASSIGNMENT_PATH)) {
    paths.push(match[0].slice(match[0].indexOf("=") + 1).trim());
  }
  return paths;
}

function containsSensitivePath(command: string, cwd: string): boolean {
  const normalized = command.replaceAll("\\", "/").replaceAll(/["']/g, "").toLowerCase();
  const directoryPath = /(?:^|[\s/])(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.terraform\.d|\.git)(?:[\s/]|$)/;
  const configPath = /(?:^|[\s/])\.config\/(?:gcloud|gh)(?:[\s/]|$)/;
  const namedSecretFile = /(?:^|[\s/])(?:credentials|secret|token|client_secret|service-account|firebase-adminsdk-)[^\s/]*(?:\.(?:json|ya?ml|txt|env|cfg|ini))(?=$|[\s/])/;
  const pulumiConfig = /(?:^|[\s/])pulumi\.[^\s/]+\.(?:ya?ml|json)(?=$|[\s/])/;
  const sensitiveDirectory = normalized.split(/[\s/]+/).some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment));
  const sensitivePathArgument = commandPathArguments(command).some((rawPath) =>
    isSensitivePath(normalizePath(rawPath, cwd)),
  );
  return SENSITIVE_COMMAND_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()))
    || directoryPath.test(normalized)
    || sensitiveDirectory
    || configPath.test(normalized)
    || namedSecretFile.test(normalized)
    || pulumiConfig.test(normalized)
    || sensitivePathArgument;
}

function containsOutOfProjectPath(command: string, cwd: string, boundaryRoot: string): boolean {
  return commandPathArguments(command).some((rawPath) =>
    !isWithinProject(normalizePath(rawPath, cwd), boundaryRoot),
  );
}

function containsSymlinkEscape(command: string, cwd: string, boundaryRoot: string): boolean {
  return commandPathArguments(command).some((rawPath) =>
    isSymlinkEscape(normalizePath(rawPath, cwd), boundaryRoot),
  );
}

function isDangerousBash(command: string): boolean {
  // Do this before checking dangerous words. Otherwise `ls file ; rm -rf dir`
  // can match a read-only prefix and bypass the dangerous-command check.
  if (SHELL_CONTROL.test(command)) return true;
  const normalized = command.replaceAll(/["']/g, "").toLowerCase();
  return DANGEROUS_BASH.some((pattern) => pattern.test(normalized));
}

export default function (pi: ExtensionAPI) {
  const trustedExactCommands = new Set<string>();
  const trustedToolPaths = new Set<string>();
  const trustedMcpTools = new Set<string>();
  const trustedMcpScripts = new Set<string>();
  const trustedAllMutatingTools = new Set<string>();
  let allowSafeOperationsForSession = false;
  const permissionGateGlobal = globalThis as Record<string, unknown>;
  const publishPermissionState = (safeOperationsEnabled: boolean) => {
    const previousState = permissionGateGlobal.__permissionGate as { safeOperationsEnabled?: unknown } | undefined;
    permissionGateGlobal.__permissionGate = { safeOperationsEnabled };
    if (previousState?.safeOperationsEnabled !== safeOperationsEnabled) {
      const requestRender = permissionGateGlobal.__footerRequestRender;
      if (typeof requestRender === "function") requestRender();
    }
  };
  publishPermissionState(false);

  const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
  const userAgentDir = path.resolve(
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
    "agents",
  );
  const browserDefinition = process.env.PI_SUBAGENT_AGENT_DEFINITION;
  const isTrustedBrowserDefinition = (() => {
    if (!browserDefinition || !path.isAbsolute(browserDefinition)) return false;
    try {
      const definition = realpathSync(browserDefinition);
      const expected = realpathSync(path.join(userAgentDir, "browser-tester.md"));
      return definition === expected;
    } catch {
      return false;
    }
  })();
  const isTrustedBrowserTester = isSubagentChild
    && process.env.PI_SUBAGENT_AGENT === "browser-tester"
    && process.env.PI_SUBAGENT_AGENT_SOURCE === "user"
    && isTrustedBrowserDefinition;
  const isFirstmateExecution = process.env.PI_FIRSTMATE_WORKER === "1";
  const isFirstmateWorker = isFirstmateExecution && !isSubagentChild;
  const noPublishIdentity = process.env.PI_PERMISSION_NO_PUBLISH === "1";
  const withPermissionDialog = async <T>(label: string, dialog: () => Promise<T>): Promise<T> => {
    pi.events.emit("herdr:blocked", { active: true, label });
    try {
      return await dialog();
    } finally {
      pi.events.emit("herdr:blocked", { active: false });
    }
  };

  pi.on("session_start", async () => {
    allowSafeOperationsForSession = false;
    publishPermissionState(false);
  });

  const checkBashPermission = async (command: string, cwd: string, ctx: ExtensionContext) => {
    if ((isFirstmateExecution || noPublishIdentity) && containsGitPush(command)) {
      return { allowed: false as const, reason: "git push is blocked for Firstmate workers and their subagents" };
    }
    if ((isFirstmateExecution || noPublishIdentity) && containsPublishCommand(command)) {
      return { allowed: false as const, reason: "Publishing commands are blocked for Firstmate workers and their subagents" };
    }

    const boundaryRoot = process.env.PI_PERMISSION_ROOT ?? ctx.cwd;
    const sensitive = containsSensitivePath(command, cwd);
    const dangerous = isDangerousBash(command);
    const outsideProject = containsOutOfProjectPath(command, cwd, boundaryRoot);
    const symlinkEscape = containsSymlinkEscape(command, cwd, boundaryRoot);
    const subagentOutsideRoot = isSubagentChild && !isWithinProject(cwd, boundaryRoot);
    if (!command || (!dangerous && !sensitive && !outsideProject && !subagentOutsideRoot) || trustedExactCommands.has(command)) {
      return { allowed: true as const };
    }
    if (allowSafeOperationsForSession && !dangerous && !sensitive && !symlinkEscape && !subagentOutsideRoot) {
      return { allowed: true as const };
    }

    if (isSubagentChild) {
      return {
        allowed: false as const,
        reason: sensitive
          ? "Sensitive-path Bash command blocked for headless subagent"
          : "Unsafe Bash command blocked for headless subagent",
      };
    }

    if (!ctx.hasUI) {
      return {
        allowed: false as const,
        reason: `Permission required for ${sensitive ? "sensitive" : "unsafe"} Bash command, but no UI is available`,
      };
    }

    const choice = await withPermissionDialog(
      "Unsafe Bash",
      () => ctx.ui.select(`${sensitive ? "🚨 Sensitive-path Bash command" : "⚠️ Allow unsafe Bash command"}?\n\n${command}`, [
        "Allow once",
        ...(!dangerous && !sensitive && !symlinkEscape && outsideProject ? ["Allow safe operations for this session"] : []),
        "Trust exact command for this session",
        "Block",
      ]),
    );

    if (choice === "Allow safe operations for this session" && !dangerous && !sensitive && !symlinkEscape && outsideProject) {
      allowSafeOperationsForSession = true;
      publishPermissionState(true);
      return { allowed: true as const };
    }
    if (choice === "Trust exact command for this session") {
      trustedExactCommands.add(command);
      return { allowed: true as const };
    }
    if (choice === "Allow once") return { allowed: true as const };
    return { allowed: false as const, reason: "Blocked by permission gate" };
  };

  pi.registerCommand("permissions", {
    description: "Show or clear session permission-gate trust rules",
    handler: async (args, ctx) => {
      const action = String(args ?? "").trim();
      if (action === "clear") {
        trustedExactCommands.clear();
        trustedToolPaths.clear();
        trustedMcpTools.clear();
        trustedMcpScripts.clear();
        trustedAllMutatingTools.clear();
        allowSafeOperationsForSession = false;
        publishPermissionState(false);
        ctx.ui.notify("Permission trust rules cleared", "info");
        return;
      }

      const lines = [
        "**Permission Gate Session Trust**",
        "",
        `- Trusted bash commands: ${trustedExactCommands.size}`,
        `- Trusted file tool/path pairs: ${trustedToolPaths.size}`,
        `- Trusted MCP tools: ${trustedMcpTools.size}`,
        `- Trusted MCP scripts: ${trustedMcpScripts.size}`,
        `- Trusted all-tool entries: ${trustedAllMutatingTools.size}`,
        `- Safe operations for this session: ${allowSafeOperationsForSession ? "enabled" : "disabled"}`,
        "",
        "Run `/permissions clear` to clear all session trust rules and disable safe operations.",
      ];

      pi.sendMessage({ customType: "permission-gate", content: lines.join("\n"), display: true });
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    const permission = await checkBashPermission(event.command, event.cwd, ctx);
    if (permission.allowed) return undefined;
    return {
      result: {
        output: permission.reason,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const registeredTools = (() => {
      try {
        return (pi as ExtensionAPI & { getAllTools?: () => RegisteredTool[] }).getAllTools?.() ?? [];
      } catch {
        return [];
      }
    })();
    const registeredTool = registeredTools.find((tool) => tool.name === event.toolName);
    const sourceInfo = registeredTool?.sourceInfo ?? registeredTool?.source;
    const sourceMcp = isMcpSourceInfo(sourceInfo);
    const classifiedMcp = sourceMcp || isMcpToolName(event.toolName);

    // A headless child must not gain an unclassified tool merely because the
    // host added it after the allowlist was built. Known MCP tools are handled
    // below; all other unknown tools fail closed.
    const knownBuiltinTool = PATH_TOOLS.has(event.toolName) || event.toolName === "bash";
    if (isSubagentChild && !registeredTool && !classifiedMcp && !knownBuiltinTool) {
      return { block: true, reason: `Unknown tool blocked for headless subagent: ${event.toolName}` };
    }

    // Subagents run in headless `pi --mode json -p --no-session` child processes.
    // They cannot answer UI permission prompts, so allow normal work only inside
    // the parent project and block sensitive or out-of-boundary operations.
    if (event.toolName === "bash") {
      const permission = await checkBashPermission(String(event.input.command ?? ""), ctx.cwd, ctx);
      if (!permission.allowed) return { block: true, reason: permission.reason };
    }

    if (PATH_TOOLS.has(event.toolName)) {
      const boundaryRoot = process.env.PI_PERMISSION_ROOT ?? ctx.cwd;
      const rawPath = READ_ONLY_TOOLS.has(event.toolName) && event.toolName !== "read"
        ? event.input.path ?? ctx.cwd
        : event.input.path;
      const filePath = normalizePath(rawPath, ctx.cwd);
      const key = `${event.toolName}:${filePath}`;
      const sensitive = isSensitivePath(filePath);
      const protectedMutation = MUTATING_TOOLS.has(event.toolName)
        && hasPathSegment(filePath, MUTATION_PROTECTED_DIRECTORY_NAMES);
      const inProject = isWithinProject(filePath, boundaryRoot);
      const symlinkEscape = isSymlinkEscape(filePath, boundaryRoot);
      const globalPiRead = READ_ONLY_TOOLS.has(event.toolName)
        && !isSubagentChild
        && !sensitive
        && isWithinGlobalPi(filePath);
      const trustedSubagentResourceRead = READ_ONLY_TOOLS.has(event.toolName)
        && isSubagentChild
        && isWithinTrustedSubagentResource(filePath);
      const validatedReportWrite = isFirstmateWorker
        && MUTATING_TOOLS.has(event.toolName)
        && isValidatedFirstmateReportPath(filePath);
      const needsApproval = sensitive
        || protectedMutation
        || symlinkEscape
        || (!inProject && !globalPiRead && !trustedSubagentResourceRead && !validatedReportWrite);

      // Ordinary project reads, searches, listings, and edits are allowed without interruption.
      // Non-sensitive global ~/.pi reads are also allowed for interactive users;
      // sensitive paths, mutations, symlink escapes, and headless access remain guarded.
      if (!needsApproval) return undefined;
      const canEnableSafeOperations = filePath !== "(unknown path)"
        && !sensitive
        && !protectedMutation
        && !symlinkEscape
        && !inProject
        && !globalPiRead;
      if (allowSafeOperationsForSession && canEnableSafeOperations) return undefined;
      if (!sensitive && MUTATING_TOOLS.has(event.toolName) && trustedAllMutatingTools.has(event.toolName)) return undefined;
      if (trustedToolPaths.has(key)) return undefined;

      if (isSubagentChild) {
        return {
          block: true,
          reason: sensitive || protectedMutation || symlinkEscape
            ? `Protected path blocked for headless subagent: ${displayPath(filePath)}`
            : `Project boundary blocked for headless subagent: ${displayPath(filePath)}`,
        };
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `Permission required for ${event.toolName} to ${displayPath(filePath)}, but no UI is available` };
      }

      const choice = await withPermissionDialog(
        "Protected path",
        () => ctx.ui.select(
          `${sensitive || protectedMutation || symlinkEscape ? "🚨 Protected path" : "📁 Outside project"}\n\nTool: ${event.toolName}\nPath: ${displayPath(filePath)}\n\nAllow?`,
          [
            "Allow once",
            ...(canEnableSafeOperations ? ["Allow safe operations for this session"] : []),
            "Trust this file for this session",
            ...(MUTATING_TOOLS.has(event.toolName) ? [`Trust all ${event.toolName} calls for this session`] : []),
            "Block",
          ],
        ),
      );

      if (choice === "Allow safe operations for this session" && canEnableSafeOperations) {
        allowSafeOperationsForSession = true;
        publishPermissionState(true);
        return undefined;
      }
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

    if (classifiedMcp) {
      if (process.env.PI_FIRSTMATE_ACTIVE === "1") {
        return { block: true, reason: "Firstmate delegates MCP browser work to the browser-tester agent" };
      }
      const key = mcpToolKey(event.toolName, event.input);
      const trustedBrowserMcp = isTrustedBrowserTester && isBrowserMcpRequest(event.toolName, event.input, sourceInfo);
      if (isFirstmateExecution || (noPublishIdentity && !trustedBrowserMcp)) {
        return { block: true, reason: "MCP calls are blocked for Firstmate workers and their subagents" };
      }
      // mcpScript executes its own internal calls in the vendor adapter, so the
      // only safe hook available here is approval of the entire script. Direct
      // tools additionally require provenance for the approved browser server;
      // an adapter path without server metadata is not trusted by a child.
      if (trustedBrowserMcp && event.toolName !== "mcpScript") return undefined;

      const script = event.toolName === "mcpScript" ? mcpScriptText(event.input) : "";
      if (event.toolName === "mcpScript" && !script) {
        return { block: true, reason: "MCP script is missing a nonempty script body; blocked fail-closed" };
      }
      const trustKey = script ? `script:${script}` : key;
      if (script ? trustedMcpScripts.has(trustKey) : trustedMcpTools.has(key)) return undefined;

      if (isSubagentChild) {
        return {
          block: true,
          reason: script
            ? "MCP script blocked for headless subagent; trusted user browser provenance is required"
            : `MCP tool blocked for headless subagent: ${key}`,
        };
      }

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: script
            ? "Permission required for the entire MCP script, but no UI is available"
            : `Permission required for MCP tool ${key}, but no UI is available`,
        };
      }

      const preview = script || JSON.stringify(event.input.args ?? event.input, null, 2);
      const choice = await withPermissionDialog(
        script ? "MCP script" : "MCP tool",
        () => ctx.ui.select(
          `${script ? "🔌 Allow entire MCP script?" : "🔌 Allow MCP tool call?"}\n\n${key}\n\nArgs:\n${preview.slice(0, 8_000)}`,
          [
            "Allow once",
            ...(script ? ["Trust this MCP script for this session"] : ["Trust this MCP tool for this session"]),
            "Block",
          ],
        ),
      );

      if (choice === "Trust this MCP script for this session" && script) {
        trustedMcpScripts.add(trustKey);
        return undefined;
      }
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
    trustedMcpScripts.clear();
    trustedAllMutatingTools.clear();
    allowSafeOperationsForSession = false;
    publishPermissionState(false);
  });
}
