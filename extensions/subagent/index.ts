/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { readSubagentTimeoutSeconds, trustedSubagentResourceRoots } from "./config.ts";
import { BoundedJsonlReader, getLatestAssistantText, messageUsesTools, RollingMessageBuffer } from "./stream.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_STDERR_LINES = 2_000;
const MAX_MESSAGES = 400;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_MESSAGE_BYTES_TOTAL = 2 * 1024 * 1024;
const MAX_STREAM_BUFFER_BYTES = 256 * 1024;
const MAX_CHAIN_STEPS = 8;
// Chain handoffs are prompt input to the next child; keep them bounded without losing context at either edge.
export const CHAIN_HANDOFF_MAX_CHARS = 12_000;
const CHAIN_HANDOFF_TRUNCATION_MARKER = "\n\n[Previous output truncated: beginning and end preserved.]\n\n";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	attempts?: SingleResult[];
	privateLogPath?: string;
	usedTools: boolean;
	protocolIncomplete?: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	collisions: string[];
}

function truncateUtf8(value: string, maxBytes: number, preserveEdges = false): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const marker = "\n\n[Output truncated: content omitted.]\n\n";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	if (maxBytes <= markerBytes) {
		let prefix = value.slice(0, maxBytes);
		while (Buffer.byteLength(prefix, "utf8") > maxBytes) prefix = prefix.slice(0, -1);
		return prefix;
	}
	const available = maxBytes - markerBytes;
	if (!preserveEdges) {
		let head = value.slice(0, available);
		while (Buffer.byteLength(head, "utf8") > available) head = head.slice(0, -1);
		return `${head}${marker}`;
	}
	const headBytes = Math.ceil(available / 2);
	const tailBytes = Math.floor(available / 2);
	let head = value.slice(0, headBytes);
	let tail = value.slice(-tailBytes);
	while (Buffer.byteLength(head, "utf8") > headBytes) head = head.slice(0, -1);
	while (Buffer.byteLength(tail, "utf8") > tailBytes) tail = tail.slice(1);
	return `${head}${marker}${tail}`;
}

function boundMessage(message: Message): Message {
	const content = Array.isArray(message.content)
		? message.content.map((part: any) => {
			if (part?.type === "text" && typeof part.text === "string") {
				return { ...part, text: truncateUtf8(part.text, MAX_MESSAGE_BYTES, true) };
			}
			return part;
		})
		: message.content;
	return { ...message, content } as Message;
}

export function getFinalOutput(messages: Message[]): string {
	return truncateUtf8(getLatestAssistantText(messages), PER_TASK_OUTPUT_CAP, true);
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "timeout";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	return truncateUtf8(output, PER_TASK_OUTPUT_CAP, true);
}

export function truncateChainHandoff(output: string): string {
	if (output.length <= CHAIN_HANDOFF_MAX_CHARS) return output;
	const available = CHAIN_HANDOFF_MAX_CHARS - CHAIN_HANDOFF_TRUNCATION_MARKER.length;
	const headLength = Math.ceil(available / 2);
	const tailLength = Math.floor(available / 2);
	return `${output.slice(0, headLength)}${CHAIN_HANDOFF_TRUNCATION_MARKER}${output.slice(-tailLength)}`;
}

export function createSubagentEnvironment(
  defaultCwd: string,
  agentName?: string,
  agentSource?: "user" | "project",
  agentDefinition?: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("HERDR_") || key.startsWith("PI_FIRSTMATE_")) delete env[key];
	}
	env.PI_SUBAGENT_CHILD = "1";
	delete env.PI_SUBAGENT_AGENT;
	delete env.PI_SUBAGENT_AGENT_SOURCE;
	delete env.PI_SUBAGENT_AGENT_DEFINITION;
	if (agentName) env.PI_SUBAGENT_AGENT = agentName;
	if (agentSource) env.PI_SUBAGENT_AGENT_SOURCE = agentSource;
	if (agentDefinition) env.PI_SUBAGENT_AGENT_DEFINITION = path.resolve(agentDefinition);
	// Keep this identity separate from coordinator variables so it survives the
	// PI_FIRSTMATE_* scrub and protects children from obvious publishing commands.
	env.PI_PERMISSION_NO_PUBLISH = "1";
	env.PI_PERMISSION_RESOURCE_ROOTS = trustedSubagentResourceRoots().join(path.delimiter);
	env.PI_PERMISSION_ROOT = process.env.PI_PERMISSION_ROOT ?? path.resolve(defaultCwd);
	return env;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function createChildGroupTerminator(
	proc: { pid?: number; kill: (signal?: NodeJS.Signals) => void },
	killDelayMs = 5_000,
): { requestStop: () => void; finish: () => void } {
	let stopRequested = false;
	let killTimer: NodeJS.Timeout | undefined;
	const killGroup = (signal: NodeJS.Signals) => {
		try {
			if (process.platform !== "win32" && typeof proc.pid === "number" && proc.pid > 0) process.kill(-proc.pid, signal);
			else proc.kill(signal);
		} catch {
			try { proc.kill(signal); } catch { /* already exited */ }
		}
	};
	return {
		requestStop: () => {
			if (stopRequested) return;
			stopRequested = true;
			killGroup("SIGTERM");
			killTimer = setTimeout(() => {
				// The leader may have exited while descendants keep the pipes open.
				// Always signal the process group after the grace period.
				killGroup("SIGKILL");
				killTimer = undefined;
			}, killDelayMs);
		},
		finish: () => {
			if (!stopRequested && killTimer) {
				clearTimeout(killTimer);
				killTimer = undefined;
			}
		},
	};
}

export function decodeUtf8Chunks(chunks: Uint8Array[]): string {
	const decoder = new StringDecoder("utf8");
	return chunks.map((chunk) => decoder.write(Buffer.from(chunk))).join("") + decoder.end();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

const DEFAULT_SUBAGENT_MODEL = "openai-codex/gpt-5.6-luna:high";

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function addUsage(left: UsageStats, right: UsageStats): UsageStats {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cost: left.cost + right.cost,
		contextTokens: right.contextTokens || left.contextTokens,
		turns: left.turns + right.turns,
	};
}

function nestedUsage(usage: UsageStats): Record<string, unknown> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

type ToolFailurePayload = { details: unknown; usage?: Record<string, unknown> };

function throwToolFailure(
	message: string,
	details: unknown,
	recordFailure?: (payload: ToolFailurePayload) => void,
): never {
	const usage = details && typeof details === "object" && "results" in details
		? nestedUsage((details as SubagentDetails).results.reduce((total, result) => addUsage(total, result.usage), emptyUsage()))
		: undefined;
	// Keep the thrown value native. Pi owns the error/isError normalization;
	// structured details are carried through the supported tool_result hook.
	recordFailure?.({ details, usage });
	throw new Error(truncateUtf8(message, PER_TASK_OUTPUT_CAP, true));
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export function canRetryWithFallback(result: SingleResult): boolean {
	if (result.usedTools || result.protocolIncomplete || result.stopReason === "aborted" || result.stopReason === "timeout") return false;
	const usedTools = result.messages.some(
		(message) => messageUsesTools(message),
	);
	if (usedTools) return false;

	return (
		result.exitCode !== 0 ||
		(result.stopReason === "error" && result.usage.input === 0 && result.usage.output === 0)
	);
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	fallbackModel?: string,
	deadlineAt = Date.now() + readSubagentTimeoutSeconds() * 1000,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	const baseFailure = (message: string, source: "user" | "project" | "unknown" = "unknown"): SingleResult => ({
		agent: agentName,
		agentSource: source,
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: emptyUsage(),
		step,
		usedTools: false,
	});

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return baseFailure(`Unknown agent: "${agentName}". Available agents: ${available}.`);
	}
	if (!Array.isArray(agent.tools) || agent.tools.length === 0) {
		return baseFailure(`Agent "${agentName}" has no explicit nonempty tools allowlist.`, agent.source);
	}
	if (Date.now() >= deadlineAt) return baseFailure(`Subagent timed out before starting "${agentName}".`, agent.source);

	const selectedModel = agent.model ?? DEFAULT_SUBAGENT_MODEL;
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--model", selectedModel, "--tools", agent.tools.join(",")];
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let spillPath: string | undefined;
	let usedTools = false;
	let protocolIncomplete = false;
	let protocolErrorMessage: string | undefined;
	const messageBuffer = new RollingMessageBuffer<Message>(MAX_MESSAGES, MAX_MESSAGE_BYTES_TOTAL);
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: messageBuffer.items,
		stderr: "",
		usage: emptyUsage(),
		model: selectedModel,
		step,
		usedTools: false,
	};
	const appendChildMessage = (message: Message): boolean => {
		const bounded = boundMessage(message);
		let bytes = 0;
		try { bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8"); } catch { return false; }
		return messageBuffer.append(bounded, bytes);
	};

	const spill = (data: string) => {
		if (!data) return;
		try {
			if (!spillPath) {
				spillPath = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-log-"));
				spillPath = path.join(spillPath, "output.log");
				fs.writeFileSync(spillPath, "", { encoding: "utf8", mode: 0o600 });
			}
			const maxBytes = 1024 * 1024;
			const remaining = maxBytes - fs.statSync(spillPath).size;
			if (remaining > 0) {
				const bounded = truncateUtf8(data, remaining, false);
				if (Buffer.byteLength(bounded, "utf8") <= remaining) fs.appendFileSync(spillPath, bounded);
			}
		} catch {
			// Diagnostics must never make the child lifecycle fail.
		}
	};
	const emitUpdate = () => onUpdate?.({
		content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
		details: makeDetails([currentResult]),
	});

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${task}`);

		let wasAborted = false;
		let timedOut = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				env: createSubagentEnvironment(defaultCwd, agent.name, agent.source, agent.filePath),
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderrLines = 0;
			let settled = false;
			let deadlineTimer: NodeJS.Timeout | undefined;
			let onAbort: () => void = () => undefined;
			const markProtocolIncomplete = (message: string) => {
				protocolIncomplete = true;
				currentResult.protocolIncomplete = true;
				protocolErrorMessage ??= message;
				currentResult.errorMessage = protocolErrorMessage;
			};
			const appendStderrLine = (line: string) => {
				if (stderrLines++ < MAX_STDERR_LINES) currentResult.stderr = truncateUtf8(`${currentResult.stderr}${line}\n`, PER_TASK_OUTPUT_CAP, true);
				else spill(`${line}\n`);
			};
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try { event = JSON.parse(line); } catch {
					spill(`${line}\n`);
					markProtocolIncomplete("Subagent emitted an invalid JSONL row; the protocol may be incomplete.");
					return;
				}
				if (!event || typeof event !== "object") {
					markProtocolIncomplete("Subagent emitted a non-object JSONL row; the protocol may be incomplete.");
					return;
				}
				if ((event.type === "message_end" || event.type === "tool_result_end") && !event.message) {
					markProtocolIncomplete(`Subagent emitted ${event.type} without a message; the protocol is incomplete.`);
					return;
				}
				if (event.type === "message_end" && event.message) {
					const msg = boundMessage(event.message as Message);
					usedTools ||= messageUsesTools(msg);
					currentResult.usedTools = usedTools;
					if (!appendChildMessage(msg)) spill(`${line}\n`);
					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = Math.max(currentResult.usage.contextTokens, usage.totalTokens || 0);
						}
						if (msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = truncateUtf8(msg.errorMessage, PER_TASK_OUTPUT_CAP);
					}
					emitUpdate();
				} else if (event.type === "tool_result_end" && event.message) {
					usedTools = true;
					currentResult.usedTools = true;
					if (!appendChildMessage(event.message as Message)) spill(`${line}\n`);
					emitUpdate();
				}
			};
			const stdoutReader = new BoundedJsonlReader({
				maxLineBytes: MAX_MESSAGE_BYTES,
				onLine: processLine,
				onOverflow: ({ maxBytes }) => {
					spill(`[subagent protocol overflow: stdout JSONL row exceeded ${maxBytes} bytes]\n`);
					markProtocolIncomplete(`Subagent stdout contained a JSONL row larger than ${maxBytes} bytes; the protocol is incomplete.`);
				},
			});
			const stderrReader = new BoundedJsonlReader({
				maxLineBytes: MAX_STREAM_BUFFER_BYTES,
				onLine: appendStderrLine,
				onOverflow: ({ maxBytes }) => spill(`[stderr line exceeded ${maxBytes} bytes]\n`),
			});
			const clearLifecycle = () => {
				if (deadlineTimer) clearTimeout(deadlineTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const terminator = createChildGroupTerminator(proc);
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearLifecycle();
				stdoutReader.end();
				stderrReader.end();
				terminator.finish();
				resolve(code);
			};
			const requestStop = (reason: "abort" | "timeout") => {
				if (settled) return;
				wasAborted ||= reason === "abort";
				timedOut ||= reason === "timeout";
				terminator.requestStop();
			};
			onAbort = () => requestStop("abort");
			proc.stdout.on("data", (data) => stdoutReader.push(data));
			proc.stderr.on("data", (data) => stderrReader.push(data));
			proc.once("close", (code) => finish(code ?? 1));
			proc.once("error", (error) => { currentResult.errorMessage = (error as Error).message; finish(1); });
			const remaining = Math.max(1, deadlineAt - Date.now());
			deadlineTimer = setTimeout(() => requestStop("timeout"), remaining);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});

		currentResult.exitCode = exitCode;
		currentResult.privateLogPath = spillPath;
		currentResult.usedTools = usedTools;
		if (wasAborted) {
			currentResult.exitCode ||= 1;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted.";
		}
		if (!wasAborted && timedOut) {
			currentResult.stopReason = "timeout";
			currentResult.errorMessage = `Subagent exceeded the ${readSubagentTimeoutSeconds()} second timeout.`;
		}
		if (protocolIncomplete) {
			currentResult.exitCode ||= 1;
			if (!wasAborted && !timedOut) currentResult.stopReason = "error";
			if (!wasAborted && protocolErrorMessage) currentResult.errorMessage = protocolErrorMessage;
		}
		if (fallbackModel && fallbackModel !== selectedModel && canRetryWithFallback(currentResult) && Date.now() < deadlineAt) {
			const fallbackAgents = agents.map((candidate) => candidate.name === agentName ? { ...candidate, model: fallbackModel } : candidate);
			const fallback = await runSingleAgent(defaultCwd, fallbackAgents, agentName, task, cwd, step, signal, onUpdate, makeDetails, undefined, deadlineAt);
			fallback.attempts = [currentResult, ...(fallback.attempts ?? [])];
			fallback.usage = addUsage(currentResult.usage, fallback.usage);
			return fallback;
		}
		return currentResult;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const pendingErrorDetails = new Map<string, ToolFailurePayload>();
	pi.on("tool_result", async (event: any) => {
		if (event.toolName !== "subagent" || !event.isError) return;
		const failure = pendingErrorDetails.get(event.toolCallId);
		pendingErrorDetails.delete(event.toolCallId);
		return failure ? { details: failure.details, usage: failure.usage } : undefined;
	});
	pi.on("session_shutdown", () => pendingErrorDetails.clear());

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const fallbackModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}:${ctx.thinkingLevel ?? "high"}`
				: undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					collisions: discovery.collisions,
				});
			const failureDetails = (mode: "single" | "parallel" | "chain", results: SingleResult[] = []): SubagentDetails => makeDetails(mode)(results);
			const fail = (message: string, details: SubagentDetails): never =>
				throwToolFailure(message, details, (payload) => pendingErrorDetails.set(_toolCallId, payload));

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				fail(`Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`, failureDetails("single"));
			}

			const requestedAgentNames = new Set<string>();
			if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
			if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
			if (params.agent) requestedAgentNames.add(params.agent);
			const projectAgentsRequested = Array.from(requestedAgentNames)
				.map((name) => agents.find((a) => a.name === name))
				.filter((a): a is AgentConfig => a?.source === "project");
			if (discovery.collisions.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Project agents override user agents with the same name: ${discovery.collisions.join(", ")}`, "warning");
			}

			if (projectAgentsRequested.length > 0) {
				let trusted = false;
				const trustValue = (ctx as typeof ctx & { isProjectTrusted?: boolean | (() => boolean) }).isProjectTrusted;
				if (typeof trustValue === "function") {
					try { trusted = trustValue() === true; } catch { trusted = false; }
				} else {
					trusted = trustValue === true;
				}
				if (!ctx.hasUI && (!trusted || confirmProjectAgents !== false)) {
					fail(
						trusted
							? "Headless project-local agents require explicit confirmProjectAgents:false."
							: "Project-local agents require a trusted project in headless mode; explicit confirmProjectAgents:false cannot bypass trust.",
						failureDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single"),
					);
				}
				if (!trusted && ctx.hasUI) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) fail("Project-local agents were not approved.", failureDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single"));
				}
			}

			if (params.chain && params.chain.length > 0) {
				if (params.chain.length > MAX_CHAIN_STEPS) {
					fail(`Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_STEPS}.`, failureDetails("chain"));
				}
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						fallbackModel,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						fail(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`, failureDetails("chain", results));
					}
					previousOutput = truncateChainHandoff(getFinalOutput(result.messages));
				}
				const usage = results.reduce((total, result) => addUsage(total, result.usage), emptyUsage());
				return {
					content: [{ type: "text", text: truncateUtf8(getFinalOutput(results[results.length - 1].messages) || "(no output)", PER_TASK_OUTPUT_CAP, true) }],
					details: makeDetails("chain")(results),
					usage: nestedUsage(usage) as any,
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					fail(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`, failureDetails("parallel"));
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						usedTools: false,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						fallbackModel,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				const combined = truncateUtf8(`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`, PER_TASK_OUTPUT_CAP, true);
				const usage = results.reduce((total, result) => addUsage(total, result.usage), emptyUsage());
				const details = makeDetails("parallel")(results);
				if (successCount !== results.length) fail(combined, details);
				return {
					content: [{ type: "text", text: combined }],
					details,
					usage: nestedUsage(usage) as any,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					fallbackModel,
				);
				const isError = isFailedResult(result);
				const details = makeDetails("single")([result]);
				if (isError) fail(`Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`, details);
				return {
					content: [{ type: "text", text: truncateUtf8(getFinalOutput(result.messages) || "(no output)", PER_TASK_OUTPUT_CAP, true) }],
					details,
					usage: nestedUsage(result.usage) as any,
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			fail(`Invalid parameters. Available agents: ${available}`, failureDetails("single"));
		},

		renderCall(args, theme, context) {
			if (process.env.PI_FIRSTMATE_ACTIVE === "1") {
				const delegatedAgents = args.agent
					?? args.tasks?.map((task) => task.agent).join(", ")
					?? args.chain?.map((step) => step.agent).join(", ")
					?? "specialist";
				const marker = context.isPartial ? theme.fg("warning", "⏳") : theme.fg("accent", "▶");
				return new Text(`${marker} ${delegatedAgents} working`, 0, 0);
			}
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (process.env.PI_FIRSTMATE_ACTIVE === "1") {
				const details = result.details as SubagentDetails | undefined;
				const failed = details?.results.some(isFailedResult) ?? false;
				const contentText = result.content.find((entry) => entry.type === "text");
				const output = details?.results.map(getResultOutput).filter(Boolean).join("\n\n")
					|| (contentText?.type === "text" ? contentText.text : undefined)
					|| "(no output)";
				const marker = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				return new Text(`${marker} delegated report\n${truncateParallelOutput(output)}`, 0, 0);
			}
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
