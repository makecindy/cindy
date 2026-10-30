import { describe, expect, it, vi } from 'vitest';

import {
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS,
  createWorkLouderCodexDefaultSettings,
  type WorkLouderCodexSettings,
  type WorkLouderCodexState,
  type WorkLouderModel,
} from '../../../shared/workLouderCodex.js';
import {
  WorkLouderAccessories,
  resolveWorkLouderOccupyingModel,
  workLouderLayoutPreviewSuppressesActions,
  WorkLouderLayoutPreviewSession,
  workLouderNeedsIdentityDiscovery,
  type WorkLouderLightingHost,
} from '../accessories.js';

function emptySlots(): WorkLouderCodexState['agentSlots'] {
  return Array.from({ length: 6 }, (_, slot) => ({
    slot,
    sessionId: null,
    title: null,
    action: null,
  }));
}

function liveState(
  overrides: {
    deviceType?: WorkLouderModel | null;
    present?: boolean | null;
    connectionStatus?: WorkLouderCodexState['connectionStatus'];
    settings?: WorkLouderCodexSettings;
    agentSlots?: WorkLouderCodexState['agentSlots'];
    taskOptions?: WorkLouderCodexState['taskOptions'];
  } = {},
): WorkLouderCodexState {
  const deviceType = overrides.deviceType === undefined ? null : overrides.deviceType;
  const present = overrides.present === undefined ? (deviceType ? true : null) : overrides.present;
  return {
    connectionStatus:
      overrides.connectionStatus ?? (present === true ? 'connected' : 'not-detected'),
    connectionReason: null,
    devicePresent: present,
    device: {
      ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
      deviceType,
    },
    settings: overrides.settings ?? createWorkLouderCodexDefaultSettings('codex-micro'),
    agentSlots: overrides.agentSlots ?? emptySlots(),
    taskOptions: overrides.taskOptions ?? [],
    agentSlotCount: 6,
  };
}

class FakeLighting implements WorkLouderLightingHost {
  applied: WorkLouderCodexSettings[] = [];
  private listeners = new Set<(state: WorkLouderCodexState) => void>();

  constructor(private state: WorkLouderCodexState) {}

  getState(): WorkLouderCodexState {
    return this.state;
  }

  applySettings(settings: WorkLouderCodexSettings): void {
    this.applied.push(settings);
    this.state = { ...this.state, settings };
  }

  subscribeState(listener: (state: WorkLouderCodexState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setLive(next: WorkLouderCodexState): void {
    this.state = next;
    for (const listener of this.listeners) listener(this.state);
  }
}

function defaults(model: WorkLouderModel, enabled = false): WorkLouderCodexSettings {
  return { ...createWorkLouderCodexDefaultSettings(model), deviceEnabled: enabled };
}

describe('resolveWorkLouderOccupyingModel', () => {
  it('asks for presence discovery while a board is enabled but still unidentified', () => {
    expect(
      workLouderNeedsIdentityDiscovery(null, {
        'codex-micro': defaults('codex-micro'),
        'creator-micro-2': defaults('creator-micro-2', true),
      }),
    ).toBe(true);
    expect(
      workLouderNeedsIdentityDiscovery('creator-micro-2', {
        'codex-micro': defaults('codex-micro'),
        'creator-micro-2': defaults('creator-micro-2', true),
      }),
    ).toBe(false);
    expect(
      workLouderNeedsIdentityDiscovery(
        'codex-micro',
        {
          'codex-micro': defaults('codex-micro'),
          'creator-micro-2': defaults('creator-micro-2', true),
        },
        false,
      ),
    ).toBe(true);
    expect(
      workLouderNeedsIdentityDiscovery(null, {
        'codex-micro': defaults('codex-micro'),
        'creator-micro-2': defaults('creator-micro-2'),
      }),
    ).toBe(false);
  });

  it('never occupies before the firmware identity is known', () => {
    expect(
      resolveWorkLouderOccupyingModel(null, {
        'codex-micro': defaults('codex-micro', true),
        'creator-micro-2': defaults('creator-micro-2', true),
      }),
    ).toBeNull();
  });

  it('occupies only the matching model, and only when that model is enabled', () => {
    const settings = {
      'codex-micro': defaults('codex-micro', true),
      'creator-micro-2': defaults('creator-micro-2', false),
    };
    expect(resolveWorkLouderOccupyingModel('codex-micro', settings)).toBe('codex-micro');
    expect(resolveWorkLouderOccupyingModel('creator-micro-2', settings)).toBeNull();
  });
});

describe('workLouderLayoutPreviewSuppressesActions', () => {
  it('only suppresses the occupied board while its own settings page is open', () => {
    expect(workLouderLayoutPreviewSuppressesActions(true, 'creator-micro-2', 'codex-micro')).toBe(
      false,
    );
    expect(workLouderLayoutPreviewSuppressesActions(true, 'codex-micro', 'codex-micro')).toBe(true);
    expect(workLouderLayoutPreviewSuppressesActions(true, 'creator-micro-2', null)).toBe(false);
    expect(workLouderLayoutPreviewSuppressesActions(false, 'codex-micro', 'codex-micro')).toBe(
      false,
    );
  });

  it('recomputes suppression when occupancy lands or moves after the page is already open', () => {
    const session = new WorkLouderLayoutPreviewSession();
    session.setRequest(true, 'creator-micro-2');
    expect(session.shouldSuppress(null)).toBe(false);
    expect(session.shouldSuppress('creator-micro-2')).toBe(true);
    expect(session.shouldSuppress('codex-micro')).toBe(false);
    session.setRequest(false, 'creator-micro-2');
    expect(session.shouldSuppress('creator-micro-2')).toBe(false);
  });
});

describe('WorkLouderAccessories occupancy', () => {
  it('does not occupy a Creator board when only Codex is enabled', () => {
    const lighting = new FakeLighting(
      liveState({
        deviceType: 'creator-micro-2',
        settings: defaults('codex-micro'),
      }),
    );
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('codex-micro', defaults('codex-micro', true));

    const state = accessories.getAccessories();
    expect(state['codex-micro'].connectionStatus).toBe('not-detected');
    expect(state['codex-micro'].devicePresent).toBe(false);
    expect(state['creator-micro-2'].connectionStatus).toBe('disabled');
    expect(state['creator-micro-2'].devicePresent).toBe(true);
    expect(lighting.getState().settings.deviceEnabled).toBe(false);
    expect(lighting.getState().settings.layout.slots.ACT06.keycapId).toBe('EMPT1');
  });

  it('occupies Creator Micro 2 with its own blank layout once that model is enabled', () => {
    const lighting = new FakeLighting(
      liveState({
        deviceType: 'creator-micro-2',
        settings: defaults('codex-micro'),
        agentSlots: [
          {
            slot: 0,
            sessionId: 's1',
            title: 'Live task',
            action: { type: 'task', sessionId: 's1' },
          },
          ...emptySlots().slice(1),
        ],
      }),
    );
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('creator-micro-2', defaults('creator-micro-2', true));

    const state = accessories.getAccessories();
    expect(state['creator-micro-2'].connectionStatus).toBe('connected');
    expect(state['creator-micro-2'].agentSlots[0]?.title).toBe('Live task');
    expect(state['codex-micro'].connectionStatus).toBe('not-detected');
    expect(state['codex-micro'].agentSlots[0]?.title).toBeNull();
    expect(lighting.getState().settings.deviceEnabled).toBe(true);
    expect(lighting.getState().settings.layout.slots.ACT06.keycapId).toBe('EMPT1');
    expect(lighting.getState().settings.layout.separateMicrophoneKeys).toBe(true);
  });

  it('occupies Codex Micro with the Codex layout when that board is present and enabled', () => {
    const lighting = new FakeLighting(
      liveState({
        deviceType: 'codex-micro',
        settings: defaults('codex-micro'),
      }),
    );
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('codex-micro', defaults('codex-micro', true));

    const state = accessories.getAccessories();
    expect(state['codex-micro'].connectionStatus).toBe('connected');
    expect(state['creator-micro-2'].devicePresent).toBe(false);
    expect(lighting.getState().settings.layout.slots.ACT06.keycapId).toBe('FAST');
  });

  it('projects presence onto the matching model only', () => {
    const lighting = new FakeLighting(
      liveState({
        deviceType: 'creator-micro-2',
        present: true,
      }),
    );
    const accessories = new WorkLouderAccessories(lighting);
    const state = accessories.getAccessories();
    expect(state['creator-micro-2'].devicePresent).toBe(true);
    expect(state['codex-micro'].devicePresent).toBe(false);
  });

  it('keeps HID disabled while deviceType is still unknown, even if a model is enabled', () => {
    const lighting = new FakeLighting(liveState({ deviceType: null, present: null }));
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('codex-micro', defaults('codex-micro', true));

    expect(
      resolveWorkLouderOccupyingModel(null, {
        'codex-micro': defaults('codex-micro', true),
        'creator-micro-2': defaults('creator-micro-2'),
      }),
    ).toBeNull();
    expect(lighting.getState().settings.deviceEnabled).toBe(false);
    expect(accessories.getAccessories()['codex-micro'].connectionStatus).toBe('not-detected');
  });

  it('discovers identity once when a board is enabled before the firmware names itself', () => {
    const lighting = new FakeLighting(liveState({ deviceType: null, present: null }));
    const discover = vi.fn();
    const accessories = new WorkLouderAccessories(lighting, discover);

    accessories.applySettings('creator-micro-2', defaults('creator-micro-2', true));
    accessories.applySettings('creator-micro-2', defaults('creator-micro-2', true));
    expect(discover).toHaveBeenCalledOnce();
    expect(lighting.getState().settings.deviceEnabled).toBe(false);

    lighting.setLive(
      liveState({
        deviceType: 'creator-micro-2',
        settings: lighting.getState().settings,
      }),
    );
    expect(discover).toHaveBeenCalledOnce();
    expect(lighting.getState().settings.deviceEnabled).toBe(true);
  });

  it('retries identity discovery while a board stays enabled but unnamed', () => {
    vi.useFakeTimers();
    try {
      const lighting = new FakeLighting(liveState({ deviceType: null, present: null }));
      const discover = vi.fn();
      const accessories = new WorkLouderAccessories(lighting, discover);
      accessories.applySettings('creator-micro-2', defaults('creator-micro-2', true));
      expect(discover).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(5_000);
      expect(discover).toHaveBeenCalledTimes(2);

      lighting.setLive(
        liveState({
          deviceType: 'creator-micro-2',
          settings: lighting.getState().settings,
        }),
      );
      vi.advanceTimersByTime(5_000);
      expect(discover).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes discovery after a remembered board disappears', () => {
    const lighting = new FakeLighting(liveState({ deviceType: 'codex-micro' }));
    const discover = vi.fn();
    const accessories = new WorkLouderAccessories(lighting, discover);
    accessories.applySettings('creator-micro-2', defaults('creator-micro-2', true));
    expect(discover).not.toHaveBeenCalled();

    lighting.setLive(
      liveState({
        deviceType: 'codex-micro',
        present: false,
        settings: lighting.getState().settings,
      }),
    );
    expect(discover).toHaveBeenCalledOnce();
  });

  it('does not re-apply lighting when occupancy already matches live settings', () => {
    const lighting = new FakeLighting(
      liveState({
        deviceType: 'codex-micro',
        settings: defaults('codex-micro'),
      }),
    );
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('codex-micro', defaults('codex-micro', true));
    lighting.applied = [];
    accessories.applySettings('codex-micro', defaults('codex-micro', true));
    expect(lighting.applied).toEqual([]);
  });

  it('keeps the task catalog on the idle board so custom bindings stay configurable', () => {
    const lighting = new FakeLighting({
      ...liveState({
        deviceType: 'codex-micro',
        settings: defaults('codex-micro'),
      }),
      taskOptions: [{ id: 'task-1', title: 'Inbox', pinned: false }],
    });
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('codex-micro', defaults('codex-micro', true));
    accessories.applySettings('creator-micro-2', defaults('creator-micro-2'));

    const state = accessories.getAccessories();
    expect(state['codex-micro'].taskOptions).toEqual([
      { id: 'task-1', title: 'Inbox', pinned: false },
    ]);
    expect(state['creator-micro-2'].taskOptions).toEqual([
      { id: 'task-1', title: 'Inbox', pinned: false },
    ]);
  });

  it('projects extra custom task keys on the idle board from the live catalog', () => {
    const lighting = new FakeLighting(
      liveState({
        deviceType: 'codex-micro',
        settings: defaults('codex-micro'),
        taskOptions: [
          { id: 't0', title: 'Zero', pinned: false },
          { id: 't1', title: 'One', pinned: false },
          { id: 't2', title: 'Two', pinned: false },
          { id: 't3', title: 'Three', pinned: false },
          { id: 't4', title: 'Four', pinned: false },
          { id: 't5', title: 'Five', pinned: false },
          { id: 't6', title: 'Sixth extra', pinned: false },
        ],
      }),
    );
    const accessories = new WorkLouderAccessories(lighting);
    accessories.applySettings('codex-micro', defaults('codex-micro', true));
    accessories.applySettings('creator-micro-2', {
      ...defaults('creator-micro-2'),
      agentSource: 'custom',
      layout: {
        ...defaults('creator-micro-2').layout,
        taskKeys: [...WORKLOUDER_CREATOR_DEFAULT_TASK_KEYS, 'ACT06'],
      },
    });

    const idle = accessories.getAccessories()['creator-micro-2'];
    expect(idle.agentSlots).toHaveLength(7);
    expect(idle.agentSlots[6]).toEqual({
      slot: 6,
      sessionId: 't6',
      title: 'Sixth extra',
      action: { type: 'task', sessionId: 't6' },
    });
  });
});
