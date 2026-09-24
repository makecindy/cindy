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
const string = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const id = (value: unknown, max = 160): value is string =>
  string(value, max) &&
  value.length > 0 &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const isText = (value: unknown): value is SettingsPanel['title'] => {
  if (string(value, 20_000)) return true;
  const object = record(value);
  if (!string(object.fallback, 20_000)) return false;
  if (object.translations === undefined) return true;
  const translations = object.translations;
  return (
    !!translations &&
    typeof translations === 'object' &&
    !Array.isArray(translations) &&
    Object.keys(translations).length <= 32 &&
    Object.entries(translations).every(([locale, text]) => id(locale, 64) && string(text, 20_000))
  );
};
/** Bound traversal before inspecting nested host data; do not stringify an unbounded payload. */
function boundedResponse(raw: unknown): boolean {
  let nodes = 20_000;
  let characters = 2_000_000;
  const visit = (value: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 12) return false;
    if (typeof value === 'string') return (characters -= value.length) >= 0;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value))
      return value.length <= 2_000 && value.every((item) => visit(item, depth + 1));
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (!id(key, 512) || !visit((value as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(raw, 0);
}
function parseAction(raw: unknown): RemoteActionDescriptor | undefined {
  const action = record(raw);
  if (!id(action.id, 512) || !isText(action.label)) return;
  if (action.disabled !== undefined && typeof action.disabled !== 'boolean') return;
  if (action.tone !== undefined && !string(action.tone, 64)) return;
  if (action.confirmation !== undefined) {
    const confirmation = record(action.confirmation);
    if (
      !isText(confirmation.title) ||
      (confirmation.body !== undefined && !isText(confirmation.body)) ||
      (confirmation.confirmLabel !== undefined && !isText(confirmation.confirmLabel))
    )
      return;
  }
  if (action.fields !== undefined) {
    if (!Array.isArray(action.fields) || action.fields.length > 64) return;
    const ids = new Set<string>();
    for (const rawField of action.fields) {
      const field = record(rawField);
      if (
        !id(field.id) ||
        ids.has(field.id) ||
        !isText(field.label) ||
        typeof field.kind !== 'string' ||
        !['text', 'multiline', 'select', 'toggle'].includes(field.kind) ||
        (field.required !== undefined && typeof field.required !== 'boolean') ||
        (field.placeholder !== undefined && !isText(field.placeholder))
      )
        return;
      ids.add(field.id);
      if (field.kind === 'select' || field.options !== undefined) {
        if (
          !Array.isArray(field.options) ||
          field.options.length > 1_000 ||
          !field.options.every((rawOption) => {
            const option = record(rawOption);
            return string(option.value, 1_024) && isText(option.label);
          })
        )
          return;
      }
    }
  }
  return action as unknown as RemoteActionDescriptor;
}

/** Interpret only the finite forms advertised by the host, never local Bot IPC. */
export function parseRemoteBotSettings(
  raw: unknown,
  ref: RemoteResourceRef,
): RemoteBotSettingsData {
  const resource = raw as RemoteResource | null;
  if (
    !boundedResponse(raw) ||
    !resource ||
    resource.ref?.collectionId !== ref.collectionId ||
    resource.ref.kind !== ref.kind ||
    resource.ref.id !== ref.id ||
    !id(resource.revision, 1_024) ||
    !isText(resource.display?.title)
  )
    throw new Error('Invalid teammate settings');
  const actions = new Map<string, RemoteActionDescriptor>();
  if (Array.isArray(resource.actions) && resource.actions.length <= 256) {
    const duplicates = new Set<string>();
    for (const rawAction of resource.actions) {
      const action = parseAction(rawAction);
      if (!action) continue;
      if (actions.has(action.id)) duplicates.add(action.id);
      actions.set(action.id, action);
    }
    for (const duplicate of duplicates) actions.delete(duplicate);
  }
  const panels: SettingsPanel[] = [];
  for (const block of Array.isArray(resource.blocks) ? resource.blocks.slice(0, 256) : []) {
    if (!block || !id(block.id) || !string(block.fallbackMarkdown, 64_000)) continue;
    const data = record(block.data);
    let action =
      ['form', 'action'].includes(block.primitive) && id(data.actionId, 512)
        ? actions.get(data.actionId)
        : undefined;
    const values: SettingsValues = {};
    for (const field of action?.fields ?? []) {
      const value = record(data.values)[field.id];
      if (value === undefined && block.primitive === 'action') continue;
      if (field.kind === 'toggle' ? typeof value !== 'boolean' : !string(value, 65_536)) {
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
        return id(row.id) && id(row.resourceId, 256) && isText(row.title)
          ? [{ id: row.id, resourceId: row.resourceId, title: row.title }]
          : [];
      }),
    });
  }
  return {
    resource: {
      ref: { ...ref },
      revision: resource.revision,
      display: { title: resource.display.title },
      links: [],
    },
    panels,
  };
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
