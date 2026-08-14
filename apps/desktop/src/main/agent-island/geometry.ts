import {
  AGENT_ISLAND_CARRIER_COMPACT_INSET,
  AGENT_ISLAND_CARRIER_EXPANDED_INSET,
  AGENT_ISLAND_COMPACT_IDLE_WIDTH,
  AGENT_ISLAND_MAX_EXPANDED_HEIGHT,
  AGENT_ISLAND_MAX_EXPANDED_WIDTH,
  AGENT_ISLAND_MAX_RESIZABLE_WIDTH,
  AGENT_ISLAND_MIN_EXPANDED_WIDTH,
  AGENT_ISLAND_SCREEN_EDGE_GUTTER,
} from '../../shared/agentIsland.js';

interface DisplayLike {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface RectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentIslandDisplayIdentity {
  displayName?: string | null;
  displayIndex?: number | null;
  displayInternal?: boolean | null;
  displayBounds?: RectangleLike | null;
}

export interface AgentIslandGeometryPreference {
  centerXRatio?: number | null;
  contentWidth?: number | null;
  defaultContentWidth?: number | null;
  minimumContentWidth?: number | null;
  expandedClampContentWidth?: number | null;
}

export interface AgentIslandLayoutPreference extends AgentIslandDisplayIdentity {
  displayId?: number | null;
  centerXRatio?: number | null;
  compactContentWidth?: number | null;
  expandedContentWidth?: number | null;
}

export function computeAgentIslandCarrierSize(
  display: DisplayLike,
  expanded: boolean,
  contentHeight = AGENT_ISLAND_MAX_EXPANDED_HEIGHT,
  preferredContentWidth?: number | null,
  defaultContentWidth = AGENT_ISLAND_MAX_EXPANDED_WIDTH,
  minimumContentWidth?: number | null,
): { width: number; height: number; inset: number; contentWidth: number } {
  const inset = expanded ? AGENT_ISLAND_CARRIER_EXPANDED_INSET : AGENT_ISLAND_CARRIER_COMPACT_INSET;
  const availableContentWidth = Math.min(
    Math.max(0, display.bounds.width - AGENT_ISLAND_SCREEN_EDGE_GUTTER),
    AGENT_ISLAND_MAX_RESIZABLE_WIDTH,
  );
  const minWidth = Number.isFinite(minimumContentWidth)
    ? Number(minimumContentWidth)
    : (expanded ? AGENT_ISLAND_MIN_EXPANDED_WIDTH : AGENT_ISLAND_COMPACT_IDLE_WIDTH);
  const minContentWidth = Math.min(minWidth, availableContentWidth);
  const desiredContentWidth = Number.isFinite(preferredContentWidth)
    ? Number(preferredContentWidth)
    : Math.min(availableContentWidth, defaultContentWidth);
  const contentWidth = clamp(desiredContentWidth, minContentWidth, availableContentWidth);
  return {
    width: Math.round(contentWidth + inset * 2),
    height: Math.round(Math.max(1, contentHeight) + inset),
    inset,
    contentWidth,
  };
}

export function computeAgentIslandWindowBounds(
  display: DisplayLike,
  expanded: boolean | ({ expanded: boolean; contentHeight?: number } & AgentIslandGeometryPreference) = false,
): RectangleLike {
  const input = typeof expanded === 'boolean' ? { expanded } : expanded;
  const size = computeAgentIslandCarrierSize(
    display,
    input.expanded,
    input.contentHeight,
    input.contentWidth,
    input.defaultContentWidth ?? AGENT_ISLAND_MAX_EXPANDED_WIDTH,
    input.minimumContentWidth,
  );
  const expandedSize = computeAgentIslandCarrierSize(
    display,
    true,
    input.contentHeight,
    input.expandedClampContentWidth ?? input.contentWidth,
    input.defaultContentWidth ?? AGENT_ISLAND_MAX_EXPANDED_WIDTH,
    input.minimumContentWidth,
  );
  const centerX = clampCenterX(display, input.centerXRatio, expandedSize.width);
  return {
    x: Math.round(centerX - size.width / 2),
    y: display.bounds.y,
    width: size.width,
    height: size.height,
  };
}

function clampCenterX(
  display: DisplayLike,
  centerXRatio: number | null | undefined,
  expandedCarrierWidth: number,
): number {
  const fallbackCenter = display.bounds.x + display.bounds.width / 2;
  const ratio = Number.isFinite(centerXRatio) ? Number(centerXRatio) : 0.5;
  const desiredCenter = display.bounds.x + display.bounds.width * clamp(ratio, 0, 1);
  const minCenter = display.bounds.x + expandedCarrierWidth / 2;
  const maxCenter = display.bounds.x + display.bounds.width - expandedCarrierWidth / 2;
  if (minCenter > maxCenter) return fallbackCenter;
  return clamp(desiredCenter, minCenter, maxCenter);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}
