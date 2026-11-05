import { isSafeGhostRelativePath } from './internal/ghostPath.js';

/** Native Cindy contributions. MCP Apps keep their separate mcpApps declaration. */
export interface GhostNativeUiContribution {
  id: string;
  point: string;
  scope: string;
  order?: number;
  context?: string[];
  editor?: string[];
  /** Optional packaged HTML page; URLs and paths outside the package are not allowed. */
  page?: string;
  /** Renderer match is descriptive; it does not grant access to the record. */
  match?: { kind: string; instanceId?: string; name?: string; [extension: string]: unknown };
  [extension: string]: unknown;
}

export interface GhostNativeUiCommand {
  id: string;
  title: string;
  points?: string[];
  scope: string;
  context?: string[];
  editor?: string[];
  defaultShortcut?: { code: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean };
  [extension: string]: unknown;
}

export interface GhostNativeUiTabView {
  id: string;
  title: string;
  scope: 'global' | 'session';
  page: string;
  [extension: string]: unknown;
}

export interface GhostNativeUi {
  version: number;
  contributions?: GhostNativeUiContribution[];
  commands?: GhostNativeUiCommand[];
  tabViews?: GhostNativeUiTabView[];
  appearance?: {
    fields: string[];
    resources?: { id: string; kind: string; path: string; [extension: string]: unknown }[];
    [extension: string]: unknown;
  };
  [extension: string]: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const nativePoints = new Set(['composer.tools', 'session.header.actions', 'session.statusbar', 'message.actions', 'turn.footer', 'message.body', 'tool.body']);

/** Structure only; points, scopes, permissions and registration are Host policy.
 * Return the original declaration so recognizing it does not rewrite receipts. */
export function parseGhostNativeUi(value: unknown): GhostNativeUi | null {
  if (!record(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) return null;
  if (value.version !== 1) return value as unknown as GhostNativeUi;
  if (value.tabViews !== undefined) {
    if (!Array.isArray(value.tabViews) || value.tabViews.length > 64) return null;
    const viewIds = new Set<string>();
    for (const view of value.tabViews) {
      if (!record(view) || !text(view.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(view.id) ||
          ['__proto__', 'constructor', 'prototype'].includes(view.id) || viewIds.has(view.id) ||
          !text(view.title, 160) || !['global', 'session'].includes(String(view.scope)) ||
          !text(view.page, 1024) || !isSafeGhostRelativePath(view.page) || !/\.html$/i.test(view.page)) return null;
      viewIds.add(view.id);
    }
  }
  if (value.appearance !== undefined) {
    const a = value.appearance;
    if (!record(a) || !Array.isArray(a.fields) || a.fields.length > 32 ||
        a.fields.some(field => !text(field, 64)) || new Set(a.fields).size !== a.fields.length) return null;
    if (a.resources !== undefined) {
      if (!Array.isArray(a.resources) || a.resources.length > 64) return null;
      const resourceIds = new Set<string>();
      for (const resource of a.resources) {
        if (!record(resource) || !text(resource.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(resource.id) ||
            resourceIds.has(resource.id) || !text(resource.kind, 64) || !text(resource.path, 1024) ||
            !isSafeGhostRelativePath(resource.path)) return null;
        resourceIds.add(resource.id);
      }
    }
  }
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands) || value.commands.length > 64) return null;
    const commandIds = new Set<string>();
    for (const command of value.commands) {
      if (!record(command) || !text(command.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(command.id) ||
          commandIds.has(command.id) || !text(command.title, 160) || !text(command.scope, 64) ||
          (command.points !== undefined && (!Array.isArray(command.points) || command.points.length > 16 ||
          command.points.some(point => !text(point, 160)) || new Set(command.points).size !== command.points.length))) return null;
      commandIds.add(command.id);
      for (const key of ['context', 'editor']) {
        const fields = command[key];
        if (fields !== undefined && (!Array.isArray(fields) || fields.length > 16 ||
            fields.some(field => !text(field, 160)) || new Set(fields).size !== fields.length)) return null;
      }
      if (command.defaultShortcut !== undefined) {
        const shortcut = command.defaultShortcut;
        if (!record(shortcut) || !text(shortcut.code, 64) ||
            ['meta', 'ctrl', 'alt', 'shift'].some(key => shortcut[key] !== undefined && typeof shortcut[key] !== 'boolean')) return null;
      }
    }
  }
  if (value.contributions === undefined) return value as unknown as GhostNativeUi;
  if (!Array.isArray(value.contributions) || value.contributions.length > 64) return null;
  const ids = new Set<string>();
  for (const item of value.contributions) {
    if (!record(item) || !text(item.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(item.id) ||
        !text(item.point, 160) || !text(item.scope, 64) || ids.has(item.id) ||
        (item.order !== undefined && (!Number.isSafeInteger(item.order) || Math.abs(item.order as number) > 10_000))) return null;
    ids.add(item.id);
    if (nativePoints.has(item.point) && item.page !== undefined &&
        (!isSafeGhostRelativePath(item.page) || !/\.html$/i.test(item.page))) return null;
    for (const key of ['context', 'editor']) {
      const fields = item[key];
      if (fields !== undefined && (!Array.isArray(fields) || fields.length > 16 ||
          fields.some(field => !text(field, 160)) || new Set(fields).size !== fields.length)) return null;
    }
    if ((item.point === 'message.body' || item.point === 'tool.body') && item.match !== undefined) {
      const match = item.match;
      if (!record(match) || !text(match.kind, 64) ||
          (match.name !== undefined && !text(match.name, 256)) ||
          (match.kind === 'plugin' && !text(match.instanceId, 256)) ||
          (match.kind === 'tool' && !text(match.name, 256))) return null;
    }
  }
  return value as unknown as GhostNativeUi;
}

/** Previously unknown persisted data must not disable an installed plugin.
 * Only historical readers use this; new package validation remains strict. */
export function validateWithStoredNativeUi<R extends { ok: boolean; manifest?: { ui?: unknown } }>(
  value: unknown, validate: (value: unknown) => R,
): R {
  const strict = validate(value);
  if (strict.ok || !record(value) || !Object.hasOwn(value, 'ui')) return strict;
  const rest = { ...value };
  delete rest.ui;
  const compatible = validate(rest);
  if (!compatible.ok) return compatible;
  return { ...compatible, manifest: { ...compatible.manifest, ui: value.ui } };
}
