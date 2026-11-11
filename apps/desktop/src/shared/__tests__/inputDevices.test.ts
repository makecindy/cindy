import { describe, expect, it } from 'vitest';

import {
  INPUT_DEVICE_COMMAND_IDS,
  inputDeviceHasCapability,
  isInputDeviceCommandId,
} from '../inputDevices';
import {
  WORKLOUDER_CODEX_COMMAND_IDS,
  WORKLOUDER_CODEX_DEVICE,
  WORKLOUDER_CREATOR_MICRO_2_DEVICE,
} from '../workLouderCodex';

describe('input device contract', () => {
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
    expect(WORKLOUDER_CREATOR_MICRO_2_DEVICE.capabilities).toBe(WORKLOUDER_CODEX_DEVICE.capabilities);
    expect(inputDeviceHasCapability(WORKLOUDER_CREATOR_MICRO_2_DEVICE, 'task-slots')).toBe(true);
  });
});
