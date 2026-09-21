import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION, type RemoteActionDescriptor, type RemoteResource, type RemoteResourceRef, type RemoteText } from '@cindy/device-link';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { normalizeRemoteCollectionItems } from '@/device-link/remoteResources';

export type ProfileValues = Record<string, string | boolean>;
export interface ProfilePanel {
  id: string;
  text: string;
  action?: RemoteActionDescriptor;
  values: ProfileValues;
  followsDefault?: boolean;
  title?: RemoteText;
  entries?: Array<{ id: string; title: RemoteText; resourceId: string }>;
  portraits?: Array<{ value: string; uri: string }>;
}
export interface CompanionProfileData { resource: RemoteResource; panels: ProfilePanel[] }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown, max = 20_000): value is string => typeof value === 'string' && value.length <= max;
function text(value: unknown): value is RemoteText {
  if (string(value)) return true;
  const data = record(value);
  return !!data && string(data.fallback) && (data.translations === undefined || !!record(data.translations) && Object.values(record(data.translations)!).every(value => string(value)));
}
function action(value: unknown): RemoteActionDescriptor | null {
  const data = record(value);
  if (!data || !string(data.id, 160) || !data.id || !text(data.label)) return null;
  const fields: NonNullable<RemoteActionDescriptor['fields']> = [];
  if (data.fields !== undefined) {
    if (!Array.isArray(data.fields) || data.fields.length > 20) return null;
    for (const item of data.fields) {
      const field = record(item);
      if (!field || !string(field.id, 160) || !text(field.label) || !['text', 'multiline', 'toggle', 'select'].includes(String(field.kind))) return null;
      const options: Array<{ value: string; label: RemoteText }> = [];
      if (field.kind === 'select') {
        if (!Array.isArray(field.options) || field.options.length > 2000) return null;
        for (const option of field.options) {
          const choice = record(option);
          if (!choice || !string(choice.value, 160) || !text(choice.label)) return null;
          options.push({ value: choice.value, label: choice.label });
        }
      }
      fields.push({ id: field.id, label: field.label, kind: String(field.kind), required: field.required === true, ...(options.length ? { options } : {}) });
    }
  }
  const confirmation = record(data.confirmation);
  if (data.confirmation !== undefined && (!confirmation || !text(confirmation.title) || confirmation.body !== undefined && !text(confirmation.body) || confirmation.confirmLabel !== undefined && !text(confirmation.confirmLabel))) return null;
  return { id: data.id, label: data.label, fields, disabled: data.disabled === true, tone: data.tone === 'destructive' ? 'destructive' : 'neutral',
    ...(confirmation ? { confirmation: { title: confirmation.title as RemoteText, ...(confirmation.body ? { body: confirmation.body as RemoteText } : {}), ...(confirmation.confirmLabel ? { confirmLabel: confirmation.confirmLabel as RemoteText } : {}) } } : {}) };
}
/** Only finite form primitives are interpreted; unsupported or malformed actions remain read-only. */
export function parseCompanionProfileData(raw: unknown, ref: RemoteResourceRef): CompanionProfileData {
  const resource = normalizeRemoteCollectionItems({ items: [raw] }, ref.collectionId)[0];
  if (!resource || resource.ref.id !== ref.id || resource.ref.kind !== ref.kind) throw new Error('Invalid companion resource');
  const data = record(raw)!;
  const actions = new Map<string, RemoteActionDescriptor>();
  if (Array.isArray(data.actions)) for (const item of data.actions.slice(0, 512)) {
    const parsed = action(item);
    if (parsed) actions.set(parsed.id, parsed);
  }
  const panels: ProfilePanel[] = [];
  if (Array.isArray(data.blocks)) for (const item of data.blocks.slice(0, 512)) {
    const block = record(item);
    if (!block || !string(block.id, 160) || !string(block.fallbackMarkdown, 64_000)) continue;
    const payload = record(block.data);
    const values: ProfileValues = {};
    let formAction = (block.primitive === 'form' || block.primitive === 'action') && string(payload?.actionId, 160) ? actions.get(payload!.actionId as string) : undefined;
    if (formAction) for (const field of formAction.fields ?? []) {
      const value = record(payload?.values)?.[field.id];
      if (value === undefined && block.primitive === 'action') continue;
      if (field.kind === 'toggle' ? typeof value !== 'boolean' : !string(value, 65_536)) {
        formAction = undefined; // Never save an incomplete/clipped form as a full value.
        break;
      }
      values[field.id] = value as string | boolean;
    }
    const entries = Array.isArray(payload?.entries) ? payload.entries.slice(0, 2000).flatMap(item => {
      const entry = record(item);
      return entry && string(entry.id, 160) && text(entry.title) && string(entry.resourceId, 256)
        ? [{ id: entry.id, title: entry.title, resourceId: entry.resourceId }] : [];
    }) : undefined;
    const portraits = Array.isArray(payload?.portraits) ? payload.portraits.slice(0, 16).flatMap(item => {
      const portrait = record(item);
      return portrait && string(portrait.value, 160) && string(portrait.uri, 200_000) && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(portrait.uri)
        ? [{ value: portrait.value, uri: portrait.uri }] : [];
    }) : undefined;
    panels.push({ id: block.id, text: block.fallbackMarkdown, action: formAction, values, entries, portraits,
      ...(text(block.title) ? { title: block.title } : {}),
      ...(typeof payload?.followsDefault === 'boolean' ? { followsDefault: payload.followsDefault } : {}) });
  }
  return { resource, panels };
}
export async function loadCompanionProfile(invoke: RemoteInvoke, deviceId: string, ref: RemoteResourceRef, locale: string): Promise<CompanionProfileData> {
  const raw = await invoke<unknown>(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{ client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['status', 'session-link', 'markdown', 'form', 'action', 'list'], locale }, ref }]);
  return parseCompanionProfileData(raw, ref);
}
/** Task output inventory is already host-authorized; project only relative display names and source links. */
export function companionArtifactRows(value: unknown, botId: string): Array<{ id: string; title: string; childSessionId: string | null; files: string[] }> {
  const data = record(value);
  if (data?.ok !== true || !Array.isArray(data.delegations)) return [];
  return data.delegations.slice(0, 200).flatMap(item => {
    const row = record(item);
    if (!row || row.requestingBotId !== botId || !string(row.id, 160) || !Array.isArray(row.artifacts)) return [];
    const files = row.artifacts.slice(0, 200).flatMap(item => {
      const file = record(item);
      if (!file || !['added', 'modified', 'renamed'].includes(String(file.status)) || !string(file.path, 1024)
        || /^(?:[/\\\\]|[A-Za-z]:)/.test(file.path) || file.path.split(/[/\\\\]/).includes('..')) return [];
      return [file.path];
    });
    return files.length ? [{ id: row.id, title: string(row.title, 2000) ? row.title : '', childSessionId: string(row.childSessionId, 160) ? row.childSessionId : null, files }] : [];
  });
}
export function profileFormDirty(panel: ProfilePanel | undefined, values: ProfileValues): boolean {
  return !!panel?.action?.fields?.some(field => (values[field.id] ?? '') !== (panel.values[field.id] ?? ''));
}
