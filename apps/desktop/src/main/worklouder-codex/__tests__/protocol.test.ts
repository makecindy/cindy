import { describe, expect, it } from 'vitest';

import {
  applyWorkLouderCodexLightingBrightness,
  createWorkLouderCodexOffFrame,
  createWorkLouderCodexLightingFrame,
  createWorkLouderCodexWindowRevealFrame,
  muteWorkLouderCodexKeyZone,
  isWorkLouderCodexHostMessage,
  isWorkLouderCodexLightingFrameOff,
  isWorkLouderHidContention,
  isWorkLouderSdkTransportDeath,
  isWorkLouderIdleFirmwareError,
  shouldRequestWorkLouderLivenessProbe,
  parseWorkLouderCodexAgentKeyPress,
  parseWorkLouderCodexHidEvent,
  rewriteBareWorkLouderNotifyJson,
  unwrapWorkLouderDeviceStatus,
  isFailedWorkLouderRpcEnvelope,
  readWorkLouderDeviceStatusOrThrow,
  unwrapWorkLouderKeymapText,
  parseWorkLouderKeymapDocument,
  resolveWorkLouderActiveLayerIndex,
  resolveWorkLouderActiveProfileIndex,
  applyCreatorMicro2AgentLayer,
  creatorMicro2KeymapBackupFileName,
  creatorMicro2KeymapSessionFileName,
  isCindyExclusiveAgentKeymap,
  workLouderLayerHasAgentKeys,
  workLouderFirmwareIdlesHidRead,
  foldOrcaWorkerActivityOntoLeads,
  projectWorkLouderCodexSlotActivity,
  type WorkLouderCodexSessionActivity,
  WorkLouderLightingEffect,
} from '../protocol.js';

function activity(
  sessionId: string,
  phase: WorkLouderCodexSessionActivity['phase'],
  attention = false,
): WorkLouderCodexSessionActivity {
  return { sessionId, phase, compactDetail: '', attention };
}

describe('createWorkLouderCodexLightingFrame', () => {
  it('keeps an idle keyboard off', () => {
    const frame = createWorkLouderCodexLightingFrame([]);

    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(true);
    expect(frame.threads).toHaveLength(6);
  });

  it('can mute the shared keys zone so extra Creator keys stay dark', () => {
    const frame = muteWorkLouderCodexKeyZone(
      createWorkLouderCodexLightingFrame([activity('one', 'completed', true)]),
    );
    expect(frame.keys.brightness).toBe(0);
    expect(frame.threads[0]?.brightness).toBeGreaterThan(0);
  });

  it('uses animated blue lighting while Cindy is running', () => {
    const frame = createWorkLouderCodexLightingFrame([activity('one', 'running')]);

    expect(frame.ambient.effect).toBe(WorkLouderLightingEffect.Snake);
    expect(frame.ambient.color).toBe(0x4c6fff);
    expect(frame.threads[0]).toMatchObject({
      id: 0,
      effect: WorkLouderLightingEffect.Breath,
      brightness: 0.8,
    });
  });

  it('prioritizes a user decision over concurrent running and error activity', () => {
    const frame = createWorkLouderCodexLightingFrame([
      activity('running', 'running'),
      activity('error', 'error', true),
      activity('question', 'needs-interaction'),
    ]);

    expect(frame.ambient.color).toBe(0xffa000);
  });

  it('shows unread terminal states and clears acknowledged ones', () => {
    const unread = createWorkLouderCodexLightingFrame([activity('done', 'completed', true)]);
    const acknowledged = createWorkLouderCodexLightingFrame([activity('done', 'completed', false)]);

    expect(unread.ambient.color).toBe(0x35c759);
    expect(isWorkLouderCodexLightingFrameOff(acknowledged)).toBe(true);
  });

  it('always sends six thread slots so stale device LEDs are cleared', () => {
    const frame = createWorkLouderCodexLightingFrame(
      Array.from({ length: 8 }, (_, index) => activity(String(index), 'running')),
    );

    expect(frame.threads.map((thread) => thread.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(frame.threads.every((thread) => thread.brightness > 0)).toBe(true);
  });

  it('keeps an activity LED on the same slot as its task key assignment', () => {
    const running = activity('running-task', 'running');
    const projected = projectWorkLouderCodexSlotActivity([running], ['idle-task', 'running-task']);
    const frame = createWorkLouderCodexLightingFrame([running], ['idle-task', 'running-task']);

    expect(projected).toEqual([undefined, running, undefined, undefined, undefined, undefined]);
    expect(frame.threads[0].brightness).toBe(0);
    expect(frame.threads[1].brightness).toBeGreaterThan(0);
  });

  it('lights the lead task key when only an Orca worker is running', () => {
    const folded = foldOrcaWorkerActivityOntoLeads(
      [activity('worker-1', 'running')],
      { 'lead-1': ['worker-1'] },
    );
    const frame = createWorkLouderCodexLightingFrame(folded, ['lead-1']);

    expect(folded).toEqual([activity('worker-1', 'running'), activity('lead-1', 'running')]);
    expect(frame.ambient.effect).toBe(WorkLouderLightingEffect.Snake);
    expect(frame.threads[0].brightness).toBeGreaterThan(0);
  });

  it('keeps a lead question ahead of a running worker', () => {
    const folded = foldOrcaWorkerActivityOntoLeads(
      [activity('lead-1', 'needs-interaction'), activity('worker-1', 'running')],
      { 'lead-1': ['worker-1'] },
    );

    expect(folded[0]).toEqual(activity('lead-1', 'needs-interaction'));
  });
});

describe('Work Louder Agent key protocol', () => {
  it('maps press events from Agent keys AG00 through AG12', () => {
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG00', act: 1 })).toBe(0);
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG05', act: 1, agent: 99 })).toBe(5);
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG06', act: 1 })).toBe(6);
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG12', act: 1 })).toBe(12);
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG03', act: 0 })).toBeNull();
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'ENC_CW', act: 2 })).toBeNull();
    expect(parseWorkLouderCodexAgentKeyPress({ key: 'AG13', act: 1 })).toBeNull();
  });

  it('treats a missing HID act as a press and accepts numeric strings', () => {
    expect(parseWorkLouderCodexHidEvent({ key: 'ACT06' })).toEqual({ key: 'ACT06', act: 1 });
    expect(parseWorkLouderCodexHidEvent({ key: 'AG00', act: '1' })).toEqual({ key: 'AG00', act: 1 });
    expect(parseWorkLouderCodexHidEvent({ k: 'ACT07', act: 0 })).toEqual({ key: 'ACT07', act: 0 });
    expect(parseWorkLouderCodexHidEvent({ key: 'ENC_CW', act: 2 })).toEqual({
      key: 'ENC_CW',
      act: 2,
    });
    expect(parseWorkLouderCodexHidEvent({ key: 'NOPE', act: 1 })).toBeNull();
  });

  it('accepts only in-range Agent key messages from the utility process', () => {
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 0 })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 5 })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 12 })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 13 })).toBe(false);
    expect(isWorkLouderCodexHostMessage({ kind: 'agent-key', slot: 1.5 })).toBe(false);
  });

  it('accepts the activity notification and rejects malformed variants', () => {
    expect(isWorkLouderCodexHostMessage({ kind: 'activity' })).toBe(true);
    expect(isWorkLouderCodexHostMessage({ kind: 'device-activity' })).toBe(false);
    expect(isWorkLouderCodexHostMessage(null)).toBe(false);
  });

  it('accepts HID contention as a live host reason', () => {
    expect(
      isWorkLouderCodexHostMessage({
        kind: 'state',
        status: 'error',
        reason: 'device-in-use',
      }),
    ).toBe(true);
    expect(
      isWorkLouderCodexHostMessage({
        kind: 'state',
        status: 'error',
        reason: 'permission-required',
      }),
    ).toBe(true);
  });

  it('accepts presence discovery with optional identity', () => {
    expect(isWorkLouderCodexHostMessage({ kind: 'presence', present: false })).toBe(true);
    expect(
      isWorkLouderCodexHostMessage({
        kind: 'presence',
        present: true,
        deviceType: 'codex-micro',
        isUsbConnection: true,
      }),
    ).toBe(true);
    expect(
      isWorkLouderCodexHostMessage({
        kind: 'presence',
        present: true,
        deviceType: 'keyboard',
      }),
    ).toBe(false);
  });
});

describe('Work Louder lighting settings', () => {
  it('scales every zone without mutating the semantic frame', () => {
    const frame = createWorkLouderCodexLightingFrame([activity('one', 'running')]);
    const scaled = applyWorkLouderCodexLightingBrightness(frame, 50);

    expect(scaled.ambient.brightness).toBe(frame.ambient.brightness * 0.5);
    expect(scaled.keys.brightness).toBe(frame.keys.brightness * 0.5);
    expect(scaled.threads[0]?.brightness).toBe(frame.threads[0]?.brightness * 0.5);
    expect(frame.ambient.brightness).toBe(0.7);
  });

  it('creates a complete six-slot off frame', () => {
    const frame = createWorkLouderCodexOffFrame();

    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(true);
    expect(frame.threads.map((thread) => thread.id)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('greets a reopened window with a snake-and-breath sweep across every zone', () => {
    const frame = createWorkLouderCodexWindowRevealFrame();

    expect(frame.ambient.effect).toBe(WorkLouderLightingEffect.Snake);
    expect(frame.ambient.color).toBe(0xd0060c);
    expect(frame.keys.effect).toBe(WorkLouderLightingEffect.Breath);
    expect(frame.keys.color).toBe(0xd0060c);
    expect(frame.threads).toHaveLength(6);
    expect(frame.threads.every((thread) => thread.color === 0xd0060c)).toBe(true);
    expect(frame.threads.every((thread) => thread.effect === WorkLouderLightingEffect.Breath)).toBe(
      true,
    );
    expect(isWorkLouderCodexLightingFrameOff(frame)).toBe(false);
  });
});

describe('workLouderFirmwareIdlesHidRead', () => {
  it('is Creator-only; Codex still treats hid_read_timeout as a dead cable', () => {
    expect(workLouderFirmwareIdlesHidRead('creator-micro-2')).toBe(true);
    expect(workLouderFirmwareIdlesHidRead('codex-micro')).toBe(false);
    expect(workLouderFirmwareIdlesHidRead(null)).toBe(false);
  });
});

describe('isWorkLouderSdkTransportDeath', () => {
  it('does not tear down HID for lighting RPC control-plane noise', () => {
    const noise = [
      'Error calling RPC, id: 12 method: v.oai.rgbcfg Request timed out',
      'RPC operation failed: [object Object]',
      'No resolver found for id: 12',
    ];
    for (const detail of noise) {
      expect(isWorkLouderSdkTransportDeath(detail, 'creator-micro-2')).toBe(false);
      expect(isWorkLouderSdkTransportDeath(detail, 'codex-micro')).toBe(false);
    }
  });

  it('does not probe liveness for Creator idle HID silence', () => {
    expect(isWorkLouderIdleFirmwareError('hid_read_timeout', 'creator-micro-2')).toBe(true);
    expect(
      shouldRequestWorkLouderLivenessProbe(
        'could not read from HID device: hid_read_timeout: error waiting for more data',
        'creator-micro-2',
      ),
    ).toBe(false);
    expect(shouldRequestWorkLouderLivenessProbe('hid_read_timeout', 'codex-micro')).toBe(true);
    expect(isWorkLouderIdleFirmwareError('hid_read_timeout', 'codex-micro')).toBe(false);
  });

  it('treats hid_read_timeout as a dead cable only on Codex', () => {
    expect(isWorkLouderSdkTransportDeath('hid_read_timeout', 'creator-micro-2')).toBe(false);
    expect(
      isWorkLouderSdkTransportDeath(
        'could not read from HID device: hid_read_timeout: error waiting for more data',
        'creator-micro-2',
      ),
    ).toBe(false);
    expect(isWorkLouderSdkTransportDeath('hid_read_timeout', 'codex-micro')).toBe(true);
    expect(isWorkLouderSdkTransportDeath('hid_read_timeout', null)).toBe(false);
  });

  it('does not treat Creator idle device.status disconnects as a dead cable', () => {
    const poisonedStatus =
      'Error calling RPC, id: 137 method: device.status Device disconnected';
    expect(isWorkLouderSdkTransportDeath(poisonedStatus, 'creator-micro-2')).toBe(false);
    expect(isWorkLouderSdkTransportDeath(poisonedStatus, 'codex-micro')).toBe(true);
  });

  it('treats a missing HID handle as transport death on both boards', () => {
    expect(
      isWorkLouderSdkTransportDeath('cannot send, no device connected', 'creator-micro-2'),
    ).toBe(true);
    expect(isWorkLouderSdkTransportDeath('Error sending message: 0xE00002C5', 'codex-micro')).toBe(
      true,
    );
  });

  it('does not treat HID contention as a dead cable', () => {
    const contention = [
      'Error sending message: Cannot write to hid device: IOHIDDeviceSetReport failed: (0xE00002E2) (iokit/common) not permitted',
      'Error sending message: device has been closed',
      'Cannot write to hid device: IOHIDDeviceSetReport failed: (0xE00002E2) (iokit/common) not permitted',
      'IOHIDDeviceOpen failed: (0xE00002C1) (iokit/common) not privileged',
    ];
    for (const detail of contention) {
      expect(isWorkLouderHidContention(detail)).toBe(true);
      expect(isWorkLouderSdkTransportDeath(detail, 'creator-micro-2')).toBe(false);
      expect(isWorkLouderSdkTransportDeath(detail, 'codex-micro')).toBe(false);
    }
  });
});

describe('rewriteBareWorkLouderNotifyJson', () => {
  it('promotes a compact HID report into a v.oai.hid notify', () => {
    expect(rewriteBareWorkLouderNotifyJson('{"k":"AG00","act":1}')).toBe(
      JSON.stringify({ method: 'v.oai.hid', params: { k: 'AG00', act: 1, ag: undefined } }),
    );
    expect(rewriteBareWorkLouderNotifyJson('prefix {"key":"ACT06","act":0}')).toContain(
      '"method":"v.oai.hid"',
    );
  });

  it('promotes a compact stick report into a v.oai.rad notify', () => {
    expect(rewriteBareWorkLouderNotifyJson('{"a":0.25,"d":0.8}')).toBe(
      JSON.stringify({ method: 'v.oai.rad', params: { a: 0.25, d: 0.8 } }),
    );
  });

  it('leaves real JSON-RPC lines and incomplete fragments alone', () => {
    expect(
      rewriteBareWorkLouderNotifyJson(
        '{"result":{"ok":1},"id":12,"method":"v.oai.rgbcfg"}',
      ),
    ).toBeNull();
    expect(rewriteBareWorkLouderNotifyJson('{"k":"AG00"')).toBeNull();
    expect(rewriteBareWorkLouderNotifyJson('{"ok":1}')).toBeNull();
  });
});

describe('unwrapWorkLouderDeviceStatus', () => {
  it('reads both the SDK envelope and a raw firmware snapshot', () => {
    expect(
      unwrapWorkLouderDeviceStatus({
        ok: true,
        value: { firmwareVersion: '0.6.2', batteryPercentage: 97, isCharging: true },
      }),
    ).toEqual({
      firmwareVersion: '0.6.2',
      batteryPercentage: 97,
      isCharging: true,
    });
    expect(
      unwrapWorkLouderDeviceStatus({
        version: '0.6.2',
        battery: 96,
        is_charging: false,
        layer_index: 1,
        profile_index: 0,
      }),
    ).toEqual({
      firmwareVersion: '0.6.2',
      batteryPercentage: 96,
      isCharging: false,
      layerIndex: 1,
      profileIndex: 0,
    });
    expect(
      unwrapWorkLouderDeviceStatus({
        ok: true,
        value: {
          firmwareVersion: '0.6.2',
          selectedLayerIndex: 1,
          selectedProfileIndex: 0,
          batteryPercentage: 97,
          isCharging: true,
        },
      }),
    ).toEqual({
      firmwareVersion: '0.6.2',
      batteryPercentage: 97,
      isCharging: true,
      layerIndex: 1,
      profileIndex: 0,
    });
    expect(unwrapWorkLouderDeviceStatus({ ok: false, error: { message: 'timeout' } })).toEqual({});
    expect(isFailedWorkLouderRpcEnvelope({ ok: false, error: { message: 'timeout' } })).toBe(true);
    expect(isFailedWorkLouderRpcEnvelope({ firmwareVersion: '0.6.2' })).toBe(false);
    expect(() =>
      readWorkLouderDeviceStatusOrThrow({ ok: false, error: { message: 'timeout' } }),
    ).toThrow('timeout');
    expect(readWorkLouderDeviceStatusOrThrow({ firmwareVersion: '0.6.2' })).toEqual({
      firmwareVersion: '0.6.2',
    });
  });
});

describe('Creator Micro 2 agent keymap', () => {
  const factoryLayer = {
    id: 0,
    name: 'Layer 1',
    layout: {
      encoders: [['KV_ENC_CC', 'KV_ENC_CW', 'KV_ENC_CLK']],
      buttons: [],
      keymap: [
        ['KV_1', 'KV_2'],
        ['KV_3', 'KV_4', 'KV_5', 'KV_6'],
        ['KV_Q', 'KV_W', 'KV_E', 'KV_R'],
        ['KV_T', 'KV_Y', 'KV_SPACE'],
      ],
      joystick: { type: 'MOUSE', sectors: [] },
    },
    os: 0,
  };
  const factoryDocument = {
    profiles: [{ layers: [factoryLayer, { ...factoryLayer, id: 1, name: 'Layer 2' }] }],
  };

  it('unwraps keymap payloads from SDK envelopes and raw strings', () => {
    expect(unwrapWorkLouderKeymapText('{"profiles":[]}')).toBe('{"profiles":[]}');
    expect(unwrapWorkLouderKeymapText({ ok: true, value: { data: '{"profiles":[]}' } })).toBe(
      '{"profiles":[]}',
    );
    expect(unwrapWorkLouderKeymapText({ ok: true, value: factoryDocument })).toBe(
      JSON.stringify(factoryDocument),
    );
    expect(unwrapWorkLouderKeymapText({ ok: false, error: { message: 'timeout' } })).toBeNull();
  });

  it('rewrites only the active layer to Codex agent keys', () => {
    const parsed = parseWorkLouderKeymapDocument(JSON.stringify(factoryDocument));
    expect(parsed).not.toBeNull();
    const layerIndex = resolveWorkLouderActiveLayerIndex(1, parsed!.profiles[0].layers.length);
    const next = applyCreatorMicro2AgentLayer(parsed!, layerIndex);
    expect(layerIndex).toBe(0);
    expect(next.changed).toBe(true);
    expect(workLouderLayerHasAgentKeys(next.document.profiles[0].layers[0])).toBe(true);
    expect(workLouderLayerHasAgentKeys(next.document.profiles[0].layers[1])).toBe(false);
    expect(next.document.profiles[0].layers[0]?.name).toBe('Layer 1');
    expect(next.document.profiles[0].layers[0]?.layout?.keymap).toEqual([
      ['KV_OAI_AG00', 'KV_OAI_AG01'],
      ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
      ['KV_OAI_ACT06', 'KV_OAI_ACT07', 'KV_OAI_ACT08', 'KV_OAI_ACT09'],
      ['KV_OAI_ACT10', 'KV_OAI_ACT11', 'KV_OAI_ACT12'],
    ]);
  });

  it('is idempotent once the active layer already emits agent keys', () => {
    const parsed = parseWorkLouderKeymapDocument(JSON.stringify(factoryDocument));
    const first = applyCreatorMicro2AgentLayer(parsed!, 0);
    const second = applyCreatorMicro2AgentLayer(first.document, 0);
    expect(second.changed).toBe(false);
    expect(second.alreadyBound).toBe(true);
  });

  it('rewrites the layer again when the task-key keymap changes', () => {
    const parsed = parseWorkLouderKeymapDocument(JSON.stringify(factoryDocument));
    const first = applyCreatorMicro2AgentLayer(parsed!, 0);
    const next = applyCreatorMicro2AgentLayer(first.document, 0, [
      ['KV_OAI_ACT06', 'KV_OAI_AG01'],
      ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
      ['KV_OAI_AG00', 'KV_OAI_ACT07', 'KV_OAI_ACT08', 'KV_OAI_ACT09'],
      ['KV_OAI_ACT10', 'KV_OAI_ACT11', 'KV_OAI_ACT12'],
    ]);
    expect(next.changed).toBe(true);
    const rewritten = next.document.profiles[0].layers[0]?.layout?.keymap as string[][] | undefined;
    expect(rewritten?.[0]?.[0]).toBe('KV_OAI_ACT06');
  });

  it('clamps a missing or out-of-range firmware layer onto the first layer', () => {
    expect(resolveWorkLouderActiveLayerIndex(undefined, 2)).toBe(0);
    expect(resolveWorkLouderActiveLayerIndex(9, 2)).toBe(1);
    expect(resolveWorkLouderActiveLayerIndex(0, 2)).toBe(0);
  });

  it('rewrites the firmware-selected profile instead of always profiles[0]', () => {
    const parsed = parseWorkLouderKeymapDocument(
      JSON.stringify({
        profiles: [
          { layers: [factoryLayer] },
          { layers: [{ ...factoryLayer, id: 0, name: 'Profile 2' }] },
        ],
      }),
    );
    expect(resolveWorkLouderActiveProfileIndex(1, parsed!.profiles.length)).toBe(1);
    const next = applyCreatorMicro2AgentLayer(parsed!, 0, undefined, 1);
    expect(next.changed).toBe(true);
    expect(workLouderLayerHasAgentKeys(next.document.profiles[0].layers[0])).toBe(false);
    expect(workLouderLayerHasAgentKeys(next.document.profiles[1].layers[0])).toBe(true);
  });

  it('keeps per-device keymap backups from overwriting each other', () => {
    expect(creatorMicro2KeymapBackupFileName('80B54ECB0358')).toBe(
      'keymap-backup-80B54ECB0358.json',
    );
    expect(creatorMicro2KeymapBackupFileName('33432-/dev/hidraw0')).toBe(
      'keymap-backup-33432--dev-hidraw0.json',
    );
    expect(creatorMicro2KeymapBackupFileName(null)).toBe('keymap-backup.json');
    expect(creatorMicro2KeymapBackupFileName('  ')).toBe('keymap-backup.json');
    expect(creatorMicro2KeymapSessionFileName('80B54ECB0358')).toBe(
      'keymap-session-80B54ECB0358.json',
    );
    expect(creatorMicro2KeymapSessionFileName(null)).toBe('keymap-session.json');
  });

  it('does not treat a vendor layout that mentions AG00 as a Cindy occupancy map', () => {
    const vendorWithAg00 = JSON.stringify({
      profiles: [
        {
          layers: [
            {
              layout: {
                keymap: [
                  ['KV_OAI_AG00', 'KV_1'],
                  ['KV_Q', 'KV_W', 'KV_E', 'KV_R'],
                ],
              },
            },
          ],
        },
      ],
    });
    expect(isCindyExclusiveAgentKeymap(vendorWithAg00)).toBe(false);
    const parsed = parseWorkLouderKeymapDocument(JSON.stringify(factoryDocument));
    const cindy = applyCreatorMicro2AgentLayer(parsed!, 0);
    expect(isCindyExclusiveAgentKeymap(JSON.stringify(cindy.document))).toBe(true);
  });

  it('only treats the rebound layer as a Cindy occupancy map', () => {
    const parsed = parseWorkLouderKeymapDocument(JSON.stringify(factoryDocument));
    const cindyOnInactive = applyCreatorMicro2AgentLayer(parsed!, 1);
    const text = JSON.stringify(cindyOnInactive.document);
    expect(isCindyExclusiveAgentKeymap(text)).toBe(false);
    expect(isCindyExclusiveAgentKeymap(text, 0, 0)).toBe(false);
    expect(isCindyExclusiveAgentKeymap(text, 0, 1)).toBe(true);
  });
});
