import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
} from '@cindy/device-link';

import { boundedPluginResponse } from '@/features/plugin/remotePluginManagementClient';
import {
  BOT_SETTINGS_ACTION_ID,
  BOT_SETTINGS_PROTOCOL_VERSION,
  type BotSettingsCaps,
  type BotSettingsOp,
  type BotSettingsResult,
} from '../../../shared/botRemoteSettings';
import { createIpcError, isIpcErrorCode } from '../../../shared/ipc-errors';

const client = { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: [] };
/** The invoke channel rejects inputs above 64 KiB; keep a margin for the envelope. */
const MAX_INPUT_BYTES = 56 * 1024;
const encoder = new TextEncoder();
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** Does the host declare the teammate settings action? (Older hosts only have the generic form.) */
export async function hostDeclaresBotSettings(deviceId: string): Promise<boolean> {
  const manifest = await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_MANIFEST_CHANNEL, [{ client }]);
  if (!boundedPluginResponse(manifest)) return false;
  return !!(manifest as { collections?: Array<{ id: string; actions?: Array<{ id: string }> }> }).collections?.some(
    (collection) => collection.id === 'teammates' && collection.actions?.some((action) => action.id === BOT_SETTINGS_ACTION_ID),
  );
}

/** One operation on the teammate's computer. A refused operation rejects with the same IPC error shape the local call has. */
export async function invokeBotSettings<T = unknown>(
  deviceId: string,
  op: BotSettingsOp,
  botId: string | null,
  args?: Record<string, unknown>,
): Promise<T> {
  const input = { v: BOT_SETTINGS_PROTOCOL_VERSION, op, ...(args ? { args } : {}) };
  if (byteLength(input) > MAX_INPUT_BYTES) throw createIpcError('INVALID_PARAMS', 'Request is too large');
  const response = (await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [
    {
      client,
      collectionId: 'teammates',
      actionId: BOT_SETTINGS_ACTION_ID,
      ...(botId ? { resourceRef: { collectionId: 'teammates', kind: 'bot', id: botId } } : {}),
      input,
    },
  ])) as { result?: BotSettingsResult<T> } | null;
  const result = response?.result;
  if (!boundedPluginResponse(result) || !result || typeof result.ok !== 'boolean') throw createIpcError('INTERNAL', 'Invalid settings response');
  if (result.ok) return result.value;
  throw createIpcError(isIpcErrorCode(result.code) ? result.code : 'INTERNAL', String(result.message ?? ''));
}

export async function readBotSettingsCaps(deviceId: string): Promise<BotSettingsCaps> {
  const caps = await invokeBotSettings<BotSettingsCaps>(deviceId, 'caps', null);
  if (!caps || !Array.isArray(caps.ops) || typeof caps.version !== 'number') throw createIpcError('INTERNAL', 'Invalid settings capabilities');
  return caps;
}

const TEXT_FIELDS = ['name', 'description', 'identitySource', 'userContextSource'] as const;
/**
 * An autosave patch is a handful of fields. Long personality + user text can exceed the invoke input
 * limit together, so the free text goes in its own requests (each still has to fit by itself).
 */
export function splitProfilePatch(patch: Record<string, unknown>): Array<Record<string, unknown>> {
  if (byteLength({ patch }) <= MAX_INPUT_BYTES) return [patch];
  const rest = Object.fromEntries(Object.entries(patch).filter(([key]) => !(TEXT_FIELDS as readonly string[]).includes(key)));
  return [
    ...(Object.keys(rest).length ? [rest] : []),
    ...TEXT_FIELDS.filter((key) => key in patch).map((key) => ({ [key]: patch[key] })),
  ];
}
