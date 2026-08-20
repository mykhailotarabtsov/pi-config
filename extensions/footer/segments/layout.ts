import type { StatusLineSegmentId } from "../types.js";

export interface RenderedFooterSegment {
  id: StatusLineSegmentId;
  content: string;
  width: number;
  visible: boolean;
}

/** Keep at most one separator between visible neighboring segments. */
export function collapseSegmentSeparators(
  segments: RenderedFooterSegment[],
): Array<{ content: string; width: number }> {
  const parts: Array<{ content: string; width: number }> = [];
  let pendingSeparator: { content: string; width: number } | null = null;

  for (const segment of segments) {
    if (segment.id === "separator") {
      if (segment.visible && parts.length > 0) {
        pendingSeparator = { content: segment.content, width: segment.width };
      }
      continue;
    }
    if (!segment.visible || !segment.content) continue;

    if (pendingSeparator) {
      parts.push(pendingSeparator);
      pendingSeparator = null;
    }
    parts.push({ content: segment.content, width: segment.width });
  }

  return parts;
}
