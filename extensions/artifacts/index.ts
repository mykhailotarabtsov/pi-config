import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { artifactUrl, displayArtifactUrl, isRunning, markArtifactTrusted, notifyReload, runningPort, stopServer } from "./server.js";
import { MAX_ARTIFACT_BYTES, MAX_INPUT_BYTES } from "./config.js";
import { artifactExists, artifactPath, isSafeSlug, listArtifacts, openInBrowser, readInputFile, slugify, writeArtifact } from "./utils.js";
import { renderHtmlDocument, renderMarkdownDocument } from "./templates.js";
import { artifactErrorMessage } from "./errors.js";

interface ArtifactDetails {
  action: string;
  slug?: string;
  title?: string;
  kind?: "markdown" | "html";
  url?: string;
  absPath?: string;
}

class ArtifactToolError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: ArtifactDetails) {
    super(message);
    this.name = "ArtifactToolError";
    this.details = { ...details };
  }
}

export default function artifacts(pi: ExtensionAPI) {
  const pendingErrorDetails = new Map<string, Record<string, unknown>>();

  function fail(toolCallId: string, message: string, details: ArtifactDetails = {}): never {
    const error = new ArtifactToolError(message, details);
    pendingErrorDetails.set(toolCallId, error.details);
    throw error;
  }

  // Pi marks thrown tool errors as isError. Preserve the structured artifact
  // details for renderers and callers through the supported result middleware.
  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "artifact" || !event.isError) return;
    const details = pendingErrorDetails.get(event.toolCallId);
    pendingErrorDetails.delete(event.toolCallId);
    return details ? { details } : undefined;
  });

  pi.on("session_shutdown", () => {
    pendingErrorDetails.clear();
    stopServer();
  });

  pi.registerCommand("artifacts", {
    description: "Open the local artifacts index in a browser",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify?.("Artifacts require an interactive browser session", "warning");
        return;
      }
      const privateUrl = await artifactUrl();
      const url = displayArtifactUrl();
      if (!url) return;
      openInBrowser(privateUrl);
      ctx.ui.notify(`Artifacts: ${url}`, "info");
    },
  });

  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description: "Create safe browser artifacts from Markdown or sanitized static HTML. Supports reports, tables, code, diffs, and optional Mermaid diagrams. Files are stored under .pi/artifacts and served through a token-protected localhost server.",
    promptSnippet: "Emit visual output (reports, diagrams, rendered diffs, tables) as a browser artifact instead of terminal text",
    parameters: Type.Object({
      action: StringEnum(["create", "update", "open", "list"] as const),
      title: Type.Optional(Type.String({ description: "Artifact title; slug is derived from it." })),
      kind: Type.Optional(StringEnum(["markdown", "html"] as const)),
      content: Type.Optional(Type.String({ description: "Inline Markdown or static HTML fragment." })),
      path: Type.Optional(Type.String({ description: "Optional relative path to a regular, non-sensitive UTF-8 file inside the project. Absolute paths, symlinks, and traversal are rejected." })),
      open: Type.Optional(Type.Boolean({ description: "Open in the browser after create/update. Disabled automatically without interactive UI." })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;
      if (action === "list") {
        const entries = listArtifacts();
        const port = runningPort();
        const text = entries.length === 0
          ? "No artifacts in .pi/artifacts/ yet."
          : `${entries.length} artifact(s):\n\n${entries.map((entry) => `- ${entry.title} [${entry.kind}] ${entry.slug}${port ? `  http://127.0.0.1:${port}/...` : ""}\n  ${entry.absPath}`).join("\n")}`;
        return { content: [{ type: "text" as const, text }], details: { action, count: entries.length, serverRunning: port !== null } as Record<string, unknown> };
      }

      const title = params.title?.trim();
      if (!title) fail(toolCallId, "`title` is required for create, update, and open.", { action });
      if (title.length > 200) fail(toolCallId, "`title` must be 200 characters or fewer.", { action });
      const slug = slugify(title);
      if (!isSafeSlug(slug)) fail(toolCallId, `derived slug "${slug}" is invalid.`, { action, title, slug });
      let absPath: string;
      try {
        absPath = artifactPath(slug);
      } catch (error) {
        fail(toolCallId, artifactErrorMessage(error, "could not access artifact storage"), { action, title, slug });
      }

      if (action === "open") {
        if (!artifactExists(slug)) fail(toolCallId, `no artifact with slug "${slug}" — create it first.`, { action, title, slug, absPath });
        if (!ctx.hasUI) return { content: [{ type: "text" as const, text: `Artifact available at ${absPath}; browser opening requires interactive UI.` }], details: { action, title, slug, absPath } as Record<string, unknown> };
        const privateUrl = await artifactUrl(slug);
        const url = displayArtifactUrl(slug);
        if (!url) fail(toolCallId, "artifact server is unavailable", { action, title, slug, absPath });
        openInBrowser(privateUrl);
        return { content: [{ type: "text" as const, text: `Opened ${title}\n${url} (session-local; browser cookie required)\n${absPath}` }], details: { action, title, slug, url, absPath } as Record<string, unknown> };
      }

      const exists = artifactExists(slug);
      if (action === "create" && exists) fail(toolCallId, `an artifact with slug "${slug}" already exists — use update instead.`, { action, title, slug, absPath });
      if (action === "update" && !exists) fail(toolCallId, `no artifact with slug "${slug}" — create it first.`, { action, title, slug, absPath });
      if (!params.kind) fail(toolCallId, "`kind` (markdown or html) is required for create/update.", { action, title, slug, absPath });
      const resolved = params.content != null
        ? { content: params.content }
        : params.path
          ? readInputFile(params.path, ctx.cwd)
          : { error: "provide `content` or `path` for create/update." };
      if ("error" in resolved) fail(toolCallId, resolved.error, { action, title, slug, kind: params.kind, absPath });
      if (Buffer.byteLength(resolved.content, "utf8") > MAX_INPUT_BYTES) fail(toolCallId, "content exceeds the 2 MB limit.", { action, title, slug, kind: params.kind, absPath });

      let html: string;
      try {
        html = params.kind === "html"
          ? renderHtmlDocument(title, slug, resolved.content)
          : renderMarkdownDocument(title, slug, resolved.content);
        if (Buffer.byteLength(html, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("rendered artifact exceeds the 16 MB limit");
        writeArtifact(slug, html);
        markArtifactTrusted(slug, html);
      } catch (error) {
        fail(toolCallId, artifactErrorMessage(error, "could not render or write artifact"), { action, title, slug, kind: params.kind, absPath });
      }

      notifyReload(slug);
      const shouldOpen = params.open ?? action === "create";
      const privateUrl = shouldOpen && ctx.hasUI
        ? await artifactUrl(slug)
        : isRunning() ? await artifactUrl(slug) : undefined;
      const url = displayArtifactUrl(slug);
      if (privateUrl && shouldOpen && ctx.hasUI) openInBrowser(privateUrl);
      const verb = action === "create" ? "Created" : "Updated";
      return {
        content: [{ type: "text" as const, text: `${verb} ${title} [${params.kind}]\n${url ? `${url} (session-local; use action: open to bootstrap the browser)` : "(server not running — use action: open to view)"}\n${absPath}` }],
        details: { action, title, slug, kind: params.kind, url, absPath } as Record<string, unknown>,
      };
    },
  });
}
