import {
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  type RemoteResource,
  type RemoteResourceRef,
  type RemoteActionDescriptor,
} from '@cindy/device-link';
import { normalizeBotModelChain, type BotModelRoute } from '../../../shared/botModelChain';

export type SettingsValues = Record<string, string | boolean>;
export interface SettingsPanel {
  id: string;
  title: string | { fallback: string; translations?: Record<string, string> };
  text: string;
  action?: RemoteActionDescriptor;
  values: SettingsValues;
  entries: Array<{ id: string; title: SettingsPanel['title']; resourceId: string }>;
}
export interface RemoteBotSettingsData {
  resource: RemoteResource;
  panels: SettingsPanel[];
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const isText = (v: unknown): v is SettingsPanel['title'] =>
  typeof v === 'string' || typeof record(v).fallback === 'string';

/** Interpret only the finite forms advertised by the host, never local Bot IPC. */
export function parseRemoteBotSettings(
  raw: unknown,
  ref: RemoteResourceRef,
): RemoteBotSettingsData {
  const resource = raw as RemoteResource | null;
  if (
    !resource ||
    resource.ref?.collectionId !== ref.collectionId ||
    resource.ref.kind !== ref.kind ||
    resource.ref.id !== ref.id ||
    typeof resource.revision !== 'string' ||
    !isText(resource.display?.title)
  )
    throw new Error('Invalid teammate settings');
  const actions = new Map(
    (Array.isArray(resource.actions) ? resource.actions : [])
      .filter(
        (action) =>
          !!action &&
          typeof action.id === 'string' &&
          isText(action.label) &&
          (!action.confirmation || isText(action.confirmation.title)) &&
          (!action.fields ||
            (Array.isArray(action.fields) &&
              action.fields.every(
                (field) =>
                  !!field &&
                  typeof field.id === 'string' &&
                  isText(field.label) &&
                  ['text', 'multiline', 'select', 'toggle'].includes(field.kind) &&
                  (field.kind !== 'select' ||
                    (Array.isArray(field.options) &&
                      field.options.every(
                        (option) =>
                          !!option && typeof option.value === 'string' && isText(option.label),
                      ))),
              ))),
      )
      .map((action) => [action.id, action]),
  );
  const panels: SettingsPanel[] = [];
  for (const block of Array.isArray(resource.blocks) ? resource.blocks : []) {
    if (!block || typeof block.id !== 'string' || typeof block.fallbackMarkdown !== 'string')
      continue;
    const data = record(block.data);
    let action =
      ['form', 'action'].includes(block.primitive) && typeof data.actionId === 'string'
        ? actions.get(data.actionId)
        : undefined;
    const values: SettingsValues = {};
    for (const field of action?.fields ?? []) {
      const value = record(data.values)[field.id];
      if (value === undefined && block.primitive === 'action') continue;
      if (field.kind === 'toggle' ? typeof value !== 'boolean' : typeof value !== 'string') {
        action = undefined;
        break;
      }
      values[field.id] = value as string | boolean;
    }
    panels.push({
      id: block.id,
      title: isText(block.title) ? block.title : (action?.label ?? block.id),
      text: block.fallbackMarkdown,
      action,
      values,
      entries: (Array.isArray(data.entries) ? data.entries : []).flatMap((raw) => {
        const row = record(raw);
        return typeof row.id === 'string' && typeof row.resourceId === 'string' && isText(row.title)
          ? [{ id: row.id, resourceId: row.resourceId, title: row.title }]
          : [];
      }),
    });
  }
  return { resource, panels };
}
export const botSettingsRef = (id: string): RemoteResourceRef => ({
  collectionId: 'teammates',
  kind: 'bot',
  id,
});
export const settingsClient = (locale: string) => ({
  protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
  primitives: ['status', 'session-link', 'markdown', 'form', 'action', 'list'],
  locale,
});
export async function readRemoteBotSettings(deviceId: string, id: string, locale: string) {
  const ref = botSettingsRef(id);
  return parseRemoteBotSettings(
    await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [
      { ref, client: settingsClient(locale) },
    ]),
    ref,
  );
}
export function readRemoteBotModelChain(value: unknown): BotModelRoute[] {
  try {
    return normalizeBotModelChain(JSON.parse(typeof value === 'string' ? value : '[]'));
  } catch {
    return [];
  }
}
export function settingsChanges(panel: SettingsPanel, draft: SettingsValues): SettingsValues {
  return Object.fromEntries(
    (panel.action?.fields ?? [])
      .filter((field) => draft[field.id] !== panel.values[field.id])
      .map((field) => [field.id, draft[field.id] ?? '']),
  );
}
