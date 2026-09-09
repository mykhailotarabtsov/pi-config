import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

import type { SegmentContext, StatusLineSegmentId, UsageStats, ToolResultEvent, UserBashEvent } from "./types.js";
import { renderSegment } from "./segments/index.js";
import { collapseSegmentSeparators } from "./segments/layout.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch, onGitBranchChange } from "./git-status.js";
import { getEffectiveConfig } from "./config.js";
import { getIcons } from "./icons.js";
import { getDefaultColors, fg } from "./theme.js";
import { resolveContextUsage } from "./context-usage.js";

const GIT_BRANCH_PATTERNS: RegExp[] = [
  /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
  /\bgit\s+stash\s+(pop|apply)/,
];

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Render visible segments, collapsing separators around hidden segments. */
export function renderSegmentList(
  ctx: SegmentContext,
  segmentIds: StatusLineSegmentId[],
): Array<{ content: string; width: number }> {
  return collapseSegmentSeparators(segmentIds.map(id => ({ id, ...renderSegmentWithWidth(id, ctx) })));
}

/**
 * Build footer content from left and right segments.
 * Left segments are left-aligned, right segments are right-aligned.
 */
function buildFooterContent(
  ctx: SegmentContext,
  leftSegments: StatusLineSegmentId[],
  rightSegments: StatusLineSegmentId[],
  availableWidth: number,
): string {
  const maxContentWidth = Math.max(0, availableWidth - 2);

  // Render left segments
  const leftParts = renderSegmentList(ctx, leftSegments).map(part => part.content);

  // Render right segments
  const rightRendered = renderSegmentList(ctx, rightSegments);
  const rightParts = rightRendered.map(part => part.content);
  let rightWidth = 0;
  for (const part of rightRendered) {
    rightWidth += part.width + 1; // +1 for space between
  }
  if (rightParts.length > 0) {
    rightWidth -= 1; // Remove trailing space
  }

  let leftStr = leftParts.join(" ");
  let rightStr = rightParts.join(" ");

  // Handle case with no right segments
  if (rightParts.length === 0) {
    const finalLeft = truncateToWidth(leftStr, maxContentWidth);
    return " " + finalLeft + " ".repeat(Math.max(0, maxContentWidth - visibleWidth(finalLeft))) + " ";
  }

  // If right side alone is too big, just show right side
  if (rightWidth >= maxContentWidth) {
    return " " + truncateToWidth(rightStr, maxContentWidth) + " ";
  }

  // Ensure at least 1 space between left and right
  const maxLeftWidth = maxContentWidth - rightWidth - 1;
  const finalLeft = truncateToWidth(leftStr, Math.max(0, maxLeftWidth));
  const finalLeftWidth = visibleWidth(finalLeft);

  const padding = maxContentWidth - finalLeftWidth - rightWidth;

  const result = " " + finalLeft + " ".repeat(padding) + rightStr + " ";
  return truncateToWidth(result, availableWidth);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function footer(pi: ExtensionAPI) {
  let sessionStartTime = Date.now();
  let currentCtx: ExtensionContext | null = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let lastBranchKey = "";
  let cachedUsageStats: UsageStats | null = null;
  let tuiRef: TUI | null = null;
  let footerDispose: (() => void) | null = null;
  let branchRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const removeBranchListener = onGitBranchChange(() => tuiRef?.requestRender());

  function scheduleGitRefresh(): void {
    if (branchRefreshTimer) clearTimeout(branchRefreshTimer);
    branchRefreshTimer = setTimeout(() => {
      branchRefreshTimer = null;
      tuiRef?.requestRender();
    }, 100);
  }

  // Track session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    lastBranchKey = "";
    cachedUsageStats = null;
    footerDispose?.();
    footerDispose = null;

    if (ctx.mode === "tui") {
      setupFooter(ctx);
    }
  });

  // Invalidate git status on file changes
  pi.on("tool_result", async (event: ToolResultEvent, _ctx: ExtensionContext) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
      tuiRef?.requestRender();
      scheduleGitRefresh();
    }
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (GIT_BRANCH_PATTERNS.some(p => p.test(cmd))) {
        invalidateGitStatus();
        invalidateGitBranch();
        scheduleGitRefresh();
      }
    }
  });

  // Also catch user escape commands (! prefix)
  pi.on("user_bash", async (event: UserBashEvent, _ctx: ExtensionContext) => {
    if (GIT_BRANCH_PATTERNS.some(p => p.test(event.command))) {
      invalidateGitStatus();
      invalidateGitBranch();
      // This render starts the async branch lookup; the listener above also
      // requests a render when that lookup actually completes.
      tuiRef?.requestRender();
      scheduleGitRefresh();
    }
  });

  pi.on("session_shutdown", async () => {
    footerDispose?.();
    footerDispose = null;
    if (branchRefreshTimer) clearTimeout(branchRefreshTimer);
    branchRefreshTimer = null;
    removeBranchListener();
    currentCtx = null;
    footerDataRef = null;
    tuiRef = null;
    cachedUsageStats = null;
    lastBranchKey = "";
  });

  function buildSegmentContext(ctx: ExtensionContext, width: number, theme: Theme): SegmentContext {
    const effectiveConfig = getEffectiveConfig();
    const colors = effectiveConfig.colors ?? getDefaultColors();

    const branch = (ctx.sessionManager?.getBranch?.() ?? []) as any[];
    const usageOf = (value: any): UsageStats | null => {
      if (!value || typeof value !== "object") return null;
      const input = Number(value.input) || 0;
      const output = Number(value.output) || 0;
      const cacheRead = Number(value.cacheRead) || 0;
      const cacheWrite = Number(value.cacheWrite) || 0;
      const cost = Number(value.cost?.total) || 0;
      if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) return null;
      return { input, output, cacheRead, cacheWrite, cost };
    };
    const usageKey = (value: any): string => {
      const usage = usageOf(value);
      return usage ? Object.values(usage).join(",") : "";
    };
    const branchKey = branch.map((entry: any) => {
      const message = entry.type === "message" ? entry.message : undefined;
      return [entry.id ?? "", entry.type, message?.role ?? "", message?.stopReason ?? "", entry.thinkingLevel ?? "", usageKey(message?.usage ?? entry.usage)].join(":");
    }).join("|");

    // Cache by branch content, not length: streamed/finalized entries can change
    // without adding a new entry, and tool/compaction usage lives on other types.
    let usageStats: UsageStats;
    if (cachedUsageStats && branchKey === lastBranchKey) {
      usageStats = cachedUsageStats;
    } else {
      usageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      for (const entry of branch as any[]) {
        const message = entry.type === "message" ? entry.message : undefined;
        const usage = usageOf(message?.usage ?? entry.usage);
        if (!usage) continue;
        usageStats.input += usage.input;
        usageStats.output += usage.output;
        usageStats.cacheRead += usage.cacheRead;
        usageStats.cacheWrite += usage.cacheWrite;
        usageStats.cost += usage.cost;
      }
      cachedUsageStats = usageStats;
      lastBranchKey = branchKey;
    }

    // Pi's live context usage includes the current turn and is more accurate
    // than deriving context size from the last completed assistant message.
    const contextUsage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const { percent: contextPercent, contextWindow } = resolveContextUsage(
      contextUsage,
      ctx.model?.contextWindow,
    );

    // Get git status (cached)
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch);

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    const isLocalModel = /localhost|127\.0\.0\.1|::1/.test((ctx.model as any)?.baseUrl ?? "");

    return {
      model: ctx.model,
      isLocalModel,
      thinkingLevel: ctx.thinkingLevel || pi.getThinkingLevel(),
      sessionId: ctx.sessionManager?.getSessionId?.(),
      usageStats,
      contextPercent,
      contextWindow,
      usingSubscription,
      sessionStartTime,
      git: gitStatus,
      options: effectiveConfig.segmentOptions ?? {},
      width,
      theme,
      colors,
      icons: getIcons(effectiveConfig.icons),
    };
  }

  function setupFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;

      const globals = globalThis as Record<string, unknown>;
      const previousRenderHook = globals.__footerRequestRender;
      const requestRender = () => tui.requestRender();
      globals.__footerRequestRender = requestRender;
      const unsub = footerData.onBranchChange(() => {
        cachedUsageStats = null;
        lastBranchKey = "";
        requestRender();
      });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsub?.();
        if (globals.__footerRequestRender === requestRender) {
          if (previousRenderHook === undefined) delete globals.__footerRequestRender;
          else globals.__footerRequestRender = previousRenderHook;
        }
        if (footerDataRef === footerData) footerDataRef = null;
        if (tuiRef === tui) tuiRef = null;
        if (footerDispose === dispose) footerDispose = null;
      };
      footerDispose = dispose;

      return {
        dispose,
        invalidate() {},
        render(width: number): string[] {
          if (!currentCtx) return [];

          const effectiveConfig = getEffectiveConfig();
          let segmentCtx;
          try {
            segmentCtx = buildSegmentContext(currentCtx, width, theme);
          } catch {
            return [];
          }

          const row1 = buildFooterContent(
            segmentCtx,
            effectiveConfig.row1LeftSegments,
            effectiveConfig.row1RightSegments,
            width,
          );
          const row2 = buildFooterContent(
            segmentCtx,
            effectiveConfig.row2LeftSegments,
            effectiveConfig.row2RightSegments,
            width,
          );

          const divider = fg(theme, "separator", "─".repeat(width), segmentCtx.colors);

          return ["", row1, divider, row2];
        },
      };
    });
  }
}
