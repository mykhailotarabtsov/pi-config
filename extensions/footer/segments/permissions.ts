import type { RenderedSegment, SegmentContext } from "../types.js";
import { applyColor } from "../theme.ts";

interface PermissionGateState {
  safeOperationsEnabled?: unknown;
}

function readPermissionGateState(): PermissionGateState | undefined {
  return (globalThis as Record<string, unknown>).__permissionGate as PermissionGateState | undefined;
}

export const permissionsSegment = {
  id: "permissions" as const,
  render(ctx: SegmentContext): RenderedSegment {
    const safeOperationsEnabled = readPermissionGateState()?.safeOperationsEnabled === true;
    const label = applyColor(ctx.theme, "dim", "Permissions:");
    const value = safeOperationsEnabled
      ? applyColor(ctx.theme, "success", "SAFE")
      : applyColor(ctx.theme, ctx.colors.modeIndicator ?? "muted", "GUARDED");

    return { content: `${label} ${value}`, visible: true };
  },
};
