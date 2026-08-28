/** Testable business logic behind the Work Louder Codex Micro settings IPC. */

import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CODEX_ANALOG_DIRECTIONS,
  WORKLOUDER_CODEX_COMMAND_SLOTS,
  WORKLOUDER_CODEX_ENCODER_ACTIONS,
  isWorkLouderCodexAgentSource,
  normalizeWorkLouderCodexAgentSource,
  isWorkLouderCodexAutoDim,
  isWorkLouderCodexCommandId,
  isWorkLouderCodexEncoderMode,
  isWorkLouderCodexKeycapId,
  type WorkLouderCodexAction,
  type WorkLouderCodexLayout,
  type WorkLouderCodexSettings,
  type WorkLouderCodexSettingsPatch,
  type WorkLouderCodexPublishedTask,
  type WorkLouderCodexState,
} from '../../shared/workLouderCodex.js';
import { WORKLOUDER_CODEX_TASK_OPTION_LIMIT } from './taskSlots.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const SETTING_KEYS = [
  'deviceEnabled',
  'lightingBrightness',
  'lightingAutoDim',
  'agentSource',
  'customAgentKeys',
  'singleTapAgentKeys',
  'layout',
] as const;

export interface WorkLouderCodexSettingsIpcDeps {
  assertTrustedSender(event: unknown): void;
  getState(): WorkLouderCodexState;
  writeSettings(patch: WorkLouderCodexSettingsPatch): WorkLouderCodexSettings;
  resetSettings(): WorkLouderCodexSettings;
  applySettings(settings: WorkLouderCodexSettings): void;
  openInputMonitoringSettings(): Promise<void>;
  probeDevice(): void;
  publishTasks(tasks: readonly WorkLouderCodexPublishedTask[]): void;
  setLayoutPreviewActive(active: boolean, event: unknown): void;
}

function parseSettingsPatch(value: unknown): WorkLouderCodexSettingsPatch {
  const record = requireRecord(value, 'Work Louder Codex settings patch required');
  rejectUnknownKeys(record, SETTING_KEYS, 'Work Louder Codex setting');
  if (Object.keys(record).length === 0) {
    throwIpcError('INVALID_PARAMS', 'Work Louder Codex settings patch cannot be empty');
  }

  const patch: WorkLouderCodexSettingsPatch = {};
  if ('lightingBrightness' in record) {
    const brightness = record.lightingBrightness;
    if (
      typeof brightness !== 'number' ||
      !Number.isInteger(brightness) ||
      brightness < 0 ||
      brightness > 100
    ) {
      throwIpcError('INVALID_PARAMS', 'lightingBrightness must be an integer from 0 to 100');
    }
    patch.lightingBrightness = brightness;
  }
  if ('lightingAutoDim' in record) {
    if (!isWorkLouderCodexAutoDim(record.lightingAutoDim)) {
      throwIpcError('INVALID_PARAMS', 'lightingAutoDim is invalid');
    }
    patch.lightingAutoDim = record.lightingAutoDim;
  }
  if ('agentSource' in record) {
    if (
      record.agentSource !== 'recent' &&
      record.agentSource !== 'pinned' &&
      !isWorkLouderCodexAgentSource(record.agentSource)
    ) {
      throwIpcError('INVALID_PARAMS', 'agentSource is invalid');
    }
    patch.agentSource = normalizeWorkLouderCodexAgentSource(record.agentSource);
  }
  if ('customAgentKeys' in record) {
    if (
      !Array.isArray(record.customAgentKeys) ||
      record.customAgentKeys.length !== WORKLOUDER_CODEX_AGENT_SLOT_COUNT
    ) {
      throwIpcError('INVALID_PARAMS', 'customAgentKeys must contain six assignments');
    }
    patch.customAgentKeys = record.customAgentKeys.map((action) => parseAction(action, true));
  }
  if ('deviceEnabled' in record) {
    if (typeof record.deviceEnabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'deviceEnabled must be a boolean');
    }
    patch.deviceEnabled = record.deviceEnabled;
  }
  if ('singleTapAgentKeys' in record) {
    if (typeof record.singleTapAgentKeys !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'singleTapAgentKeys must be a boolean');
    }
    patch.singleTapAgentKeys = record.singleTapAgentKeys;
  }
  if ('layout' in record) patch.layout = parseLayout(record.layout);
  return patch;
}

function parseLayout(value: unknown): WorkLouderCodexLayout {
  const record = requireRecord(value, 'layout must be an object');
  rejectUnknownKeys(
    record,
    [
      'version',
      'slots',
      'analogStick',
      'encoder',
      'encoderMode',
      // `voiceButtonMode` was dropped: the microphone key follows Cindy's own
      // microphone and has no mode. Still accepted so a settings object saved
      // by an older build round-trips instead of being rejected outright.
      'voiceButtonMode',
      'separateMicrophoneKeys',
    ],
    'layout field',
  );
  if (record.version !== 1) throwIpcError('INVALID_PARAMS', 'layout version must be 1');
  const slotsRecord = requireRecord(record.slots, 'layout slots must be an object');
  rejectUnknownKeys(slotsRecord, WORKLOUDER_CODEX_COMMAND_SLOTS, 'layout slot');
  const slots = Object.fromEntries(
    WORKLOUDER_CODEX_COMMAND_SLOTS.map((slot) => {
      const assignment = requireRecord(slotsRecord[slot], `${slot} assignment is required`);
      rejectUnknownKeys(assignment, ['keycapId', 'action'], `${slot} assignment field`);
      if (!isWorkLouderCodexKeycapId(assignment.keycapId)) {
        throwIpcError('INVALID_PARAMS', `${slot} keycapId is invalid`);
      }
      return [
        slot,
        { keycapId: assignment.keycapId, action: parseAction(assignment.action ?? null, true) },
      ];
    }),
  ) as WorkLouderCodexLayout['slots'];

  const analogRecord = requireRecord(record.analogStick, 'analogStick must be an object');
  rejectUnknownKeys(analogRecord, WORKLOUDER_CODEX_ANALOG_DIRECTIONS, 'analogStick direction');
  const analogStick = Object.fromEntries(
    WORKLOUDER_CODEX_ANALOG_DIRECTIONS.map((direction) => [
      direction,
      parseAction(analogRecord[direction] ?? null, true),
    ]),
  ) as WorkLouderCodexLayout['analogStick'];

  const encoderRecord = requireRecord(record.encoder, 'encoder must be an object');
  rejectUnknownKeys(encoderRecord, WORKLOUDER_CODEX_ENCODER_ACTIONS, 'encoder action');
  const encoder = Object.fromEntries(
    WORKLOUDER_CODEX_ENCODER_ACTIONS.map((action) => [
      action,
      parseAction(encoderRecord[action] ?? null, true),
    ]),
  ) as WorkLouderCodexLayout['encoder'];

  if (!isWorkLouderCodexEncoderMode(record.encoderMode)) {
    throwIpcError('INVALID_PARAMS', 'encoderMode is invalid');
  }
  if (typeof record.separateMicrophoneKeys !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'separateMicrophoneKeys must be a boolean');
  }
  return {
    version: 1,
    slots,
    analogStick,
    encoder,
    encoderMode: record.encoderMode,
    separateMicrophoneKeys: record.separateMicrophoneKeys,
  };
}

function parseAction(value: unknown, nullable: true): WorkLouderCodexAction | null;
function parseAction(value: unknown, nullable: false): WorkLouderCodexAction;
function parseAction(value: unknown, nullable: boolean): WorkLouderCodexAction | null {
  if (value === null && nullable) return null;
  const record = requireRecord(value, 'device action must be an object');
  if (record.type === 'command') {
    rejectUnknownKeys(record, ['type', 'commandId'], 'command action field');
    if (!isWorkLouderCodexCommandId(record.commandId)) {
      throwIpcError('INVALID_PARAMS', 'command action is invalid');
    }
    return { type: 'command', commandId: record.commandId };
  }
  if (record.type === 'task') {
    rejectUnknownKeys(record, ['type', 'sessionId'], 'task action field');
    return { type: 'task', sessionId: requireBoundedString(record.sessionId, 512, 'sessionId') };
  }
  if (record.type === 'keycap') {
    rejectUnknownKeys(record, ['type', 'keycapId'], 'keycap action field');
    if (!isWorkLouderCodexKeycapId(record.keycapId)) {
      throwIpcError('INVALID_PARAMS', 'keycap action is invalid');
    }
    return { type: 'keycap', keycapId: record.keycapId };
  }
  if (record.type === 'skill') {
    rejectUnknownKeys(record, ['type', 'skillId', 'name'], 'skill action field');
    return {
      type: 'skill',
      skillId: requireBoundedString(record.skillId, 1_024, 'skillId'),
      name: requireBoundedString(record.name, 256, 'skill name'),
    };
  }
  if (record.type === 'composer-text') {
    rejectUnknownKeys(record, ['type', 'text'], 'composer text action field');
    return {
      type: 'composer-text',
      text: requireBoundedString(record.text, 2_000, 'composer text'),
    };
  }
  if (record.type === 'external-url') {
    rejectUnknownKeys(record, ['type', 'url'], 'external URL action field');
    const url = requireBoundedString(record.url, 2_048, 'external URL');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
    } catch {
      throwIpcError('INVALID_PARAMS', 'external URL must use http or https');
    }
    return { type: 'external-url', url };
  }
  throwIpcError('INVALID_PARAMS', 'device action type is invalid');
}

export function createWorkLouderCodexSettingsIpc(deps: WorkLouderCodexSettingsIpcDeps) {
  return {
    get(event: unknown): WorkLouderCodexState {
      deps.assertTrustedSender(event);
      return deps.getState();
    },

    set(event: unknown, value: unknown): WorkLouderCodexState {
      deps.assertTrustedSender(event);
      const patch = parseSettingsPatch(value);
      let settings: WorkLouderCodexSettings;
      try {
        settings = deps.writeSettings(patch);
      } catch {
        throwIpcError('INTERNAL', 'Work Louder Codex settings write failed');
      }
      deps.applySettings(settings);
      return deps.getState();
    },

    reset(event: unknown): WorkLouderCodexState {
      deps.assertTrustedSender(event);
      let settings: WorkLouderCodexSettings;
      try {
        settings = deps.resetSettings();
      } catch {
        throwIpcError('INTERNAL', 'Work Louder Codex settings reset failed');
      }
      deps.applySettings(settings);
      return deps.getState();
    },

    async openInputMonitoringSettings(event: unknown): Promise<void> {
      deps.assertTrustedSender(event);
      await deps.openInputMonitoringSettings();
    },

    /**
     * Re-check whether the device is still attached, and return the state that
     * results. Fire-and-forget at the host layer, so the caller polls this to
     * notice an unplug rather than waiting for a push that never comes.
     */
    probe(event: unknown): WorkLouderCodexState {
      deps.assertTrustedSender(event);
      deps.probeDevice();
      return deps.getState();
    },

    /**
     * Take the sidebar's task list for the agent keys. The renderer is the only
     * side that sees tasks on linked machines, and the only side that knows
     * which machine filter is applied.
     */
    publishTasks(event: unknown, value: unknown): void {
      deps.assertTrustedSender(event);
      if (!Array.isArray(value)) {
        throwIpcError('INVALID_PARAMS', 'Work Louder Codex task list must be an array');
      }
      if (value.length > WORKLOUDER_CODEX_TASK_OPTION_LIMIT) {
        throwIpcError('INVALID_PARAMS', 'Work Louder Codex task list is too long');
      }
      const tasks: WorkLouderCodexPublishedTask[] = value.map((item) => {
        const row = requireRecord(item, 'Work Louder Codex task must be an object');
        if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 256) {
          throwIpcError('INVALID_PARAMS', 'Work Louder Codex task id is invalid');
        }
        if (row.title !== null && typeof row.title !== 'string') {
          throwIpcError('INVALID_PARAMS', 'Work Louder Codex task title is invalid');
        }
        if (typeof row.title === 'string' && row.title.length > 512) {
          throwIpcError('INVALID_PARAMS', 'Work Louder Codex task title is too long');
        }
        if (
          row.pinnedAt !== null &&
          (typeof row.pinnedAt !== 'number' || !Number.isFinite(row.pinnedAt))
        ) {
          throwIpcError('INVALID_PARAMS', 'Work Louder Codex task pinnedAt is invalid');
        }
        if (
          row.userSendAt !== null &&
          row.userSendAt !== undefined &&
          (typeof row.userSendAt !== 'number' || !Number.isFinite(row.userSendAt))
        ) {
          throwIpcError('INVALID_PARAMS', 'Work Louder Codex task userSendAt is invalid');
        }
        if (
          row.sidebarOrder !== undefined &&
          (typeof row.sidebarOrder !== 'number' ||
            !Number.isInteger(row.sidebarOrder) ||
            row.sidebarOrder < 0)
        ) {
          throwIpcError('INVALID_PARAMS', 'Work Louder Codex task sidebarOrder is invalid');
        }
        return {
          id: row.id,
          title: typeof row.title === 'string' ? row.title : null,
          pinnedAt: typeof row.pinnedAt === 'number' ? row.pinnedAt : null,
          userSendAt: typeof row.userSendAt === 'number' ? row.userSendAt : null,
          ...(typeof row.sidebarOrder === 'number' ? { sidebarOrder: row.sidebarOrder } : {}),
          ...(row.catalogEligible === false ? { catalogEligible: false } : {}),
        };
      });
      deps.publishTasks(tasks);
    },

    setLayoutPreviewActive(event: unknown, value: unknown): void {
      deps.assertTrustedSender(event);
      if (typeof value !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'layout preview flag must be a boolean');
      }
      deps.setLayoutPreviewActive(value, event);
    },
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', message);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throwIpcError('INVALID_PARAMS', `unknown ${label}: ${unknown}`);
}

function requireBoundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throwIpcError('INVALID_PARAMS', `${label} is invalid`);
  }
  return value;
}

export const __testing = { parseSettingsPatch, parseLayout, parseAction };
