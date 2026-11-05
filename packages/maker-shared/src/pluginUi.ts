import type { PluginUiAction, PluginUiActionResult, PluginUiBlock, PluginUiCapabilities,
  PluginUiContent, PluginUiContext, PluginUiControl, PluginUiScope, PluginUiComposerEdit, PluginUiValues, PluginUiOpenView, PluginUiData } from './pluginUiPublic.js';
export type * from './pluginUiPublic.js';

export const PLUGIN_UI_CONTEXT_FIELDS = ['session.summary', 'message.content', 'tool.input', 'tool.result', 'tool.status', 'selection'];
export const PLUGIN_UI_MAX_BYTES = 32 * 1024;
export const PLUGIN_UI_MAX_VIEWS_BYTES = 256 * 1024;
export const PLUGIN_UI_CAPABILITIES: PluginUiCapabilities = {
  version: 1, points: ['composer.tools', 'session.header.actions', 'session.statusbar', 'message.actions', 'turn.footer', 'message.body', 'tool.body'],
  primitives: ['button', 'select', 'status', 'markdown'], effects: ['composer-edit.append', 'composer-edit.replace-selection'], pages: ['html'],
  tabViews: true,
};

/** A statusbar stays in its existing single row; pages and editor effects use
 * their original outlets. Both Host and viewing adapter consume this contract. */
export function pluginUiCapabilitiesForPoint(point: string): PluginUiCapabilities {
  return point === 'session.statusbar'
    ? { ...PLUGIN_UI_CAPABILITIES, primitives: ['button', 'status'], effects: [], pages: [] }
    : PLUGIN_UI_CAPABILITIES;
}

export interface PluginUiView extends PluginUiContent {
  version: 1;
  viewId: string;
  contributionId: string;
  point: string;
  revision: string;
  /** Page path stays in Main; the renderer receives only a host-issued flag. */
  page?: true;
  command?: { shortcutId: string };
  editor?: { operations: PluginUiComposerEdit['operation'][]; readSelection: boolean };
}
/** Viewing endpoint snapshot; it never becomes an author's destination selector. */
export interface PluginUiEditorSnapshot {
  draftKey: string;
  revision: string;
  selection: { start: number; end: number };
  selectedText?: string;
}
export interface PluginUiComposerEffect extends PluginUiComposerEdit {
  kind: 'composer-edit'; operationId: string; draftKey: string; expectedDraftRevision: string;
  selection: { start: number; end: number };
}
export interface PluginUiInvokeInput {
  viewId: string;
  expectedRevision: string;
  invocationId: string;
  actionId: string;
  values: Record<string, string | number | boolean | string[]>;
  data?: PluginUiData;
  editor?: PluginUiEditorSnapshot;
}
export interface PluginUiInvocationResult extends Omit<PluginUiActionResult, 'edit' | 'openView'> {
  invocationId: string;
  effects?: PluginUiComposerEffect[];
  effectError?: 'UNSUPPORTED_EFFECT';
  /** Host-issued single-use navigation. The author cannot select an instance or window. */
  navigation?: { requestId: string };
  navigationError?: 'VIEW_UNAVAILABLE';
}
export type PluginUiPluginMessage =
  | { type: 'ui-register'; contributionId: string }
  | { type: 'ui-unregister'; contributionId: string }
  | { type: 'ui-command-register'; commandId: string }
  | { type: 'ui-command-unregister'; commandId: string }
  | { type: 'ui-dispose' }
  | { type: 'ui-capabilities-request'; requestId: string }
  | { type: 'ui-view-result'; requestId: string; viewId: string; content: unknown }
  | { type: 'ui-update'; contributionId: string; scope: PluginUiScope }
  | { type: 'ui-action-result'; invocationId: string; viewId: string; result: unknown };
export type PluginUiHostMessage =
  | { type: 'ui-capabilities-result'; requestId: string; capabilities: PluginUiCapabilities }
  | { type: 'ui-view-request'; requestId: string; viewId: string; contributionId: string; context: PluginUiContext }
  | { type: 'ui-view-cancel'; requestId: string }
  | { type: 'event'; name: 'ui-command'; commandId: string; invocationId: string;
      viewId: string; context: PluginUiContext }
  | { type: 'event'; name: 'ui-action'; contributionId: string; invocationId: string;
      viewId: string; actionId: string; values: PluginUiInvokeInput['values']; data?: PluginUiData; context: PluginUiContext };

export const pluginUiRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const pluginUiText = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const id = (value: unknown): value is string => pluginUiText(value, 64) && /^[a-zA-Z0-9_-]+$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';
const boundedBody = (value: unknown, max = 16000): value is string => typeof value === 'string' && value.length <= max;

function withinBudget(value: unknown, maxBytes = PLUGIN_UI_MAX_BYTES): boolean {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || json.length > maxBytes) return false;
    let bytes = 0;
    for (const character of json) {
      const cp = character.codePointAt(0)!;
      bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (bytes > maxBytes) return false;
    }
    return true;
  } catch { return false; }
}

export function parsePluginUiScope(value: unknown): PluginUiScope | null {
  if (!pluginUiRecord(value)) return null;
  if (!pluginUiText(value.sessionId)) return null;
  if (value.kind === 'session') return { kind: 'session', sessionId: value.sessionId };
  if (value.kind === 'message' && pluginUiText(value.messageClientId))
    return { kind: 'message', sessionId: value.sessionId, messageClientId: value.messageClientId };
  if (value.kind === 'tool' && pluginUiText(value.toolUseId))
    return { kind: 'tool', sessionId: value.sessionId, toolUseId: value.toolUseId };
  return null;
}

export function pluginUiPointAcceptsScope(point: string, scope: string): boolean {
  return ({ 'composer.tools': 'session', 'session.header.actions': 'session', 'session.statusbar': 'session', 'session.shortcuts': 'session',
    'message.actions': 'message', 'turn.footer': 'message',
    'message.shortcuts': 'message',
    'message.body': 'message', 'tool.body': 'tool' } as Record<string, string>)[point] === scope;
}

/** Strip unknown metadata rather than copying an author's Host binding fields. */
export function parsePluginUiContent(value: unknown, primitives = PLUGIN_UI_CAPABILITIES.primitives): PluginUiContent | null {
  if (!pluginUiRecord(value) || !withinBudget(value) || !boundedBody(value.fallbackMarkdown, PLUGIN_UI_MAX_BYTES) ||
      !Array.isArray(value.controls) || value.controls.length > 16 ||
      !Array.isArray(value.blocks) || value.blocks.length > 16 ||
      !Array.isArray(value.actions) || value.actions.length > 16) return null;
  const actions: PluginUiAction[] = [];
  const actionIds = new Set<string>();
  for (const a of value.actions) {
    if (!pluginUiRecord(a) || !id(a.id) || !pluginUiText(a.label, 1024) ||
        !optionalBoolean(a.disabled) || actionIds.has(a.id)) return null;
    actionIds.add(a.id);
    actions.push({ id: a.id, label: a.label, ...(a.disabled !== undefined ? { disabled: a.disabled as boolean } : {}) });
  }
  const controls: PluginUiControl[] = [];
  const controlIds = new Set<string>();
  let unsupportedRequired = false;
  for (const c of value.controls) {
    if (!pluginUiRecord(c) || !id(c.id) || controlIds.has(c.id) || !pluginUiText(c.label, 1024) ||
        !optionalBoolean(c.disabled) || !optionalBoolean(c.required) || !pluginUiText(c.kind, 160)) return null;
    controlIds.add(c.id);
    if (!['button', 'select', 'status'].includes(c.kind) || !primitives.includes(c.kind)) {
      unsupportedRequired ||= c.required === true;
      continue;
    }
    const base = { id: c.id, label: c.label,
      ...(c.disabled !== undefined ? { disabled: c.disabled as boolean } : {}),
      ...(c.required !== undefined ? { required: c.required as boolean } : {}) };
    if (c.kind === 'status') {
      if (!boundedBody(c.text)) return null;
      controls.push({ ...base, kind: 'status', text: c.text });
      continue;
    }
    if (!id(c.actionId) || !actionIds.has(c.actionId)) return null;
    if (c.kind === 'button') { controls.push({ ...base, kind: 'button', actionId: c.actionId }); continue; }
    if (!Array.isArray(c.options) || !c.options.length || c.options.length > 64 || !boundedBody(c.value, 1024)) return null;
    const options: { value: string; label: string }[] = [];
    for (const o of c.options) {
      if (!pluginUiRecord(o) || !boundedBody(o.value, 1024) || !pluginUiText(o.label, 1024) || options.some(x => x.value === o.value)) return null;
      options.push({ value: o.value, label: o.label });
    }
    if (!options.some(o => o.value === c.value)) return null;
    controls.push({ ...base, kind: 'select', actionId: c.actionId, value: c.value, options });
  }
  const blocks: PluginUiBlock[] = [];
  const blockIds = new Set<string>();
  for (const b of value.blocks) {
    if (!pluginUiRecord(b) || b.kind !== 'markdown' || !id(b.id) || blockIds.has(b.id) || !boundedBody(b.text)) return null;
    blockIds.add(b.id);
    if (primitives.includes('markdown')) blocks.push({ kind: 'markdown', id: b.id, text: b.text });
  }
  return { controls: unsupportedRequired ? [] : controls, blocks,
    actions: unsupportedRequired ? [] : actions, fallbackMarkdown: value.fallbackMarkdown };
}

export function parsePluginUiView(value: unknown): PluginUiView | null {
  if (!pluginUiRecord(value) || value.version !== 1 || !pluginUiText(value.viewId) || !id(value.contributionId) ||
      !pluginUiText(value.point, 160) || !pluginUiText(value.revision) ||
      (value.page !== undefined && value.page !== true)) return null;
  const content = parsePluginUiContent({ controls: value.controls, blocks: value.blocks,
    actions: value.actions, fallbackMarkdown: value.fallbackMarkdown });
  let editor: PluginUiView['editor'];
  let command: PluginUiView['command'];
  if (value.command !== undefined) {
    if (!pluginUiRecord(value.command) || typeof value.command.shortcutId !== 'string' ||
        !/^plugin:[a-f0-9]{64}$/.test(value.command.shortcutId)) return null;
    command = { shortcutId: value.command.shortcutId };
  }
  if (value.editor !== undefined) {
    if (!pluginUiRecord(value.editor) || !Array.isArray(value.editor.operations) ||
        value.editor.operations.length > 2 || new Set(value.editor.operations).size !== value.editor.operations.length ||
        !value.editor.operations.every(v => v === 'append' || v === 'replace-selection') || typeof value.editor.readSelection !== 'boolean') return null;
    editor = { operations: value.editor.operations as PluginUiComposerEdit['operation'][], readSelection: value.editor.readSelection };
  }
  return content ? { ...content, version: 1, viewId: value.viewId, contributionId: value.contributionId,
    point: value.point, revision: value.revision, ...(value.page ? { page: true as const } : {}),
    ...(editor ? { editor } : {}), ...(command ? { command } : {}) } : null;
}

export function parsePluginUiViews(value: unknown): PluginUiView[] | null {
  if (!Array.isArray(value) || value.length > 64 || !withinBudget(value, PLUGIN_UI_MAX_VIEWS_BYTES)) return null;
  const views: PluginUiView[] = [];
  for (const candidate of value) {
    const view = parsePluginUiView(candidate);
    if (!view || views.some(v => v.viewId === view.viewId)) return null;
    views.push(view);
  }
  return views;
}

/** Called after the existing JSON byte budget, which also rejects cycles. */
function isPluginUiData(value: unknown): value is PluginUiData {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue; }
    if (pluginUiRecord(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const child of Object.values(item)) pending.push(child);
      continue;
    }
    return false;
  }
  return true;
}

export function parsePluginUiActionResult(value: unknown): PluginUiActionResult | null {
  if (!pluginUiRecord(value) || !['completed', 'rejected', 'outcome-unknown'].includes(String(value.status)) ||
      (value.reason !== undefined && !pluginUiText(value.reason, 1024)) ||
      (value.effects !== undefined && (!Array.isArray(value.effects) || value.effects.length > 0))) return null;
  if (value.data !== undefined && (!withinBudget(value) || !isPluginUiData(value.data))) return null;
  let edit: PluginUiComposerEdit | undefined;
  if (value.edit !== undefined) {
    if (value.status !== 'completed' || !pluginUiRecord(value.edit) ||
        !['append', 'replace-selection'].includes(String(value.edit.operation)) || !boundedBody(value.edit.text)) return null;
    edit = { operation: value.edit.operation as PluginUiComposerEdit['operation'], text: value.edit.text };
  }
  let openView: PluginUiOpenView | undefined;
  if (value.openView !== undefined) {
    const request = value.openView;
    if (value.status !== 'completed' || !pluginUiRecord(request) || !id(request.id)) return null;
    const params = request.params === undefined ? undefined : parsePluginUiValues(request.params);
    if (params === null) return null;
    openView = { id: request.id, ...(params ? { params } : {}) };
  }
  return { status: value.status as PluginUiActionResult['status'], ...(value.reason !== undefined ? { reason: value.reason as string } : {}),
    ...(value.data !== undefined ? { data: value.data as PluginUiData } : {}), ...(edit ? { edit } : {}), ...(openView ? { openView } : {}) };
}

export function parsePluginUiValues(value: unknown): PluginUiValues | null {
  if (!pluginUiRecord(value) || Object.keys(value).length > 16 || !withinBudget(value)) return null;
  for (const [key, v] of Object.entries(value)) {
    if (!id(key) || !(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
        boundedBody(v) || (Array.isArray(v) && v.length <= 64 && v.every(s => boundedBody(s, 1024))))) return null;
  }
  return value as PluginUiValues;
}

export function parsePluginUiEditorSnapshot(value: unknown): PluginUiEditorSnapshot | null {
  if (!pluginUiRecord(value) || !pluginUiText(value.draftKey) || !pluginUiText(value.revision) || !pluginUiRecord(value.selection) ||
      !Number.isSafeInteger(value.selection.start) || !Number.isSafeInteger(value.selection.end) ||
      (value.selection.start as number) < 0 || (value.selection.end as number) < (value.selection.start as number) ||
      (value.selection.end as number) > 10_000_000 || (value.selectedText !== undefined && !boundedBody(value.selectedText))) return null;
  return { draftKey: value.draftKey, revision: value.revision, selection: { start: value.selection.start as number, end: value.selection.end as number },
    ...(value.selectedText !== undefined ? { selectedText: value.selectedText as string } : {}) };
}

export function parsePluginUiInvocationResult(value: unknown): PluginUiInvocationResult | null {
  if (!pluginUiRecord(value) || !pluginUiText(value.invocationId)) return null;
  const result = parsePluginUiActionResult({ status: value.status, reason: value.reason, data: value.data });
  if (!result || (value.effectError !== undefined && value.effectError !== 'UNSUPPORTED_EFFECT')) return null;
  let effects: PluginUiComposerEffect[] | undefined;
  if (value.effects !== undefined) {
    if (result.status !== 'completed' || !Array.isArray(value.effects) || value.effects.length > 1) return null;
    effects = [];
    for (const effect of value.effects) {
      if (!pluginUiRecord(effect) || effect.kind !== 'composer-edit' || !pluginUiText(effect.operationId)) return null;
      const snapshot = parsePluginUiEditorSnapshot({ draftKey: effect.draftKey, revision: effect.expectedDraftRevision, selection: effect.selection });
      const edit = parsePluginUiActionResult({ status: 'completed', edit: effect })?.edit;
      if (!snapshot || !edit) return null;
      effects.push({ kind: 'composer-edit', operationId: effect.operationId, draftKey: snapshot.draftKey,
        expectedDraftRevision: snapshot.revision, selection: snapshot.selection, ...edit });
    }
  }
  if (value.navigation !== undefined && (result.status !== 'completed' || !pluginUiRecord(value.navigation) || !pluginUiText(value.navigation.requestId))) return null;
  if (value.navigationError !== undefined && value.navigationError !== 'VIEW_UNAVAILABLE') return null;
  return { ...result, invocationId: value.invocationId, ...(effects ? { effects } : {}), ...(value.effectError ? { effectError: 'UNSUPPORTED_EFFECT' } : {}),
    ...(pluginUiRecord(value.navigation) ? { navigation: { requestId: value.navigation.requestId as string } } : {}),
    ...(value.navigationError ? { navigationError: 'VIEW_UNAVAILABLE' } : {}) };
}

export function parsePluginUiInvokeInput(value: unknown): PluginUiInvokeInput | null {
  if (!pluginUiRecord(value) || !pluginUiText(value.viewId) || !pluginUiText(value.expectedRevision) ||
      !pluginUiText(value.invocationId) || !id(value.actionId) || !withinBudget(value)) return null;
  const values = parsePluginUiValues(value.values);
  if (!values) return null;
  if (value.data !== undefined && !isPluginUiData(value.data)) return null;
  const editor = value.editor === undefined ? undefined : parsePluginUiEditorSnapshot(value.editor);
  if (editor === null) return null;
  return { viewId: value.viewId, expectedRevision: value.expectedRevision, invocationId: value.invocationId,
    actionId: value.actionId, values, ...(value.data !== undefined ? { data: value.data as PluginUiData } : {}), ...(editor ? { editor } : {}) };
}
