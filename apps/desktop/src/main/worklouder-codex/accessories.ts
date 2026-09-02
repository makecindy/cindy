/** Multiplexes one Work Louder HID runtime across Codex Micro and Creator Micro 2. */

import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
  WORKLOUDER_MODELS,
  cloneWorkLouderCodexSettings,
  createWorkLouderCodexDefaultSettings,
  isWorkLouderModel,
  type WorkLouderAccessoriesState,
  type WorkLouderCodexAction,
  type WorkLouderCodexAgentSlotState,
  type WorkLouderCodexConnectionStatus,
  type WorkLouderCodexDeviceState,
  type WorkLouderCodexSettings,
  type WorkLouderCodexState,
  type WorkLouderModel,
} from '../../shared/workLouderCodex.js';

export interface WorkLouderLightingHost {
  getState(): WorkLouderCodexState;
  applySettings(settings: WorkLouderCodexSettings): void;
  subscribeState(listener: (state: WorkLouderCodexState) => void): () => void;
}

/**
 * Occupy HID only after the firmware identity is known and that model is enabled.
 * Occupying before `deviceType` lands would let `findCandidates()` attach the first
 * board it sees and drive it with the wrong layout.
 */
export function resolveWorkLouderOccupyingModel(
  deviceType: WorkLouderModel | null,
  settings: Record<WorkLouderModel, WorkLouderCodexSettings>,
): WorkLouderModel | null {
  if (!deviceType) return null;
  return settings[deviceType].deviceEnabled ? deviceType : null;
}

/**
 * Occupancy will not take HID until `deviceType` is known. If a board is already
 * enabled, the host still has to enumerate it — otherwise identity never lands
 * and the keyboard stays a regular HID keyboard forever.
 */
export function workLouderNeedsIdentityDiscovery(
  deviceType: WorkLouderModel | null,
  settings: Record<WorkLouderModel, WorkLouderCodexSettings>,
  devicePresent: boolean | null = null,
): boolean {
  if (!WORKLOUDER_MODELS.some((model) => settings[model].deviceEnabled)) return false;
  if (deviceType === null) return true;
  // Remembered identity is gone — another enabled board may appear.
  return devicePresent === false;
}

/** Preview only suppresses HID actions on the board whose settings page is open. */
export function workLouderLayoutPreviewSuppressesActions(
  active: boolean,
  editedModel: WorkLouderModel | null,
  occupyingModel: WorkLouderModel | null,
): boolean {
  return Boolean(active && occupyingModel && editedModel === occupyingModel);
}

/** Remembers the open settings page so occupancy changes can recompute the lease. */
export class WorkLouderLayoutPreviewSession {
  private wanted = false;
  private edited: WorkLouderModel | null = null;

  setRequest(active: boolean, edited: WorkLouderModel | null): void {
    this.wanted = active;
    this.edited = active ? edited : null;
  }

  shouldSuppress(occupying: WorkLouderModel | null): boolean {
    return workLouderLayoutPreviewSuppressesActions(this.wanted, this.edited, occupying);
  }
}

function cloneAction(action: WorkLouderCodexAction | null): WorkLouderCodexAction | null {
  return action ? { ...action } : null;
}

function idleAgentSlots(
  settings: WorkLouderCodexSettings,
  taskOptions: WorkLouderCodexState['taskOptions'],
): WorkLouderCodexAgentSlotState[] {
  const slotCount = settings.layout.taskKeys?.length ?? WORKLOUDER_CODEX_AGENT_SLOT_COUNT;
  const titleById = new Map(taskOptions.map((task) => [task.id, task.title] as const));
  return Array.from({ length: slotCount }, (_, slot) => {
    let action = cloneAction(settings.customAgentKeys[slot] ?? null);
    if (!action && settings.agentSource === 'custom' && slot >= settings.customAgentKeys.length) {
      const task = taskOptions[slot];
      action = task ? { type: 'task', sessionId: task.id } : null;
    }
    const sessionId = action?.type === 'task' ? action.sessionId : null;
    return {
      slot,
      sessionId,
      title: sessionId ? (titleById.get(sessionId) ?? null) : null,
      action,
    };
  });
}

function emptyDevice(live: WorkLouderCodexState): WorkLouderCodexDeviceState {
  return {
    ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE,
    inputMonitoringPermission: live.device.inputMonitoringPermission,
  };
}

function resolvePresent(model: WorkLouderModel, live: WorkLouderCodexState): boolean | null {
  if (live.devicePresent !== true) return live.devicePresent;
  return isWorkLouderModel(live.device.deviceType) ? live.device.deviceType === model : null;
}

function liveDeviceType(live: WorkLouderCodexState): WorkLouderModel | null {
  return isWorkLouderModel(live.device.deviceType) ? live.device.deviceType : null;
}

function desiredLightingSettings(
  occupying: WorkLouderModel | null,
  deviceType: WorkLouderModel | null,
  settings: Record<WorkLouderModel, WorkLouderCodexSettings>,
): WorkLouderCodexSettings {
  if (occupying) return settings[occupying];
  return { ...settings[deviceType ?? 'codex-micro'], deviceEnabled: false };
}

function connectionForIdle(
  settings: WorkLouderCodexSettings,
  present: boolean | null,
): WorkLouderCodexConnectionStatus {
  if (!settings.deviceEnabled) {
    return present === true ? 'disabled' : present === false ? 'not-detected' : 'disabled';
  }
  return 'not-detected';
}

function projectModel(
  model: WorkLouderModel,
  live: WorkLouderCodexState,
  occupying: WorkLouderModel | null,
  settings: WorkLouderCodexSettings,
): WorkLouderCodexState {
  const present = resolvePresent(model, live);
  const cloned = cloneWorkLouderCodexSettings(settings);

  if (live.connectionStatus === 'unavailable') {
    return {
      connectionStatus: settings.deviceEnabled
        ? 'unavailable'
        : connectionForIdle(settings, present),
      connectionReason: live.connectionReason,
      devicePresent: present,
      device: present === true ? { ...live.device } : emptyDevice(live),
      settings: cloned,
      agentSlots:
        occupying === model
          ? live.agentSlots.map((slot) => ({
              ...slot,
              action: cloneAction(slot.action),
            }))
          : idleAgentSlots(settings, live.taskOptions),
      taskOptions: live.taskOptions.map((task) => ({ ...task })),
      agentSlotCount: idleAgentSlots(settings, live.taskOptions).length,
    };
  }

  if (occupying === model) {
    return {
      ...live,
      devicePresent: present,
      device: { ...live.device },
      settings: cloned,
    };
  }

  return {
    connectionStatus: connectionForIdle(settings, present),
    connectionReason: null,
    devicePresent: present,
    device: present === true ? { ...live.device } : emptyDevice(live),
    settings: cloned,
    agentSlots: idleAgentSlots(settings, live.taskOptions),
    taskOptions: live.taskOptions.map((task) => ({ ...task })),
    agentSlotCount: idleAgentSlots(settings, live.taskOptions).length,
  };
}

export class WorkLouderAccessories {
  private settings = Object.fromEntries(
    WORKLOUDER_MODELS.map((model) => [model, createWorkLouderCodexDefaultSettings(model)]),
  ) as Record<WorkLouderModel, WorkLouderCodexSettings>;
  private readonly listeners = new Set<(state: WorkLouderAccessoriesState) => void>();
  private syncing = false;
  private identityDiscoveryRequested = false;
  private identityDiscoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly lighting: WorkLouderLightingHost,
    private readonly onNeedsIdentityDiscovery?: () => void,
  ) {
    lighting.subscribeState(() => {
      if (this.syncing) return;
      this.syncOccupancy();
    });
  }

  applySettings(model: WorkLouderModel, settings: WorkLouderCodexSettings): void {
    this.settings[model] = cloneWorkLouderCodexSettings(settings);
    this.syncOccupancy();
  }

  getAccessories(): WorkLouderAccessoriesState {
    const live = this.lighting.getState();
    const occupying = resolveWorkLouderOccupyingModel(liveDeviceType(live), this.settings);
    return Object.fromEntries(
      WORKLOUDER_MODELS.map((model) => [
        model,
        projectModel(model, live, occupying, this.settings[model]),
      ]),
    ) as WorkLouderAccessoriesState;
  }

  subscribe(listener: (state: WorkLouderAccessoriesState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getAccessories());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private syncOccupancy(): void {
    const live = this.lighting.getState();
    const occupying = resolveWorkLouderOccupyingModel(liveDeviceType(live), this.settings);
    const desired = desiredLightingSettings(occupying, liveDeviceType(live), this.settings);
    if (JSON.stringify(desired) !== JSON.stringify(live.settings)) {
      this.syncing = true;
      try {
        this.lighting.applySettings(desired);
      } finally {
        this.syncing = false;
      }
    }
    const needsDiscovery = workLouderNeedsIdentityDiscovery(
      liveDeviceType(live),
      this.settings,
      live.devicePresent,
    );
    if (needsDiscovery) this.scheduleIdentityDiscovery();
    else this.stopIdentityDiscovery();
    this.emit();
  }

  private scheduleIdentityDiscovery(): void {
    if (!this.identityDiscoveryRequested) {
      this.identityDiscoveryRequested = true;
      this.onNeedsIdentityDiscovery?.();
    }
    if (this.identityDiscoveryTimer || !this.onNeedsIdentityDiscovery) return;
    this.identityDiscoveryTimer = setInterval(() => {
      this.onNeedsIdentityDiscovery?.();
    }, 5_000);
    this.identityDiscoveryTimer.unref?.();
  }

  private stopIdentityDiscovery(): void {
    this.identityDiscoveryRequested = false;
    if (!this.identityDiscoveryTimer) return;
    clearInterval(this.identityDiscoveryTimer);
    this.identityDiscoveryTimer = null;
  }

  private emit(): void {
    const state = this.getAccessories();
    for (const listener of this.listeners) listener(state);
  }
}
