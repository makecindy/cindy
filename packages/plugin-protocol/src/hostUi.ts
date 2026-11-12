import { isSafeGhostRelativePath } from './internal/ghostPath.js';
import { PLUGIN_APPEARANCE_FIELDS, type PluginAppearanceField } from './appearance.js';
const EXTENDED_HOST_UI_POSITIONS = [
  'sidebar.navigation', 'session.menu', 'settings.section', 'composer.completion',
  'composer.attachment', 'sidebar.section',
  'window.titlebar',
] as const;
/** Cindy placement and Host capabilities; page content stays in MCP Apps resources. */
export const HOST_UI_POSITIONS = [
  'composer.toolbar', 'session.header', 'statusbar', 'message.actions', 'message.menu',
  'turn.footer', 'message.body', 'tool.body', ...EXTENDED_HOST_UI_POSITIONS,
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
  trigger?: '/' | '@';
  accept?: { extensions?: string[]; mimeTypes?: string[] };
  [key: string]: unknown;
}
export interface GhostHostUiSetting {
  id: string;
  title: string;
  description?: string;
  type: 'boolean' | 'string' | 'number';
  default: boolean | string | number;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: { label: string; value: boolean | string | number }[];
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
  settings?: GhostHostUiSetting[];
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
export function isGhostHostUiSettingValue(field: GhostHostUiSetting, value: unknown): boolean {
  return typeof value === field.type &&
    (typeof value !== 'number' || Number.isFinite(value) && (field.min === undefined || value >= field.min) &&
      (field.max === undefined || value <= field.max)) &&
    (typeof value !== 'string' || value.length <= (field.maxLength ?? 32768)) &&
    (!field.options || field.options.some(option => option.value === value));
}
export const isHostUiPosition = (value: string): value is GhostHostUiPosition =>
  (HOST_UI_POSITIONS as readonly string[]).includes(value);
export function matchesGhostHostUiAttachment(accept: GhostHostUiContribution['accept'], file: { name: string; mimeType: string }): boolean {
  const name = file.name.toLowerCase(), mime = file.mimeType.toLowerCase().split(';')[0].trim();
  return !!accept && (accept.extensions?.some(ext => name.endsWith(ext)) === true || accept.mimeTypes?.some(type =>
    type === '*/*' || type === mime || type.endsWith('/*') && mime.startsWith(type.slice(0, -1))) === true);
}
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
      if (['message.menu', 'session.menu', 'sidebar.navigation', 'settings.section', 'composer.completion', 'composer.attachment', 'sidebar.section', 'window.titlebar'].includes(String(item.position)) &&
          item.kind !== undefined && item.kind !== 'button') return null;
      if (item.position === 'settings.section' && (item.view === undefined ||
          (raw.views as GhostHostUiView[]).find(view => view.id === item.view)?.scope === 'task')) return null;
      if (item.position === 'composer.completion' && (item.tool === undefined || !['/', '@'].includes(String(item.trigger)))) return null;
      if (item.position === 'sidebar.section' && item.view === undefined) return null;
      if (item.position === 'composer.attachment') {
        if (item.tool === undefined || !object(item.accept) || !item.accept.extensions && !item.accept.mimeTypes) return null;
        if (item.accept.extensions !== undefined && (!strings(item.accept.extensions) ||
            item.accept.extensions.some(ext => !/^\.[a-z0-9][a-z0-9._+-]{0,31}$/.test(ext)))) return null;
        if (item.accept.mimeTypes !== undefined && (!strings(item.accept.mimeTypes) ||
            item.accept.mimeTypes.some(mime => !/^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+))$/.test(mime)))) return null;
      }
      if (item.presentation !== undefined && (!['sidebar', 'popover'].includes(String(item.presentation)) ||
          item.view === undefined || item.kind !== undefined && item.kind !== 'button' ||
          ['message.body', 'tool.body', 'message.menu', 'session.menu', 'sidebar.navigation', 'settings.section', 'composer.completion', 'composer.attachment', 'sidebar.section', 'window.titlebar'].includes(item.position as string))) return null;
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
  if (raw.settings !== undefined) {
    if (!Array.isArray(raw.settings)) return null;
    const ids = new Set<string>();
    for (const field of raw.settings) {
      if (!object(field) || !id(field.id) || ids.has(field.id) || !title(field.title) ||
          !['boolean', 'string', 'number'].includes(String(field.type)) ||
          field.description !== undefined && (typeof field.description !== 'string' || field.description.length > 2000) ||
          ['min', 'max'].some(key => field[key] !== undefined && (field.type !== 'number' || typeof field[key] !== 'number' || !Number.isFinite(field[key]))) ||
          field.min !== undefined && field.max !== undefined && (field.min as number) > (field.max as number) ||
          field.maxLength !== undefined && (field.type !== 'string' || !Number.isSafeInteger(field.maxLength) || (field.maxLength as number) < 0 || (field.maxLength as number) > 32768)) return null;
      ids.add(field.id);
      if (field.options !== undefined && (!Array.isArray(field.options) || !field.options.length || field.options.some(option =>
        !object(option) || !title(option.label) || typeof option.value !== field.type) ||
        new Set(field.options.map(option => option.value)).size !== field.options.length)) return null;
      if (!isGhostHostUiSettingValue(field as unknown as GhostHostUiSetting, field.default) ||
          (field.options as GhostHostUiSetting['options'])?.some(option => !isGhostHostUiSettingValue(field as unknown as GhostHostUiSetting, option.value))) return null;
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

/** Historical unknown extensions cannot invalidate previously understood authority.
 * New-package validation still uses parseGhostHostUi without this projection. */
export function parseStoredGhostHostUi(
  raw: unknown,
  resources: ReadonlySet<string>,
  tools: ReadonlySet<string>,
): GhostHostUi | null {
  const strict = parseGhostHostUi(raw, resources, tools);
  if (strict || !object(raw)) return strict;
  const compatible = { ...raw };
  delete compatible.settings;
  if (Array.isArray(raw.contributions)) {
    compatible.contributions = raw.contributions.filter(item => !object(item) ||
      !(EXTENDED_HOST_UI_POSITIONS as readonly unknown[]).includes(item.position) ||
      parseGhostHostUi({ views: raw.views, contributions: [item] }, resources, tools));
  }
  if (Array.isArray(raw.settings)) {
    const ids = new Set<string>();
    compatible.settings = raw.settings.filter(field => {
      if (!parseGhostHostUi({ settings: [field] }, resources, tools) || ids.has(field.id)) return false;
      ids.add(field.id);
      return true;
    });
  }
  return parseGhostHostUi(compatible, resources, tools);
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
      ...(item.position === 'composer.completion' ? { trigger: item.trigger } : {}),
      ...(item.position === 'composer.attachment' && item.accept ? { accept: { extensions: item.accept.extensions && [...item.accept.extensions].sort(),
        mimeTypes: item.accept.mimeTypes && [...item.accept.mimeTypes].sort() } } : {}),
      options: item.options?.map(option => option.value) }) });
  }
  for (const command of host.commands ?? []) result.push({ key: `command:${command.id}`,
    detail: JSON.stringify({ ...action(command), shortcut: command.shortcut }) });
  for (const field of host.settings ?? []) result.push({ key: `setting:${field.id}`, detail: JSON.stringify({
    type: field.type, min: field.min, max: field.max, maxLength: field.maxLength,
    options: field.options?.map(option => option.value),
  }) });
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
