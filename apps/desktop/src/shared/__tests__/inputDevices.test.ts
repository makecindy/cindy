import { describe, expect, it } from 'vitest';

import {
  INPUT_DEVICE_COMMAND_IDS,
  inputDeviceHasCapability,
  isInputDeviceCommandId,
  normalizeInputDeviceCommandId,
  selectInputDeviceCatalogRows,
} from '../inputDevices';
import {
  WORKLOUDER_CODEX_COMMAND_IDS,
  WORKLOUDER_CODEX_DEVICE,
  WORKLOUDER_CREATOR_MICRO_2_DEVICE,
} from '../workLouderCodex';

describe('input device contract', () => {
  it('offers Send and Steer but accepts Queue only as a legacy Send alias', () => {
    expect(INPUT_DEVICE_COMMAND_IDS).toContain('composer.submit');
    expect(INPUT_DEVICE_COMMAND_IDS).toContain('composer.steer');
    expect(INPUT_DEVICE_COMMAND_IDS).not.toContain('composer.queue');
    expect(isInputDeviceCommandId('composer.queue')).toBe(true);
    expect(normalizeInputDeviceCommandId('composer.queue')).toBe('composer.submit');
    expect(normalizeInputDeviceCommandId('composer.steer')).toBe('composer.steer');
  });

  it('retains old pinned and visible tasks before capping the device publication', () => {
    const recent = Array.from({ length: 100 }, (_, index) => ({
      id: `recent-${index}`,
      pinnedAt: null,
    }));
    const rows = [
      ...recent,
      { id: 'old-pin', pinnedAt: '2026-01-01' },
      { id: 'visible', pinnedAt: null },
    ];
    const result = selectInputDeviceCatalogRows(rows, new Map([['visible', 0]]), 100);
    expect(result).toHaveLength(100);
    expect(result.slice(0, 3).map(({ id }) => id)).toEqual(['visible', 'old-pin', 'recent-0']);
    expect(rows[0].id).toBe('recent-0');
  });
  it('keeps Codex Micro commands on the shared action list', () => {
    expect(WORKLOUDER_CODEX_COMMAND_IDS).toBe(INPUT_DEVICE_COMMAND_IDS);
    expect(isInputDeviceCommandId('forkTask')).toBe(true);
    expect(isInputDeviceCommandId('not-a-command')).toBe(false);
  });

  it('describes Codex Micro as one adapter with its own capabilities', () => {
    expect(WORKLOUDER_CODEX_DEVICE.id).toBe('worklouder-codex-micro');
    expect(inputDeviceHasCapability(WORKLOUDER_CODEX_DEVICE, 'task-slots')).toBe(true);
    expect(inputDeviceHasCapability(WORKLOUDER_CODEX_DEVICE, 'voice')).toBe(true);
    expect(inputDeviceHasCapability(WORKLOUDER_CODEX_DEVICE, 'lighting')).toBe(true);
  });

  it('describes Creator Micro 2 as its own adapter with the same capabilities', () => {
    expect(WORKLOUDER_CREATOR_MICRO_2_DEVICE.id).toBe('worklouder-creator-micro-2');
    expect(WORKLOUDER_CREATOR_MICRO_2_DEVICE.label).toBe('Work Louder Creator Micro 2');
    expect(WORKLOUDER_CREATOR_MICRO_2_DEVICE.capabilities).toBe(
      WORKLOUDER_CODEX_DEVICE.capabilities,
    );
    expect(inputDeviceHasCapability(WORKLOUDER_CREATOR_MICRO_2_DEVICE, 'task-slots')).toBe(true);
  });
});
