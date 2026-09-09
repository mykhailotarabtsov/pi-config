export interface LoadedCounts {
  /** Runtime metadata supplied by the host; omitted when Pi does not expose it. */
  activeModel?: number;
  extensionCommands?: number;
  contextFiles?: number;
  models?: number;
  extensions?: number;
  mcpServers?: number;
  skills: number;
  promptTemplates: number;
}

type CommandLike = ReadonlyArray<{ source: string; name: string }>;

// Count skills from pi's command registry so package-installed skills are
// included, not just those under ~/.pi/agent/skills.
function countSkills(commands: CommandLike): number {
  const seen = new Set<string>();
  for (const c of commands) {
    if (c.source === "skill") seen.add(c.name);
  }
  return seen.size;
}

// Count prompt templates from pi's command registry so package-installed
// prompts are included, not just those under ~/.pi/agent/prompts.
function countTemplates(commands: CommandLike): number {
  const seen = new Set<string>();
  for (const c of commands) {
    if (c.source === "prompt") seen.add(c.name);
  }
  return seen.size;
}

export function discoverLoadedCounts(commands: CommandLike, runtime: Pick<LoadedCounts, "activeModel" | "contextFiles"> = {}): LoadedCounts {
  // Pi exposes command provenance at runtime, but not a complete extension/model/
  // MCP inventory. Count only what can be proved from that registry and caller
  // metadata; do not recreate the loader's path and ancestor override logic.
  return {
    ...runtime,
    extensionCommands: commands.filter((command) => command.source === "extension").length,
    skills: countSkills(commands),
    promptTemplates: countTemplates(commands),
  };
}
