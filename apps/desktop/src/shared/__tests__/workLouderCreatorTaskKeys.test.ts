import { describe, expect, it } from 'vitest';

import {
  WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  addWorkLouderMerge,
  assignCreatorHidCodes,
  buildCreatorMicro2AgentKeymap,
  normalizeWorkLouderCreatorTaskKeys,
  normalizeWorkLouderMerges,
  resolveCreatorHidRole,
  resolveWorkLouderHidRole,
  workLouderAvailableMergeDirections,
  workLouderMergeNeighbor,
  workLouderShouldMuteKeyZone,
  workLouderTaskKeysForLayout,
} from '../workLouderCodex';

describe('Creator Micro 2 task keys', () => {
  it('drops split microphone keys when the board uses a merged mic cap', () => {
    expect(
      workLouderTaskKeysForLayout({
        taskKeys: ['AG00', 'ACT10', 'ACT12'],
        separateMicrophoneKeys: false,
      }),
    ).toEqual(['AG00', 'ACT12']);
  });

  it('defaults to the six original agent positions', () => {
    expect(normalizeWorkLouderCreatorTaskKeys(undefined)).toEqual([
      ...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS,
    ]);
  });

  it('keeps board order and drops duplicates', () => {
    expect(normalizeWorkLouderCreatorTaskKeys(['ACT12', 'AG00', 'AG00', 'nope'])).toEqual([
      'AG00',
      'ACT12',
    ]);
  });

  it('assigns AG codes in board order so lighting follows the task keys', () => {
    const taskKeys = ['ACT06', 'ACT07', 'AG00'] as const;
    const hid = assignCreatorHidCodes(taskKeys);
    // Board order among the three: AG00, then ACT06, then ACT07.
    expect(hid.get('AG00')).toBe('AG00');
    expect(hid.get('ACT06')).toBe('AG01');
    expect(hid.get('ACT07')).toBe('AG02');
    expect(hid.get('AG01')).toBe('ACT06');
    expect(resolveCreatorHidRole('AG00', taskKeys)).toEqual({
      role: 'task',
      slot: 0,
      physical: 'AG00',
    });
    expect(resolveCreatorHidRole('AG01', taskKeys)).toEqual({
      role: 'task',
      slot: 1,
      physical: 'ACT06',
    });
    expect(resolveCreatorHidRole('ACT06', taskKeys)).toEqual({
      role: 'command',
      physical: 'AG01',
    });
  });

  it('keeps Codex factory HID codes as physical keys', () => {
    const taskKeys = ['ACT06'] as const;
    expect(resolveWorkLouderHidRole('ACT06', taskKeys, 'codex-micro')).toEqual({
      role: 'task',
      slot: 0,
      physical: 'ACT06',
    });
    expect(resolveWorkLouderHidRole('AG00', taskKeys, 'codex-micro')).toEqual({
      role: 'command',
      physical: 'AG00',
    });
    expect(resolveWorkLouderHidRole('AG00', taskKeys, 'creator-micro-2')).toEqual({
      role: 'task',
      slot: 0,
      physical: 'ACT06',
    });
  });

  it('lets leftover AG codes sit on extra command keys when there are fewer than six tasks', () => {
    const hid = assignCreatorHidCodes(['AG00']);
    expect(hid.get('AG00')).toBe('AG00');
    expect(hid.get('AG01')).toBe('ACT06');
    expect([...hid.values()]).toHaveLength(WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.length);
    expect(new Set(hid.values()).size).toBe(WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.length);
  });

  it('still treats leftover AG06 HID as the seventh task key', () => {
    const taskKeys = [...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS, 'ACT06'] as const;
    expect(resolveCreatorHidRole('AG06', taskKeys)).toEqual({
      role: 'task',
      slot: 6,
      physical: 'ACT06',
    });
  });

  it('puts extra task keys on ACT HID so firmware-unknown AG06+ is never required', () => {
    const taskKeys = [...WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS];
    const hid = assignCreatorHidCodes(taskKeys);
    expect(hid.get('AG00')).toBe('AG00');
    expect(hid.get('AG05')).toBe('AG05');
    expect(hid.get('ACT06')).toBe('ACT06');
    expect(hid.get('ACT12')).toBe('ACT12');
    expect(resolveCreatorHidRole('ACT06', taskKeys)).toEqual({
      role: 'task',
      slot: 6,
      physical: 'ACT06',
    });
    expect(resolveCreatorHidRole('ACT12', taskKeys)).toEqual({
      role: 'task',
      slot: 12,
      physical: 'ACT12',
    });
  });

  it('keeps the original six AG codes and rides ACT HID for a seventh task key', () => {
    const taskKeys = [...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS, 'ACT06'] as const;
    const hid = assignCreatorHidCodes(taskKeys);
    expect(hid.get('AG00')).toBe('AG00');
    expect(hid.get('ACT06')).toBe('ACT06');
    expect(resolveCreatorHidRole('ACT06', taskKeys)).toEqual({
      role: 'task',
      slot: 6,
      physical: 'ACT06',
    });
  });

  it('builds the default keymap in the firmware row shape', () => {
    expect(buildCreatorMicro2AgentKeymap()).toEqual([
      ['KV_OAI_AG00', 'KV_OAI_AG01'],
      ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
      ['KV_OAI_ACT06', 'KV_OAI_ACT07', 'KV_OAI_ACT08', 'KV_OAI_ACT09'],
      ['KV_OAI_ACT10', 'KV_OAI_ACT11', 'KV_OAI_ACT12'],
    ]);
  });

  it('lists right and down neighbors on the 4×4 board', () => {
    expect(workLouderMergeNeighbor('ACT10', 'right')).toBe('ACT11');
    expect(workLouderMergeNeighbor('ACT10', 'down')).toBeNull();
    expect(workLouderMergeNeighbor('AG03', 'right')).toBe('AG04');
    expect(workLouderMergeNeighbor('AG03', 'down')).toBe('ACT07');
    expect(workLouderMergeNeighbor('AG00', 'down')).toBe('AG03');
    expect(workLouderMergeNeighbor('ACT12', 'right')).toBeNull();
    expect(workLouderMergeNeighbor('ACT06', 'down')).toBeNull();
  });

  it('strips both switches of a 2U merge from the task-key set', () => {
    expect(
      workLouderTaskKeysForLayout({
        taskKeys: ['AG00', 'ACT10', 'ACT11', 'ACT12'],
        separateMicrophoneKeys: true,
        merges: [{ origin: 'AG00', cover: 'AG01' }],
      }),
    ).toEqual(['ACT10', 'ACT11', 'ACT12']);
  });

  it('drops overlapping merges and keeps ACT10+ACT11 from the legacy mic flag', () => {
    expect(
      normalizeWorkLouderMerges([
        { origin: 'AG02', cover: 'AG03' },
        { origin: 'AG03', cover: 'AG04' },
        { origin: 'ACT06', cover: 'ACT12' },
      ]),
    ).toEqual([{ origin: 'AG02', cover: 'AG03' }]);
    expect(addWorkLouderMerge([], 'ACT07', 'down')).toEqual([
      { origin: 'ACT07', cover: 'ACT10' },
    ]);
    expect(workLouderAvailableMergeDirections([], 'AG00')).toEqual(['right', 'down']);
    expect(workLouderAvailableMergeDirections([], 'ACT12')).toEqual([]);
  });

  it('mutes the shared keys zone when a firmware AG key is no longer a task key', () => {
    expect(workLouderShouldMuteKeyZone([...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS])).toBe(false);
    expect(
      workLouderShouldMuteKeyZone(['AG01', 'AG02', 'AG03', 'AG04', 'AG05', 'ACT07']),
    ).toBe(true);
    expect(
      workLouderShouldMuteKeyZone([...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS, 'ACT06']),
    ).toBe(true);
  });
});
