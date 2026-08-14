import { describe, expect, it } from "vitest";

import {
  IOSSimulatorScreenMapStore,
  auditIOSSimulatorScreenMap,
  diffIOSSimulatorScreenMaps,
  normalizeIOSSimulatorScreenMap,
} from "./screen-map.js";

describe("normalizeIOSSimulatorScreenMap", () => {
  it("normalizes a nested WDA accessibility tree into bounded stable elements", () => {
    const input = {
      instanceId: "instance-a",
      generation: 4,
      interactionEpoch: 2,
      capturedAt: "2026-07-22T12:00:00.000Z",
      tree: {
        type: "XCUIElementTypeApplication",
        label: "Example",
        enabled: true,
        visible: true,
        rect: { x: 0, y: 0, width: 393, height: 852 },
        children: [
          {
            type: "XCUIElementTypeButton",
            label: "Continue",
            enabled: true,
            visible: true,
            rect: { x: 24, y: 700, width: 345, height: 48 },
          },
          {
            role: "text-field",
            identifier: "email",
            value: "name@example.com",
            frame: { x: 24, y: 160, width: 345, height: 44 },
          },
        ],
      },
    } as const;

    const first = normalizeIOSSimulatorScreenMap(input);
    const second = normalizeIOSSimulatorScreenMap(input);

    expect(first).toMatchObject({
      instanceId: "instance-a",
      generation: 4,
      interactionEpoch: 2,
      capturedAt: input.capturedAt,
      truncated: false,
    });
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(first.elements).toEqual(second.elements);
    expect(first.elements).toEqual([
      expect.objectContaining({
        role: "XCUIElementTypeApplication",
        label: "Example",
        frame: { x: 0, y: 0, width: 393, height: 852 },
      }),
      expect.objectContaining({
        role: "XCUIElementTypeButton",
        label: "Continue",
        enabled: true,
        visible: true,
      }),
      expect.objectContaining({
        role: "text-field",
        label: "email",
        value: "name@example.com",
      }),
    ]);
  });

  it("truncates oversized trees at the requested element bound", () => {
    const screenMap = normalizeIOSSimulatorScreenMap({
      instanceId: "instance-a",
      generation: 1,
      interactionEpoch: 0,
      capturedAt: "2026-07-22T12:00:00.000Z",
      maxElements: 2,
      tree: {
        children: Array.from({ length: 5 }, (_, index) => ({
          type: "XCUIElementTypeButton",
          label: `Button ${index}`,
        })),
      },
    });

    expect(screenMap.elements).toHaveLength(2);
    expect(screenMap.truncated).toBe(true);
  });
});

describe("IOSSimulatorScreenMapStore", () => {
  it("rejects a snapshot after an interaction invalidates it", () => {
    const store = new IOSSimulatorScreenMapStore();
    const screenMap = store.capture({
      instanceId: "instance-a",
      generation: 1,
      capturedAt: "2026-07-22T12:00:00.000Z",
      tree: { type: "XCUIElementTypeButton", label: "Continue" },
    });

    expect(
      store.requireCurrent({
        instanceId: "instance-a",
        generation: 1,
        snapshotId: screenMap.snapshotId,
      }),
    ).toBe(screenMap);

    expect(store.invalidate("instance-a")).toBe(1);
    expect(() =>
      store.requireCurrent({
        instanceId: "instance-a",
        generation: 1,
        snapshotId: screenMap.snapshotId,
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_UI_SNAPSHOT" }));
  });

  it("rejects a snapshot from a previous instance generation", () => {
    const store = new IOSSimulatorScreenMapStore();
    const screenMap = store.capture({
      instanceId: "instance-a",
      generation: 3,
      capturedAt: "2026-07-22T12:00:00.000Z",
      tree: { type: "XCUIElementTypeApplication", label: "Example" },
    });

    expect(() =>
      store.requireCurrent({
        instanceId: "instance-a",
        generation: 4,
        snapshotId: screenMap.snapshotId,
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_UI_SNAPSHOT" }));
  });
});

describe("auditIOSSimulatorScreenMap", () => {
  it("reports bounded high-signal accessibility violations", () => {
    const screenMap = normalizeIOSSimulatorScreenMap({
      instanceId: "instance-a",
      generation: 2,
      interactionEpoch: 0,
      capturedAt: "2026-07-22T12:00:00.000Z",
      tree: {
        children: [
          {
            type: "XCUIElementTypeButton",
            rect: { x: 0, y: 0, width: 0, height: 40 },
          },
          {
            type: "XCUIElementTypeTextField",
            label: "Email",
            rect: { x: 0, y: 0, width: 200, height: 40 },
          },
          {
            type: "XCUIElementTypeLink",
            label: "Hidden link",
            visible: false,
          },
        ],
      },
    });

    expect(auditIOSSimulatorScreenMap(screenMap, 1)).toMatchObject({
      snapshotId: screenMap.snapshotId,
      generation: 2,
      checkedElements: 3,
      violationCount: 2,
      truncated: true,
      violations: [{ code: "missing-label", role: "XCUIElementTypeButton" }],
    });
  });

  it("rejects an invalid violation bound", () => {
    const screenMap = normalizeIOSSimulatorScreenMap({
      instanceId: "instance-a",
      generation: 1,
      interactionEpoch: 0,
      capturedAt: "2026-07-22T12:00:00.000Z",
      tree: { type: "XCUIElementTypeApplication", label: "Example" },
    });

    expect(() => auditIOSSimulatorScreenMap(screenMap, 0)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});

describe("diffIOSSimulatorScreenMaps", () => {
  it("reports added, removed, changed, and unchanged semantic elements", () => {
    const baseline = normalizeIOSSimulatorScreenMap({
      instanceId: "instance-a",
      generation: 1,
      interactionEpoch: 0,
      capturedAt: "2026-07-23T00:00:00.000Z",
      tree: {
        children: [
          {
            type: "button",
            label: "Continue",
            enabled: true,
            rect: { x: 1, y: 2, width: 3, height: 4 },
          },
          {
            type: "staticText",
            label: "Stable",
            rect: { x: 5, y: 6, width: 7, height: 8 },
          },
          {
            type: "staticText",
            label: "Removed",
            rect: { x: 9, y: 10, width: 7, height: 8 },
          },
        ],
      },
    });
    const current = {
      ...baseline,
      snapshotId: "current-snapshot",
      elements: [
        baseline.elements[0]!,
        { ...baseline.elements[1]!, value: "updated" },
        { ...baseline.elements[0]!, elementId: "added", label: "Added" },
      ],
    };
    const diff = diffIOSSimulatorScreenMaps(baseline, current);
    expect(diff).toMatchObject({
      baselineSnapshotId: baseline.snapshotId,
      currentSnapshotId: "current-snapshot",
      unchangedCount: 1,
      added: [{ elementId: "added" }],
      removed: [{ label: "Removed" }],
      changed: [{ elementId: baseline.elements[1]!.elementId }],
      truncated: false,
    });
  });
});
