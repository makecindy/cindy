import { isSafeGhostRelativePath } from './internal/ghostPath.js';
import { PLUGIN_APPEARANCE_FIELDS, type PluginAppearanceField } from './appearance.js';
/** Cindy placement and Host capabilities; page content stays in MCP Apps resources. */
export const HOST_UI_POSITIONS = [
  'composer.toolbar', 'session.header', 'statusbar', 'message.actions', 'message.menu',
  'turn.footer', 'message.body', 'tool.body',
] as const;
export type GhostHostUiPosition = typeof HOST_UI_POSITIONS[number];
export const HOST_UI_CAPABILITIES = ['context', 'draft', 'appearance', 'visibility'] as const;
export type GhostHostUiCapability = typeof HOST_UI_CAPABILITIES[number];

export interface GhostHostUiView {
  id: string;
  title: string;
  resourceUri: string;
  scope?: 'global' | 'task';
  [key: string]: unknown;
}
export interface GhostHostUiAction {
  view?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}
export interface GhostHostUiMatch {
  roles?: ('user' | 'assistant')[];
  tools?: string[];
  plugins?: string[];
  [key: string]: unknown;
}
export interface GhostHostUiContribution extends GhostHostUiAction {
  id: string;
  title: string;
  position: string;
  kind?: 'button' | 'select' | 'status';
  presentation?: 'sidebar' | 'popover';
  icon?: string;
  options?: { label: string; value: string }[];
  match?: GhostHostUiMatch;
  [key: string]: unknown;
}
export interface GhostHostUiCommand extends GhostHostUiAction {
  id: string;
  title: string;
  shortcut?: string;
  [key: string]: unknown;
}
export interface GhostHostUi {
  views?: GhostHostUiView[];
  contributions?: GhostHostUiContribution[];
  commands?: GhostHostUiCommand[];
  capabilities?: string[];
  appearance?: { fields: string[]; resources?: { id: string; kind: 'font' | 'image' | 'video'; path: string }[] };
  [key: string]: unknown;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-z][a-z0-9_-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const title = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 &&
  value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256) && new Set(value).size === value.length;
const position = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(value);
export const isHostUiPosition = (value: string): value is GhostHostUiPosition =>
  (HOST_UI_POSITIONS as readonly string[]).includes(value);
export const isHostUiCapability = (value: string): value is GhostHostUiCapability =>
  (HOST_UI_CAPABILITIES as readonly string[]).includes(value);

/** Validate known fields; future fields/positions remain data and confer no authority. */
export function parseGhostHostUi(
  raw: unknown,
  resources: ReadonlySet<string>,
  tools: ReadonlySet<string>,
): GhostHostUi | null {
  if (!object(raw)) return null;
  const views = new Set<string>();
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) return null;
    for (const view of raw.views) {
      if (!object(view) || !id(view.id) || views.has(view.id) || !title(view.title) ||
          typeof view.resourceUri !== 'string' || !resources.has(view.resourceUri) ||
          (view.scope !== undefined && view.scope !== 'global' && view.scope !== 'task')) return null;
      views.add(view.id);
    }
  }
  const action = (value: Record<string, unknown>) => {
    const count = Number(value.view !== undefined) + Number(value.tool !== undefined);
    return count === 1 && (value.view === undefined || typeof value.view === 'string' && views.has(value.view)) &&
      (value.tool === undefined || typeof value.tool === 'string' && tools.has(value.tool)) &&
      (value.arguments === undefined || object(value.arguments));
  };
  if (raw.contributions !== undefined) {
    if (!Array.isArray(raw.contributions)) return null;
    const ids = new Set<string>();
    for (const item of raw.contributions) {
      if (!object(item) || !id(item.id) || ids.has(item.id) || !title(item.title) || !position(item.position) ||
          (item.icon !== undefined && !id(item.icon)) ||
          (item.kind !== undefined && !['button', 'select', 'status'].includes(item.kind as string))) return null;
      ids.add(item.id);
      if (item.kind === 'status') {
        if (item.view !== undefined || item.tool !== undefined) return null;
      } else if (!action(item)) return null;
      if ((item.position === 'message.body' || item.position === 'tool.body') &&
          (item.view === undefined || item.tool !== undefined || item.kind !== undefined && item.kind !== 'button')) return null;
      if (item.position === 'message.menu' && item.kind !== undefined && item.kind !== 'button') return null;
      if (item.presentation !== undefined && (!['sidebar', 'popover'].includes(String(item.presentation)) ||
          item.view === undefined || item.kind !== undefined && item.kind !== 'button' ||
          ['message.body', 'tool.body', 'message.menu'].includes(item.position as string))) return null;
      if (item.kind === 'select') {
        if (!Array.isArray(item.options) || !item.options.length || item.options.some(option =>
          !object(option) || !title(option.label) || typeof option.value !== 'string' || option.value.length > 256) ||
          new Set(item.options.map(option => option.value)).size !== item.options.length) return null;
      } else if (item.options !== undefined) return null;
      if (item.match !== undefined) {
        if (!object(item.match)) return null;
        if (item.match.roles !== undefined && (!strings(item.match.roles) || item.match.roles.some(role => role !== 'user' && role !== 'assistant'))) return null;
        if (item.match.tools !== undefined && !strings(item.match.tools)) return null;
        if (item.match.plugins !== undefined && !strings(item.match.plugins)) return null;
      }
    }
  }
  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) return null;
    const ids = new Set<string>();
    for (const command of raw.commands) {
      if (!object(command) || !id(command.id) || ids.has(command.id) || !title(command.title) || !action(command) ||
          (command.shortcut !== undefined && (typeof command.shortcut !== 'string' || !command.shortcut.trim() || command.shortcut.length > 128))) return null;
      ids.add(command.id);
    }
  }
  if (raw.capabilities !== undefined && (!Array.isArray(raw.capabilities) || raw.capabilities.length > 0 && !strings(raw.capabilities))) return null;
  if (raw.appearance !== undefined) {
    const appearance = raw.appearance;
    if (!object(appearance) || !strings(appearance.fields) || appearance.fields.length > 32) return null;
    if (appearance.resources !== undefined) {
      if (!Array.isArray(appearance.resources) || appearance.resources.length > 64) return null;
      const ids = new Set<string>();
      for (const resource of appearance.resources) {
        if (!object(resource) || !id(resource.id) || ids.has(resource.id) || !['font', 'image', 'video'].includes(String(resource.kind)) ||
            typeof resource.path !== 'string' || resource.path.length > 1024 || !isSafeGhostRelativePath(resource.path)) return null;
        ids.add(resource.id);
      }
    }
  }
  return raw as GhostHostUi;
}

/** Stable approval subjects include only understood authority, never future data or translated titles. */
export function hostUiApprovalSubjects(host: GhostHostUi): { key: string; detail: string }[] {
  const result: { key: string; detail: string }[] = [];
  for (const view of host.views ?? []) result.push({ key: `view:${view.id}`,
    detail: JSON.stringify({ resource: view.resourceUri, scope: view.scope ?? 'global' }) });
  const action = (item: GhostHostUiAction) => ({ view: item.view, tool: item.tool,
    ...(item.arguments ? { arguments: item.arguments } : {}) });
  for (const item of host.contributions ?? []) {
    if (!isHostUiPosition(item.position)) continue;
    const match = item.match && { roles: item.match.roles && [...item.match.roles].sort(),
      tools: item.match.tools && [...item.match.tools].sort(), plugins: item.match.plugins && [...item.match.plugins].sort() };
    result.push({ key: `contribution:${item.id}`, detail: JSON.stringify({ position: item.position,
      kind: item.kind ?? 'button', ...action(item), match,
      ...(item.presentation === 'popover' ? { presentation: 'popover' } : {}),
      options: item.options?.map(option => option.value) }) });
  }
  for (const command of host.commands ?? []) result.push({ key: `command:${command.id}`,
    detail: JSON.stringify({ ...action(command), shortcut: command.shortcut }) });
  for (const capability of host.capabilities ?? []) if (isHostUiCapability(capability))
    result.push({ key: `capability:${capability}`, detail: capability });
  const appearanceFields = host.appearance?.fields ??
    (host.capabilities?.includes('appearance') ? PLUGIN_APPEARANCE_FIELDS : []);
  for (const field of appearanceFields) if (PLUGIN_APPEARANCE_FIELDS.includes(field as PluginAppearanceField))
    result.push({ key: `appearance:${field}`, detail: field });
  for (const resource of host.appearance?.resources ?? []) result.push({ key: `appearance-resource:${resource.id}`,
    detail: JSON.stringify({ kind: resource.kind, path: resource.path }) });
  return result;
}
