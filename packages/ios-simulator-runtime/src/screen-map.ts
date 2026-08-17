import { createHash, randomUUID } from "node:crypto";

import { IOSSimulatorInstanceError } from "./instance-errors.js";

export interface IOSSimulatorScreenElement {
  elementId: string;
  role: string;
  label: string | null;
  value: string | null;
  enabled: boolean | null;
  visible: boolean | null;
  frame: { x: number; y: number; width: number; height: number } | null;
}

export interface IOSSimulatorScreenMap {
  snapshotId: string;
  instanceId: string;
  generation: number;
  interactionEpoch: number;
  capturedAt: string;
  truncated: boolean;
  elements: IOSSimulatorScreenElement[];
}

export type IOSSimulatorAccessibilityViolationCode =
  "missing-label" | "missing-frame" | "invalid-frame";

export interface IOSSimulatorAccessibilityViolation {
  code: IOSSimulatorAccessibilityViolationCode;
  elementId: string;
  role: string;
  label: string | null;
  message: string;
}

export interface IOSSimulatorAccessibilityAudit {
  snapshotId: string;
  generation: number;
  checkedElements: number;
  violationCount: number;
  truncated: boolean;
  violations: IOSSimulatorAccessibilityViolation[];
}

export interface IOSSimulatorScreenMapDiff {
  baselineSnapshotId: string;
  currentSnapshotId: string;
  baselineGeneration: number;
  currentGeneration: number;
  added: IOSSimulatorScreenElement[];
  removed: IOSSimulatorScreenElement[];
  changed: Array<{
    elementId: string;
    before: IOSSimulatorScreenElement;
    after: IOSSimulatorScreenElement;
  }>;
  unchangedCount: number;
  truncated: boolean;
}

/**
 * Compare two bounded accessibility screen maps without touching simulator state.
 * This is a semantic visual-diff primitive; pixel-level image diff remains a
 * separate media concern because transient frames must not enter diagnostics.
 */
export function diffIOSSimulatorScreenMaps(
  baseline: IOSSimulatorScreenMap,
  current: IOSSimulatorScreenMap,
  maxChanges = 500,
): IOSSimulatorScreenMapDiff {
  if (!Number.isSafeInteger(maxChanges) || maxChanges <= 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "maxChanges must be a positive integer",
    );
  }
  const beforeById = new Map(
    baseline.elements.map((element) => [element.elementId, element]),
  );
  const afterById = new Map(
    current.elements.map((element) => [element.elementId, element]),
  );
  const added: IOSSimulatorScreenElement[] = [];
  const removed: IOSSimulatorScreenElement[] = [];
  const changed: IOSSimulatorScreenMapDiff["changed"] = [];
  let unchangedCount = 0;
  for (const [elementId, before] of beforeById) {
    const after = afterById.get(elementId);
    if (!after) {
      removed.push(before);
      continue;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) {
      unchangedCount += 1;
    } else {
      changed.push({ elementId, before, after });
    }
  }
  for (const [elementId, after] of afterById) {
    if (!beforeById.has(elementId)) added.push(after);
  }
  const totalChanges = added.length + removed.length + changed.length;
  let remaining = maxChanges;
  const boundedAdded = added.slice(0, remaining);
  remaining -= boundedAdded.length;
  const boundedRemoved = removed.slice(0, remaining);
  remaining -= boundedRemoved.length;
  const boundedChanged = changed.slice(0, remaining);
  return {
    baselineSnapshotId: baseline.snapshotId,
    currentSnapshotId: current.snapshotId,
    baselineGeneration: baseline.generation,
    currentGeneration: current.generation,
    added: boundedAdded,
    removed: boundedRemoved,
    changed: boundedChanged,
    unchangedCount,
    truncated: totalChanges > maxChanges,
  };
}

const INTERACTIVE_ROLE_PATTERN =
  /button|cell|checkbox|link|menuitem|picker|radio|slider|stepper|switch|tab|textfield|text field/i;

/**
 * Run a deterministic, bounded audit over the normalized accessibility tree.
 * It intentionally reports only high-signal issues that can be inferred from
 * WDA metadata; product-specific contrast and localization checks stay outside
 * the simulator host.
 */
export function auditIOSSimulatorScreenMap(
  screenMap: IOSSimulatorScreenMap,
  maxViolations = 200,
): IOSSimulatorAccessibilityAudit {
  if (!Number.isSafeInteger(maxViolations) || maxViolations <= 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "maxViolations must be a positive integer",
    );
  }
  const violations: IOSSimulatorAccessibilityViolation[] = [];
  for (const element of screenMap.elements) {
    if (element.visible === false) continue;
    const interactive = INTERACTIVE_ROLE_PATTERN.test(element.role);
    if (interactive && !element.label && !element.value) {
      violations.push({
        code: "missing-label",
        elementId: element.elementId,
        role: element.role,
        label: element.label,
        message: "Interactive element has no accessible label or value.",
      });
    }
    if (!interactive) continue;
    if (!element.frame) {
      violations.push({
        code: "missing-frame",
        elementId: element.elementId,
        role: element.role,
        label: element.label,
        message: "Interactive element has no usable accessibility frame.",
      });
      continue;
    }
    if (element.frame.width <= 0 || element.frame.height <= 0) {
      violations.push({
        code: "invalid-frame",
        elementId: element.elementId,
        role: element.role,
        label: element.label,
        message: "Interactive element has a non-positive accessibility frame.",
      });
    }
  }
  return {
    snapshotId: screenMap.snapshotId,
    generation: screenMap.generation,
    checkedElements: screenMap.elements.length,
    violationCount: violations.length,
    truncated: violations.length > maxViolations,
    violations: violations.slice(0, maxViolations),
  };
}

interface ScreenMapState {
  interactionEpoch: number;
  current: IOSSimulatorScreenMap | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frame(value: unknown): IOSSimulatorScreenElement["frame"] {
  const candidate = record(value);
  if (!candidate) return null;
  const x = finite(candidate.x);
  const y = finite(candidate.y);
  const width = finite(candidate.width);
  const height = finite(candidate.height);
  if (x === null || y === null || width === null || height === null)
    return null;
  return { x, y, width, height };
}

/** Bounded, accessibility-first screen map that drops driver-only noise. */
export function normalizeIOSSimulatorScreenMap(input: {
  instanceId: string;
  generation: number;
  interactionEpoch: number;
  capturedAt: string;
  tree: unknown;
  maxElements?: number;
}): IOSSimulatorScreenMap {
  const maxElements = input.maxElements ?? 1_500;
  if (!Number.isSafeInteger(maxElements) || maxElements <= 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "maxElements must be a positive integer",
    );
  }
  const elements: IOSSimulatorScreenElement[] = [];
  const queue: Array<{ value: unknown; path: string }> = [
    { value: input.tree, path: "0" },
  ];
  let visited = 0;
  let truncated = false;
  while (queue.length > 0 && elements.length < maxElements) {
    const entry = queue.shift()!;
    visited += 1;
    if (visited > maxElements * 4) {
      truncated = true;
      break;
    }
    if (Array.isArray(entry.value)) {
      truncated ||= entry.value.length > maxElements;
      entry.value.slice(0, maxElements).forEach((child, index) => {
        queue.push({ value: child, path: `${entry.path}.${index}` });
      });
      continue;
    }
    const node = record(entry.value);
    if (!node) continue;
    const role =
      text(node.type) ?? text(node.role) ?? text(node.class) ?? "element";
    const label = text(node.label) ?? text(node.name) ?? text(node.identifier);
    const value = text(node.value);
    const nodeFrame = frame(node.rect) ?? frame(node.frame);
    if (label || value || nodeFrame) {
      const elementId = createHash("sha256")
        .update(
          `${entry.path}\0${role}\0${label ?? ""}\0${JSON.stringify(nodeFrame)}`,
        )
        .digest("hex")
        .slice(0, 20);
      elements.push({
        elementId,
        role,
        label,
        value,
        enabled: boolean(node.enabled),
        visible: boolean(node.visible),
        frame: nodeFrame,
      });
    }
    const children = node.children ?? node.elements;
    if (Array.isArray(children)) {
      truncated ||= children.length > maxElements;
      children.slice(0, maxElements).forEach((child, index) => {
        queue.push({ value: child, path: `${entry.path}.${index}` });
      });
    }
  }
  return {
    snapshotId: randomUUID(),
    instanceId: input.instanceId,
    generation: input.generation,
    interactionEpoch: input.interactionEpoch,
    capturedAt: input.capturedAt,
    truncated: truncated || queue.length > 0,
    elements,
  };
}

/** Tracks stale-snapshot and interaction-epoch invalidation per instance. */
export class IOSSimulatorScreenMapStore {
  readonly #state = new Map<string, ScreenMapState>();

  current(instanceId: string): IOSSimulatorScreenMap | null {
    return this.#state.get(instanceId)?.current ?? null;
  }

  currentEpoch(instanceId: string): number {
    return this.#state.get(instanceId)?.interactionEpoch ?? 0;
  }

  capture(input: {
    instanceId: string;
    generation: number;
    capturedAt: string;
    tree: unknown;
  }): IOSSimulatorScreenMap {
    const state = this.#state.get(input.instanceId) ?? {
      interactionEpoch: 0,
      current: null,
    };
    const current = normalizeIOSSimulatorScreenMap({
      ...input,
      interactionEpoch: state.interactionEpoch,
    });
    this.#state.set(input.instanceId, { ...state, current });
    return current;
  }

  requireCurrent(input: {
    instanceId: string;
    generation: number;
    snapshotId: string;
  }): IOSSimulatorScreenMap {
    const current = this.#state.get(input.instanceId)?.current;
    if (
      !current ||
      current.snapshotId !== input.snapshotId ||
      current.generation !== input.generation
    ) {
      throw new IOSSimulatorInstanceError(
        "STALE_UI_SNAPSHOT",
        "The UI changed. Read a new screen map before interacting.",
        true,
      );
    }
    return current;
  }

  invalidate(instanceId: string): number {
    const state = this.#state.get(instanceId) ?? {
      interactionEpoch: 0,
      current: null,
    };
    const interactionEpoch = state.interactionEpoch + 1;
    this.#state.set(instanceId, { interactionEpoch, current: null });
    return interactionEpoch;
  }

  clear(instanceId: string): void {
    this.#state.delete(instanceId);
  }
}
