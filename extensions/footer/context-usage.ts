export interface NativeContextUsage {
  percent?: number | null;
  contextWindow?: number | null;
}

export interface ContextUsageDisplay {
  percent: number | null;
  contextWindow: number;
}

export function resolveContextUsage(
  usage: NativeContextUsage | undefined,
  modelContextWindow: number | undefined,
): ContextUsageDisplay {
  const contextWindow = Number(usage?.contextWindow) || modelContextWindow || 0;
  const percent = typeof usage?.percent === "number" && Number.isFinite(usage.percent)
    ? usage.percent
    : null;
  return { percent, contextWindow };
}
