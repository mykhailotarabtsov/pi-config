import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 120;
const MAX_SUBAGENT_TIMEOUT_SECONDS = 24 * 60 * 60;

function configuredAgentDir(): string {
	const home = process.env.HOME || process.cwd();
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? path.resolve(configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured) : path.join(home, ".pi", "agent");
}

export function readSubagentTimeoutSeconds(settingsPath = path.join(configuredAgentDir(), "settings.json")): number {
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
		const value = (settings as { agents?: { defaults?: { timeoutSeconds?: unknown } } })?.agents?.defaults?.timeoutSeconds;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_SUBAGENT_TIMEOUT_SECONDS) {
			return DEFAULT_SUBAGENT_TIMEOUT_SECONDS;
		}
		return Math.max(1, Math.floor(value));
	} catch {
		return DEFAULT_SUBAGENT_TIMEOUT_SECONDS;
	}
}

function realDirectory(candidate: string): string | null {
	try {
		const resolved = fs.realpathSync(candidate);
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

function installedPiDocs(): string | null {
	const candidates = [process.env.PI_PACKAGE_DIR, process.argv[1]].filter((value): value is string => Boolean(value));
	try { candidates.unshift(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")); } catch { /* Pi may supply virtual imports. */ }
	for (const candidate of candidates) {
		let current: string;
		try { current = fs.realpathSync(candidate); } catch { continue; }
		if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
		for (let i = 0; i < 6; i++) {
			try {
				const metadata = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
				if (metadata.name === "@earendil-works/pi-coding-agent") return realDirectory(path.join(current, "docs"));
			} catch { /* Continue toward the actual runtime root. */ }
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return null;
}

/**
 * Explicit read-only resources children may inspect. This is a guardrail, not a
 * sandbox: it does not constrain a child process that escapes Pi's tool hooks.
 */
export function trustedSubagentResourceRoots(): string[] {
	const agentDir = configuredAgentDir();
	const skillDirs = [path.join(agentDir, "skills")];
	// Only globally configured package skills are trusted, never project packages.
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		for (const pkg of settings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg?.source;
			if (typeof source !== "string") continue;
			if (source.startsWith("npm:")) {
				const name = source.slice(4).replace(/@[^/]*$/, "");
				skillDirs.push(path.join(agentDir, "npm", "node_modules", name, "skills"));
			} else if (source.startsWith("~/") || path.isAbsolute(source)) {
				const root = source.startsWith("~/") ? path.join(process.env.HOME || "", source.slice(2)) : source;
				skillDirs.push(path.join(root, "skills"));
			}
		}
	} catch { /* Missing optional package configuration. */ }
	// Explicit global symlinked skills (e.g. Herdr) keep their own read-only root.
	for (const dir of [...skillDirs]) {
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isSymbolicLink()) skillDirs.push(path.join(dir, entry.name));
			}
		} catch { /* Optional package may not be installed. */ }
	}
	const roots = [...skillDirs.map(realDirectory), installedPiDocs()].filter((root): root is string => Boolean(root));
	return [...new Set(roots)];
}
