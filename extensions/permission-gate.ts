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

function containsGitPush(command: string): boolean {
  return GIT_PUSH_COMMAND.test(command.replaceAll(/["']/g, ""));
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
  const isFirstmateExecution = process.env.PI_FIRSTMATE_WORKER === "1";
  const isFirstmateWorker = isFirstmateExecution && !isSubagentChild;
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
    if (isFirstmateExecution && containsGitPush(command)) {
      return { allowed: false as const, reason: "git push is blocked for Firstmate workers and their subagents" };
    }
    if (isFirstmateWorker) return { allowed: true as const };

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
    if (process.env.PI_FIRSTMATE_ACTIVE === "1" && event.toolName === "subagent") {
      return { block: true, terminate: true, reason: "Firstmate delegates implementation work through visible Herdr worker tabs via herdr_control" };
    }

    // Subagents run in headless `pi --mode json -p --no-session` child processes.
    // They cannot answer UI permission prompts, so allow normal work only inside
    // the parent project and block sensitive or out-of-boundary operations.
    if (event.toolName === "bash") {
      const permission = await checkBashPermission(String(event.input.command ?? ""), ctx.cwd, ctx);
      if (!permission.allowed) return { block: true, reason: permission.reason };
    }

    if (PATH_TOOLS.has(event.toolName) && !isFirstmateWorker) {
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
      const needsApproval = sensitive || protectedMutation || symlinkEscape || (!inProject && !globalPiRead);

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

    if (isFirstmateExecution && event.toolName === "mcp") {
      return { block: true, reason: "MCP calls are blocked for Firstmate workers and their subagents" };
    }

    if (!isFirstmateWorker && event.toolName === "mcp" && event.input.tool) {
      const server = String(event.input.server ?? "");
      const tool = String(event.input.tool ?? "");
      const key = server ? `${server}/${tool}` : tool;
      if (trustedMcpTools.has(key)) return undefined;

      if (isSubagentChild) {
        return { block: true, reason: `MCP tool blocked for headless subagent: ${key}` };
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `Permission required for MCP tool ${key}, but no UI is available` };
      }

      const choice = await withPermissionDialog(
        "MCP tool",
        () => ctx.ui.select(`🔌 Allow MCP tool call?\n\n${key}\n\nArgs:\n${String(event.input.args ?? "")}`, [
          "Allow once",
          "Trust this MCP tool for this session",
          "Block",
        ]),
      );

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
    allowSafeOperationsForSession = false;
    publishPermissionState(false);
  });
}
