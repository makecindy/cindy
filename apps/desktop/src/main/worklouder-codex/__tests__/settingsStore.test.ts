import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cloneWorkLouderCodexLayout,
  createWorkLouderCodexDefaultSettings,
} from '../../../shared/workLouderCodex.js';

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'cloud:owner-a:1',
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(electronMock.userDataDir, 'owners', 'owner-a', ...parts),
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  __testing,
  readWorkLouderCodexSettings,
  resetWorkLouderCodexSettings,
  writeWorkLouderCodexSettingsPatch,
} from '../settingsStore.js';

describe('Work Louder Codex settings store', () => {
  afterEach(() => {
    if (electronMock.userDataDir) {
      fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
      electronMock.userDataDir = '';
    }
  });

  it('uses the shipped defaults for missing or invalid persisted values', () => {
    expect(__testing.normalize(undefined)).toEqual(createWorkLouderCodexDefaultSettings());
    expect(
      __testing.normalize({
        lightingBrightness: '50',
        lightingAutoDim: 'sometimes',
        singleTapAgentKeys: 1,
      }),
    ).toEqual(createWorkLouderCodexDefaultSettings());
  });

  it('rounds and clamps persisted brightness while preserving valid options', () => {
    expect(
      __testing.normalize({
        lightingBrightness: 49.6,
        lightingAutoDim: '30-seconds',
        singleTapAgentKeys: false,
      }),
    ).toEqual({
      ...createWorkLouderCodexDefaultSettings(),
      lightingBrightness: 50,
      lightingAutoDim: '30-seconds',
      singleTapAgentKeys: false,
    });
    expect(__testing.normalize({ lightingBrightness: -9 }).lightingBrightness).toBe(0);
    expect(__testing.normalize({ lightingBrightness: 999 }).lightingBrightness).toBe(100);
    expect(__testing.normalize({ lightingBrightness: Number.NaN }).lightingBrightness).toBe(100);
  });

  it('maps the old pinned and recent sources onto sidebar order', () => {
    expect(__testing.normalize({ agentSource: 'pinned' }).agentSource).toBe('sidebar');
    expect(__testing.normalize({ agentSource: 'recent' }).agentSource).toBe('sidebar');
    expect(__testing.normalize({ agentSource: 'last-sent' }).agentSource).toBe('last-sent');
  });

  it('persists a patch under the Electron userData directory', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklouder-settings-'));

    const next = writeWorkLouderCodexSettingsPatch('codex-micro', {
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });

    expect(next).toEqual({
      ...createWorkLouderCodexDefaultSettings(),
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });
    expect(readWorkLouderCodexSettings()).toEqual(next);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            electronMock.userDataDir,
            'owners',
            'owner-a',
            'worklouder-codex-settings.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual({
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });
  });

  it('keeps the keyboard enabled when restoring other defaults', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklouder-settings-'));

    writeWorkLouderCodexSettingsPatch('codex-micro', {
      deviceEnabled: true,
      lightingBrightness: 40,
    });
    const next = resetWorkLouderCodexSettings();

    expect(next).toEqual({
      ...createWorkLouderCodexDefaultSettings(),
      deviceEnabled: true,
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            electronMock.userDataDir,
            'owners',
            'owner-a',
            'worklouder-codex-settings.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual({ deviceEnabled: true });
  });

  it('persists extra Codex task keys', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklouder-settings-'));
    const layout = cloneWorkLouderCodexLayout(createWorkLouderCodexDefaultSettings().layout);
    layout.taskKeys = [...(layout.taskKeys ?? []), 'ACT06'];

    const next = writeWorkLouderCodexSettingsPatch('codex-micro', { layout });

    expect(next.layout.taskKeys).toEqual(expect.arrayContaining(['AG00', 'ACT06']));
    expect(readWorkLouderCodexSettings('codex-micro').layout.taskKeys).toEqual(
      expect.arrayContaining(['AG00', 'ACT06']),
    );
  });

  it('keeps Creator Micro 2 settings in a separate file with blank keycaps', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklouder-settings-'));

    expect(__testing.normalize(undefined, 'creator-micro-2')).toEqual(
      createWorkLouderCodexDefaultSettings('creator-micro-2'),
    );

    const next = writeWorkLouderCodexSettingsPatch('creator-micro-2', {
      lightingBrightness: 40,
    });

    expect(next.layout.slots.ACT06.keycapId).toBe('EMPT1');
    expect(next.layout.slots.ACT06.action).toEqual({
      type: 'command',
      commandId: 'composer.toggleFastMode',
    });
    expect(next.layout.separateMicrophoneKeys).toBe(true);
    expect(readWorkLouderCodexSettings('creator-micro-2')).toEqual(next);
    expect(readWorkLouderCodexSettings('codex-micro').layout.slots.ACT06.keycapId).toBe('FAST');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            electronMock.userDataDir,
            'owners',
            'owner-a',
            'worklouder-creator-micro-2-settings.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual({ lightingBrightness: 40 });
  });

  it('upgrades a persisted Creator factory layout that stored empty EMPT actions', () => {
    const next = __testing.normalize(
      {
        layout: {
          version: 1,
          slots: {
            ACT06: { keycapId: 'EMPT1', action: null },
            ACT07: { keycapId: 'EMPT2', action: null },
            ACT08: { keycapId: 'EMPT3', action: null },
            ACT09: { keycapId: 'EMPT4', action: null },
            ACT10: { keycapId: 'EMPT1', action: null },
            ACT11: { keycapId: 'EMPT2', action: null },
            ACT10_ACT11: { keycapId: 'EMPT5', action: null },
            ACT12: { keycapId: 'EMPT3', action: null },
          },
          analogStick: {
            up: { type: 'command', commandId: 'conversation.scrollUp' },
            right: { type: 'command', commandId: 'toggleRightSidebar' },
            down: { type: 'command', commandId: 'conversation.scrollDown' },
            left: { type: 'command', commandId: 'toggleSidebar' },
          },
          encoder: { left: null, right: null, click: null, longPress: null },
          encoderMode: 'session-switch',
          separateMicrophoneKeys: true,
        },
      },
      'creator-micro-2',
    );

    expect(next.layout.slots.ACT06.action).toEqual({
      type: 'command',
      commandId: 'composer.toggleFastMode',
    });
    expect(next.layout.slots.ACT12.action).toEqual({
      type: 'command',
      commandId: 'composer.submit',
    });
    expect(next.layout.slots.ACT10.action).toEqual({ type: 'voice' });
  });

  it('keeps a Creator layout that is blank on purpose after the new schema exists', () => {
    const next = __testing.normalize(
      {
        layout: {
          version: 1,
          slots: {
            ACT06: { keycapId: 'EMPT1', action: null },
            ACT07: { keycapId: 'EMPT1', action: null },
            ACT08: { keycapId: 'EMPT1', action: null },
            ACT09: { keycapId: 'EMPT1', action: null },
            ACT10: { keycapId: 'EMPT1', action: null },
            ACT11: { keycapId: 'EMPT1', action: null },
            ACT10_ACT11: { keycapId: 'EMPT5', action: null },
            ACT12: { keycapId: 'EMPT1', action: null },
          },
          analogStick: {
            up: { type: 'command', commandId: 'conversation.scrollUp' },
            right: { type: 'command', commandId: 'toggleRightSidebar' },
            down: { type: 'command', commandId: 'conversation.scrollDown' },
            left: { type: 'command', commandId: 'toggleSidebar' },
          },
          encoder: { left: null, right: null, click: null, longPress: null },
          encoderMode: 'session-switch',
          separateMicrophoneKeys: true,
          taskKeys: ['AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05'],
          merges: [],
        },
      },
      'creator-micro-2',
    );

    expect(next.layout.slots.ACT06).toEqual({ keycapId: 'EMPT1', action: null });
    expect(next.layout.slots.ACT10.action).toBeNull();
  });

  it('lets Creator keep a merged microphone layout, same as Codex', () => {
    const next = __testing.normalize(
      {
        layout: {
          version: 1,
          slots: {
            ACT06: {
              keycapId: 'EMPT1',
              action: { type: 'command', commandId: 'composer.toggleFastMode' },
            },
            ACT10_ACT11: { keycapId: 'MIC', action: null },
            ACT12: { keycapId: 'EMPT3', action: { type: 'command', commandId: 'composer.submit' } },
          },
          separateMicrophoneKeys: false,
        },
      },
      'creator-micro-2',
    );

    expect(next.layout.separateMicrophoneKeys).toBe(false);
    expect(next.layout.slots.ACT10_ACT11.keycapId).toBe('MIC');
    expect(next.layout.slots.ACT12.action).toEqual({
      type: 'command',
      commandId: 'composer.submit',
    });
  });

  it('migrates a legacy ACT10_ACT11 2U assignment onto origin when merges is missing', () => {
    const next = __testing.normalize(
      {
        layout: {
          version: 1,
          slots: {
            ACT10: { keycapId: 'MIC', action: null },
            ACT11: { keycapId: 'EMPT1', action: null },
            ACT10_ACT11: { keycapId: 'EMPT5', action: { type: 'voice' } },
            ACT12: {
              keycapId: 'EMPT3',
              action: { type: 'command', commandId: 'composer.submit' },
            },
          },
          separateMicrophoneKeys: false,
        },
      },
      'creator-micro-2',
    );

    expect(next.layout.slots.ACT10).toEqual({
      keycapId: 'EMPT5',
      action: { type: 'voice' },
    });
  });

  it('keeps a MIC cap on merged ACT10 instead of copying the EMPT5 alias back', () => {
    const next = __testing.normalize(
      {
        layout: {
          version: 1,
          slots: {
            ACT10: { keycapId: 'MIC', action: null },
            ACT11: { keycapId: 'EMPT1', action: null },
            ACT10_ACT11: { keycapId: 'EMPT5', action: null },
            ACT12: {
              keycapId: 'EMPT3',
              action: { type: 'command', commandId: 'composer.submit' },
            },
          },
          separateMicrophoneKeys: false,
          merges: [{ origin: 'ACT10', cover: 'ACT11' }],
        },
      },
      'creator-micro-2',
    );

    expect(next.layout.slots.ACT10.keycapId).toBe('MIC');
    expect(next.layout.slots.ACT10_ACT11.keycapId).toBe('MIC');
  });

  it('persists bound voice actions and drops unknown fields', () => {
    expect(__testing.normalizeAction({ type: 'voice', junk: true })).toEqual({ type: 'voice' });
    const next = __testing.normalize(
      {
        layout: {
          version: 1,
          slots: {
            ACT10: { keycapId: 'EMPT1', action: { type: 'voice' } },
          },
        },
      },
      'creator-micro-2',
    );
    expect(next.layout.slots.ACT10.action).toEqual({ type: 'voice' });
  });
});
