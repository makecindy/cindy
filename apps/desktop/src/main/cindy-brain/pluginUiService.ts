import { randomUUID, createHash } from 'node:crypto';
import { parseGhostNativeUi, type GhostNativeUiContribution, type GhostNativeUiCommand } from '@cindy/plugin-protocol';
import { PLUGIN_UI_CAPABILITIES, PLUGIN_UI_CONTEXT_FIELDS, PLUGIN_UI_MAX_VIEWS_BYTES, parsePluginUiContent, parsePluginUiActionResult,
  parsePluginUiInvokeInput, parsePluginUiScope, pluginUiPointAcceptsScope, pluginUiCapabilitiesForPoint, pluginUiRecord, pluginUiText,
  type PluginUiCapabilities, type PluginUiContent, type PluginUiHostMessage,
  type PluginUiInvocationResult, type PluginUiInvokeInput, type PluginUiScope, type PluginUiView,
  type PluginUiContext, type PluginUiEditorSnapshot, type PluginUiComposerEffect, type PluginUiValues, type PluginUiNavigationResult } from '@cindy/maker-shared';
import type { PluginUiReadRequest, PluginUiReadResult, PluginUiRendererSource, PluginUiRendererTarget, PluginUiRendererChoice } from '../../shared/pluginUi.js';
import { normalizeAppShortcutCombo, type PluginShortcutDefinition, type PluginShortcutId } from '../../shared/appShortcuts.js';

export interface PluginUiInstance { id: string; token: string; ui: unknown; shortcutScope?: string; name?: string }

/** The renderer may not claim that a task belongs to this machine. */
export function isLocalPluginUiSession(row: { remoteHostId?: string | null; agentDeviceId?: string | null } | null): boolean {
  return !!row && row.remoteHostId === null && row.agentDeviceId === null;
}

/** Saved source is a display identity, never an authorization grant. */
export interface PluginUiRendererCandidate { instanceId: string; contribution: GhostNativeUiContribution }

/** Resolve only declared identities; a missing or obsolete choice keeps the original view. */
export function selectPluginUiRenderer<T extends PluginUiRendererCandidate>(input: {
  point: 'message.body' | 'tool.body'; source?: PluginUiRendererSource;
  candidates: readonly T[]; choice?: PluginUiRendererChoice | null; legacy?: boolean;
}): { candidates: T[]; selected?: T } {
  const source = input.source;
  if (!source || input.legacy) return { candidates: [] };
  const candidates = input.candidates.filter(({ instanceId, contribution }) => {
    const match = contribution.match;
    if (contribution.point !== input.point || !match ||
        (match.name !== undefined && match.name !== source.name)) return false;
    if (match.kind === 'self') return source.kind === 'plugin' && source.instanceId === instanceId;
    if (match.kind === 'plugin') return source.kind === 'plugin' && source.instanceId === match.instanceId;
    return input.point === 'tool.body' && match.kind === 'tool' && match.name === source.name;
  });
  const selected = input.choice === undefined
    ? candidates.length === 1 && source.kind === 'plugin' && candidates[0].instanceId === source.instanceId
      ? candidates[0] : undefined
    : input.choice === null ? undefined
      : candidates.find(candidate => candidate.instanceId === input.choice?.instanceId &&
          candidate.contribution.id === input.choice.contributionId);
  return { candidates, ...(selected ? { selected } : {}) };
}
function commandShortcutId(instance: PluginUiInstance, commandId: string): PluginShortcutId | undefined {
  if (!instance.shortcutScope) return undefined;
  return `plugin:${createHash('sha256').update(JSON.stringify([instance.shortcutScope, instance.id, commandId])).digest('hex')}`;
}
/** Settings and views use the same stable, owner-scoped identity. */
export function pluginCommandShortcuts(instances: readonly PluginUiInstance[]): PluginShortcutDefinition[] {
  return instances.flatMap(instance => {
    const ui = parseGhostNativeUi(instance.ui);
    if (ui?.version !== 1) return [];
    return (ui.commands ?? []).flatMap(command => {
      const id = commandShortcutId(instance, command.id);
      if (!id || (command.scope !== 'session' && command.scope !== 'message')) return [];
      const scope: PluginShortcutDefinition['scope'] = command.scope;
      const defaultCombo = normalizeAppShortcutCombo(command.defaultShortcut);
      return [{ id, label: command.title, pluginName: instance.name ?? instance.id, instanceId: instance.id, scope,
        ...(command.points ? { points: [...command.points] } : {}),
        ...(defaultCombo ? { defaultCombo } : {}) }];
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
}
interface Instance extends PluginUiInstance { contributions: GhostNativeUiContribution[]; commands: GhostNativeUiCommand[] }
interface Binding {
  id: string; key: string; instanceId: string; token: string; controller: string;
  contribution: GhostNativeUiContribution; scope: PluginUiScope; capabilities: PluginUiCapabilities;
  command?: GhostNativeUiCommand;
  shortcutId?: PluginShortcutId;
  generation: number; revision: number; dirty: boolean; content?: PluginUiContent;
  supportsComposer: boolean;
  subscriptionId?: string;
  renderer?: { target: PluginUiRendererTarget; choice: PluginUiRendererChoice | null | undefined; generation: number };
  reading?: Promise<PluginUiView | null>; stage: string; touched: number;
  guard(): boolean;
}
interface Query { binding: Binding; generation: number; resolve(content: PluginUiContent | null): void }
interface Subscription { controller: string; id: string; scopeKey?: string; closed: boolean; touched: number; current(): boolean }
interface Invocation {
  sequence: number;
  binding: Binding; input: PluginUiInvokeInput; fingerprint: string; result: Promise<PluginUiInvocationResult>;
  settle(result: PluginUiInvocationResult): void; settled: boolean; settling: boolean;
  guard(): boolean;
}
export class PluginUiError extends Error {
  constructor(readonly code: 'INVALID_PARAMS' | 'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY', message: string) { super(message); }
}
interface PluginUiAccess { current(): boolean; allows(instanceId: string): boolean }
interface Dependencies {
  current(id: string): PluginUiInstance | null;
  wake(id: string): Promise<boolean>;
  authorize(sessionId: string, controller: string): Promise<PluginUiAccess>;
  resolveScope?(sessionId: string, point: string, target?: PluginUiReadRequest['target']): Promise<PluginUiScope | null>;
  resolveRendererSource?(scope: PluginUiScope): Promise<{ source?: PluginUiRendererSource; legacy?: boolean }>;
  readRendererChoice?(target: PluginUiRendererTarget): PluginUiRendererChoice | null | undefined;
  writeRendererChoice?(target: PluginUiRendererTarget, choice: PluginUiRendererChoice | null): Promise<void>;
  readContext?(scope: PluginUiScope, fields: readonly string[]): Promise<Pick<PluginUiContext, 'session' | 'message' | 'tool'>>;
  send(id: string, message: PluginUiHostMessage): boolean;
  changed(sessionId?: string): void;
  bindingRemoved?(viewId: string): void;
  prepareNavigation?(input: { controller: string; instanceId: string; id: string; sessionId: string | null;
    params: PluginUiValues; sequence: number; current(): boolean }): { requestId: string };
  navigate?(controller: string, requestId: string): Promise<PluginUiNavigationResult>;
  queryTimeoutMs?: number;
  actionTimeoutMs?: number;
}

/** Host-owned ephemeral bindings, never a second store of plugin business state. */
export class PluginUiService {
  private readonly instances = new Map<string, Instance>();
  private readonly registrations = new Map<string, Set<string>>();
  private readonly bindings = new Map<string, Binding>();
  private readonly bindingKeys = new Map<string, string>();
  private readonly queries = new Map<string, Query>();
  private readonly invocations = new Map<string, Invocation>();
  private readonly subscriptions = new Map<string, Subscription>();
  private rendererGeneration = 0;
  private actionSequence = 0;
  constructor(private readonly deps: Dependencies) {}

  reconcile(instances: readonly PluginUiInstance[]): void {
    this.rendererGeneration++;
    const next = new Map(instances.map(i => [i.id, i]));
    for (const [id, before] of this.instances) {
      if (next.get(id)?.token !== before.token) this.revoke(id);
    }
    this.instances.clear();
    for (const item of instances) {
      const ui = parseGhostNativeUi(item.ui);
      if (ui?.version === 1) this.instances.set(item.id, { ...item, contributions: ui.contributions ?? [], commands: ui.commands ?? [] });
    }
    // Installation and workdir-policy changes must also refresh an empty outlet.
    this.deps.changed();
  }

  runtimeChanged(instanceId: string): void {
    this.rendererGeneration++;
    this.revoke(instanceId);
    const current = this.deps.current(instanceId);
    const ui = current && parseGhostNativeUi(current.ui);
    if (current && ui?.version === 1) this.instances.set(instanceId, { ...current, contributions: ui.contributions ?? [], commands: ui.commands ?? [] });
    else this.instances.delete(instanceId);
    this.deps.changed();
  }

  revoke(instanceId: string): void {
    this.registrations.delete(instanceId);
    for (const binding of [...this.bindings.values()]) if (binding.instanceId === instanceId) this.removeBinding(binding);
  }

  private removeBinding(binding: Binding): void {
    if (this.bindings.get(binding.id) !== binding) return;
    this.bindings.delete(binding.id); this.bindingKeys.delete(binding.key);
    this.deps.bindingRemoved?.(binding.id);
    for (const [requestId, q] of [...this.queries]) if (q.binding === binding) {
      q.resolve(null); this.deps.send(binding.instanceId, { type: 'ui-view-cancel', requestId });
    }
    for (const invocation of [...this.invocations.values()]) if (invocation.binding === binding) {
      invocation.settle({ invocationId: invocation.input.invocationId, status: 'outcome-unknown' });
      this.invocations.delete(this.invocationKey(binding.id, invocation.input.invocationId));
    }
  }

  private current(binding: Binding): boolean {
    return this.bindings.get(binding.id) === binding && binding.guard() && this.deps.current(binding.instanceId)?.token === binding.token;
  }

  release(controller: string, subscriptionId: string): void {
    const key = JSON.stringify([controller, subscriptionId]);
    const subscription = this.subscriptions.get(key);
    if (subscription?.closed) return;
    if (!subscription && this.subscriptions.size >= 4096) return;
    if (subscription) { subscription.closed = true; subscription.touched = Date.now(); }
    else this.subscriptions.set(key, { controller, id: subscriptionId, closed: true, touched: Date.now(), current: () => false });
    for (const binding of [...this.bindings.values()])
      if (binding.controller === controller && binding.subscriptionId === subscriptionId) this.removeBinding(binding);
  }

  private subscribe(controller: string, request: PluginUiReadRequest, current: () => boolean): () => boolean {
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.closed ? Date.now() - subscription.touched > 300_000 : !subscription.current()) {
        this.release(subscription.controller, subscription.id); this.subscriptions.delete(key);
      }
    }
    for (const binding of [...this.bindings.values()]) if (!this.current(binding)) this.removeBinding(binding);
    if (!request.subscriptionId) return current;
    const key = JSON.stringify([controller, request.subscriptionId]);
    const scopeKey = JSON.stringify([request.sessionId, request.point, request.target]);
    let subscription = this.subscriptions.get(key);
    if (subscription && (subscription.closed || subscription.scopeKey !== scopeKey))
      throw new PluginUiError('NOT_FOUND', 'UI subscription unavailable');
    if (!subscription) {
      if (this.subscriptions.size >= 4096) throw new PluginUiError('UNSUPPORTED_CAPABILITY', 'UI subscription budget exhausted');
      subscription = { controller, id: request.subscriptionId, scopeKey, closed: false, touched: Date.now(), current };
      this.subscriptions.set(key, subscription);
    }
    subscription.touched = Date.now();
    const original = subscription;
    return () => this.subscriptions.get(key) === original && !original.closed && original.current() && current();
  }

  private supported(c: GhostNativeUiContribution): boolean {
    return PLUGIN_UI_CAPABILITIES.points.includes(c.point) && pluginUiPointAcceptsScope(c.point, c.scope) &&
      (!c.page || pluginUiCapabilitiesForPoint(c.point).pages.includes('html'));
  }
  private async rendererState(scope: PluginUiScope, point: PluginUiRendererTarget['point'], access: PluginUiAccess, capabilities: PluginUiCapabilities) {
    const resolved = await this.deps.resolveRendererSource?.(scope);
    if (!resolved?.source) return null;
    const target: PluginUiRendererTarget = { point, source: resolved.source };
    const choice = this.deps.readRendererChoice?.(target);
    const candidates = [...this.instances.values()].flatMap(instance => access.allows(instance.id)
      ? instance.contributions.filter(contribution => this.supported(contribution) && contribution.point === point &&
          (!contribution.page || capabilities.pages.includes('html')))
        .map(contribution => ({ instanceId: instance.id, instance, contribution, command: undefined as GhostNativeUiCommand | undefined })) : []);
    candidates.sort((a, b) => a.instanceId.localeCompare(b.instanceId) || a.contribution.id.localeCompare(b.contribution.id));
    return { target, choice, ...selectPluginUiRenderer({ point, source: resolved.source, candidates, choice, legacy: resolved.legacy }) };
  }

  async chooseRenderer(controller: string, request: PluginUiReadRequest, choice: PluginUiRendererChoice | null, isCurrent = () => true): Promise<void> {
    if ((request.point !== 'message.body' && request.point !== 'tool.body') || !request.sessionId) throw new PluginUiError('INVALID_PARAMS', 'Invalid renderer point');
    const access = await this.deps.authorize(request.sessionId, controller);
    const scope = await this.deps.resolveScope?.(request.sessionId, request.point, request.target);
    if (!scope || scope.sessionId !== request.sessionId || !pluginUiPointAcceptsScope(request.point, scope.kind) || !access.current() || !isCurrent())
      throw new PluginUiError('NOT_FOUND', 'UI target unavailable');
    const state = await this.rendererState(scope, request.point, access, request.capabilities);
    if (!state || !state.candidates.length || (choice && !state.candidates.some(c =>
      c.instanceId === choice.instanceId && c.contribution.id === choice.contributionId)) || !access.current() || !isCurrent() || !this.deps.writeRendererChoice)
      throw new PluginUiError('NOT_FOUND', 'Renderer unavailable');
    await this.deps.writeRendererChoice(state.target, choice);
    this.rendererGeneration++;
    for (const binding of [...this.bindings.values()]) if (binding.renderer) this.removeBinding(binding);
    if (!access.current() || !isCurrent()) throw new PluginUiError('NOT_FOUND', 'UI context changed');
    this.deps.changed();
  }

  private async rendererCurrent(binding: Binding): Promise<boolean> {
    if (!binding.renderer) return true;
    if (binding.renderer.generation !== this.rendererGeneration || !this.current(binding)) return false;
    const current = await this.deps.resolveRendererSource?.(binding.scope);
    return !!current?.source && !current.legacy && JSON.stringify(current.source) === JSON.stringify(binding.renderer.target.source) &&
      JSON.stringify(this.deps.readRendererChoice?.(binding.renderer.target)) === JSON.stringify(binding.renderer.choice) && this.current(binding);
  }
  private registrationKey(kind: 'command' | 'contribution', id: string): string { return JSON.stringify([kind, id]); }

  /** Caller has already resolved the real logic frame to this physical instance. */
  handle(instanceId: string, raw: unknown): unknown {
    if (!pluginUiRecord(raw)) return { ok: false };
    if (raw.type === 'ui-capabilities-request' && pluginUiText(raw.requestId))
      return { requestId: raw.requestId, capabilities: PLUGIN_UI_CAPABILITIES };
    const instance = this.instances.get(instanceId);
    if (!instance || this.deps.current(instanceId)?.token !== instance.token) return { ok: false };
    if (raw.type === 'ui-register' || raw.type === 'ui-unregister' ||
        raw.type === 'ui-command-register' || raw.type === 'ui-command-unregister') {
      const command = raw.type === 'ui-command-register' || raw.type === 'ui-command-unregister';
      const id = command ? raw.commandId : raw.contributionId;
      const declaration = command ? instance.commands.find(c => c.id === id) : instance.contributions.find(c => c.id === id);
      const supported = command
        ? declaration && (declaration.scope === 'session' || declaration.scope === 'message')
        : declaration && this.supported(declaration as GhostNativeUiContribution);
      if (!declaration || !supported || typeof id !== 'string') return { ok: false };
      const key = this.registrationKey(command ? 'command' : 'contribution', id);
      let registered = this.registrations.get(instanceId);
      if (!registered) this.registrations.set(instanceId, (registered = new Set()));
      if (raw.type === 'ui-register' || raw.type === 'ui-command-register') registered.add(key);
      else {
        registered.delete(key);
        for (const b of [...this.bindings.values()]) if (b.instanceId === instanceId && b.contribution.id === id && !!b.command === command) this.removeBinding(b);
      }
      this.deps.changed(); return { ok: true };
    }
    if (raw.type === 'ui-dispose') { this.revoke(instanceId); this.deps.changed(); return { ok: true }; }
    if (raw.type === 'ui-view-result') {
      const q = this.queries.get(String(raw.requestId));
      if (q && q.binding.instanceId === instanceId && q.binding.id === raw.viewId && this.current(q.binding)) {
        const content = parsePluginUiContent(raw.content, q.binding.capabilities.primitives);
        const unsupported = pluginUiRecord(raw.content) && Array.isArray(raw.content.controls) && raw.content.controls.some(c =>
          pluginUiRecord(c) && c.required === true && !q.binding.capabilities.primitives.includes(String(c.kind)));
        q.binding.stage = !content ? 'invalid-content' : unsupported ? 'unsupported-primitive' : 'rendered'; q.resolve(content);
      }
      return { ok: true };
    }
    if (raw.type === 'ui-update') {
      const scope = parsePluginUiScope(raw.scope);
      if (!scope || !pluginUiText(raw.contributionId, 64)) return { ok: false };
      let changed = false;
      for (const b of this.bindings.values()) if (!b.command && b.instanceId === instanceId && b.contribution.id === raw.contributionId &&
          JSON.stringify(b.scope) === JSON.stringify(scope) && this.current(b)) {
        b.generation++; b.dirty = true; changed = true;
      }
      if (changed) this.deps.changed(scope.sessionId);
      return { ok: true };
    }
    if (raw.type === 'ui-action-result') {
      const invocation = this.invocations.get(this.invocationKey(String(raw.viewId), String(raw.invocationId)));
      if (invocation && invocation.binding.instanceId === instanceId && this.current(invocation.binding) &&
          !invocation.settled && !invocation.settling) {
        const result = parsePluginUiActionResult(raw.result);
        invocation.settling = true;
        void this.finishAction(invocation, result ?? { status: 'outcome-unknown' });
      }
      return { ok: true };
    }
    return { ok: false };
  }

  async read(controller: string, request: PluginUiReadRequest, isCurrent = () => true): Promise<PluginUiReadResult> {
    const sessionId = request.sessionId;
    if (!pluginUiText(sessionId))
      throw new PluginUiError('INVALID_PARAMS', 'Invalid UI scope');
    const subscribed = this.subscribe(controller, request, isCurrent);
    const access = await this.deps.authorize(sessionId, controller);
    const guard = () => access.current() && subscribed();
    if (!guard() || !isCurrent()) throw new PluginUiError('NOT_FOUND', 'UI context unavailable');
    const sessionShortcuts = request.point === 'session.shortcuts', messageShortcuts = request.point === 'message.shortcuts';
    if (!PLUGIN_UI_CAPABILITIES.points.includes(request.point) && !sessionShortcuts && !messageShortcuts)
      throw new PluginUiError('UNSUPPORTED_CAPABILITY', 'UI point unavailable');
    const scope: PluginUiScope | null = pluginUiPointAcceptsScope(request.point, 'session') && !request.target
      ? { kind: 'session', sessionId }
      : await this.deps.resolveScope?.(sessionId, request.point, request.target) ?? null;
    if (!scope || scope.sessionId !== sessionId || !pluginUiPointAcceptsScope(request.point, scope.kind) || !guard() || !isCurrent())
      throw new PluginUiError('NOT_FOUND', 'UI target unavailable');
    const turnScope = messageShortcuts ? await this.deps.resolveScope?.(sessionId, 'turn.footer', request.target) : null;
    if (!guard() || !isCurrent()) throw new PluginUiError('NOT_FOUND', 'UI context changed');
    const available = pluginUiCapabilitiesForPoint(request.point);
    const supportsComposer = available.effects.some(effect => request.capabilities.effects.includes(effect));
    const renderer = request.point === 'message.body' || request.point === 'tool.body'
      ? await this.rendererState(scope, request.point, access, request.capabilities) : null;
    if (!guard() || !isCurrent()) throw new PluginUiError('NOT_FOUND', 'UI context changed');
    const normalCandidates = [...this.instances.values()].flatMap(i => {
      if (!access.allows(i.id)) return [];
      const contributions = i.contributions.filter(c => c.point === request.point && this.supported(c) &&
        (!c.page || request.capabilities.pages.includes('html')))
        .map(contribution => ({ instance: i, contribution, command: undefined as GhostNativeUiCommand | undefined }));
      const commands = i.commands.filter(c => request.capabilities.primitives.includes('button') &&
        (sessionShortcuts ? c.scope === 'session' : messageShortcuts ? c.scope === 'message' &&
          (!c.points?.length || c.points.includes('message.actions') || (!!turnScope && c.points.includes('turn.footer')))
          : c.points?.includes(request.point)))
        .map(command => ({ instance: i, command, contribution: { id: command.id, point: request.point, scope: command.scope,
          context: command.context, editor: command.editor } as GhostNativeUiContribution }))
        .filter(c => (sessionShortcuts || messageShortcuts) ? pluginUiPointAcceptsScope(request.point, c.contribution.scope) : this.supported(c.contribution));
      return [...contributions, ...commands];
    })
      .sort((a, b) => (a.contribution.order ?? 0) - (b.contribution.order ?? 0) ||
        a.instance.id.localeCompare(b.instance.id) || a.contribution.id.localeCompare(b.contribution.id)).slice(0, 64);
    const isRenderer = request.point === 'message.body' || request.point === 'tool.body';
    const candidates = isRenderer ? renderer?.selected ? [renderer.selected] : [] : normalCandidates;
    const rendererGeneration = this.rendererGeneration;
    const views = await Promise.all(candidates.map(async ({ instance, contribution, command }) => {
      if (!await this.deps.wake(instance.id) || !guard() || !isCurrent() || !access.allows(instance.id)) return null;
      const current = this.instances.get(instance.id);
      if (!current || this.deps.current(instance.id)?.token !== current.token ||
          !this.registrations.get(instance.id)?.has(this.registrationKey(command ? 'command' : 'contribution', contribution.id))) return null;
      const capabilities: PluginUiCapabilities = { version: 1, points: [request.point],
        primitives: available.primitives.filter(p => request.capabilities.primitives.includes(p)),
        effects: available.effects.filter(effect => supportsComposer && request.capabilities.effects.includes(effect) &&
          contribution.editor?.some(operation => effect === `composer-edit.${operation}`)),
        pages: contribution.page ? available.pages.filter(p => request.capabilities.pages.includes(p)) : [],
        ...(request.capabilities.tabViews === true && available.tabViews ? { tabViews: true } : {}) };
      const key = JSON.stringify([controller, request.subscriptionId, instance.id, command ? 'command' : 'contribution', contribution.id, scope, capabilities, supportsComposer]);
      let binding = this.bindings.get(this.bindingKeys.get(key) ?? '');
      if (!binding || !this.current(binding)) {
        if (binding) this.removeBinding(binding);
        // Live subscriptions own their lifetime; only unowned reads expire by age.
        for (const b of [...this.bindings.values()]) if (!b.subscriptionId && Date.now() - b.touched > 300_000) this.removeBinding(b);
        if (this.bindings.size >= 1024) throw new PluginUiError('UNSUPPORTED_CAPABILITY', 'UI view budget exhausted');
        binding = { id: randomUUID(), key, instanceId: instance.id, token: current.token, controller,
          contribution, command, shortcutId: command ? commandShortcutId(instance, command.id) : undefined,
          scope, capabilities, supportsComposer, subscriptionId: request.subscriptionId,
          ...(renderer ? { renderer: { target: renderer.target, choice: renderer.choice, generation: rendererGeneration } } : {}),
          generation: 0, revision: 0, dirty: true, stage: 'registered', touched: Date.now(),
          guard: () => guard() && isCurrent() && access.allows(instance.id) && (!isRenderer || rendererGeneration === this.rendererGeneration) };
        this.bindings.set(binding.id, binding); this.bindingKeys.set(key, binding.id);
      }
      binding.touched = Date.now();
      const result = await this.readBinding(binding);
      return guard() && isCurrent() ? result : null;
    }));
    if (!guard() || !isCurrent()) throw new PluginUiError('NOT_FOUND', 'UI context changed');
    let bytes = 2; // JSON array brackets; include separators in the shared budget.
    const visible = views.filter((v): v is PluginUiView => {
      if (!v) return false;
      const size = Buffer.byteLength(JSON.stringify(v), 'utf8') + 1;
      if (bytes + size > PLUGIN_UI_MAX_VIEWS_BYTES) return false;
      bytes += size; return true;
    });
    return { views: visible, revision: createHash('sha256').update(JSON.stringify(visible.map(v => [v.viewId, v.revision]))).digest('hex'),
      ...(renderer ? { renderer: { candidates: renderer.candidates.map(c => ({ instanceId: c.instanceId,
        contributionId: c.contribution.id, pluginName: c.instance.name ?? c.instanceId })),
        ...(renderer.selected ? { selected: { instanceId: renderer.selected.instanceId, contributionId: renderer.selected.contribution.id } } : {}),
        preference: renderer.choice === undefined ? 'automatic' as const : renderer.choice === null ? 'original' as const : 'selected' as const } } : {}) };
  }

  private async readBinding(binding: Binding): Promise<PluginUiView | null> {
    if (binding.command && !binding.content) {
      const title = binding.command.title;
      binding.content = { controls: [{ kind: 'button', id: 'run', label: title, actionId: 'run' }],
        blocks: [], actions: [{ id: 'run', label: title }], fallbackMarkdown: title };
      binding.dirty = false; binding.revision++;
    }
    if (binding.reading) return binding.reading;
    if (!binding.dirty && binding.content && this.current(binding)) return this.project(binding);
    const pending = (async () => {
      const deadline = Date.now() + (this.deps.queryTimeoutMs ?? 5_000);
      do {
        const generation = binding.generation;
        const content = await this.query(binding, Math.max(0, deadline - Date.now()));
        if (!this.current(binding)) return null;
        if (binding.generation !== generation) continue;
        if (!content) return null;
        binding.content = content; binding.dirty = false; binding.revision++;
        return this.project(binding);
      } while (Date.now() < deadline);
      return null;
    })();
    binding.reading = pending;
    try { return await pending; } finally { if (binding.reading === pending) binding.reading = undefined; }
  }

  private query(binding: Binding, budget: number): Promise<PluginUiContent | null> {
    return new Promise(resolve => {
      const requestId = randomUUID();
      const finish = (content: PluginUiContent | null) => {
        if (this.queries.get(requestId) !== query) return;
        clearTimeout(timer); this.queries.delete(requestId); resolve(content);
      };
      const timer = setTimeout(() => {
        binding.stage = 'query-timeout'; finish(null);
        this.deps.send(binding.instanceId, { type: 'ui-view-cancel', requestId });
      }, budget);
      const query: Query = { binding, generation: binding.generation, resolve: finish };
      this.queries.set(requestId, query); binding.stage = 'querying';
      void this.context(binding).then(context => {
        if (this.queries.get(requestId) !== query || !this.current(binding)) return;
        if (!this.deps.send(binding.instanceId, { type: 'ui-view-request', requestId, viewId: binding.id,
          contributionId: binding.contribution.id, context })) finish(null);
      }, () => finish(null));
    });
  }

  private project(b: Binding): PluginUiView {
    const operations = b.capabilities.effects.map(effect => effect.slice('composer-edit.'.length)) as NonNullable<PluginUiView['editor']>['operations'];
    const readSelection = b.supportsComposer && !!b.contribution.context?.includes('selection');
    return { ...b.content!, version: 1, viewId: b.id, contributionId: b.contribution.id,
      point: b.contribution.point, revision: String(b.revision), ...(operations.length || readSelection ? { editor: { operations, readSelection } } : {}),
      ...(b.contribution.page && b.capabilities.pages.includes('html') ? { page: true as const } : {}),
      ...(b.shortcutId ? { command: { shortcutId: b.shortcutId } } : {}) };
  }

  private async context(b: Binding, editor?: PluginUiEditorSnapshot, action = false): Promise<PluginUiContext> {
    if (!await this.rendererCurrent(b)) throw new PluginUiError('NOT_FOUND', 'Renderer changed');
    const fields = (b.contribution.context ?? []).filter(field => PLUGIN_UI_CONTEXT_FIELDS.includes(field) && field !== 'selection');
    const data = fields.length ? await this.deps.readContext?.(b.scope, fields) ?? {} : {};
    const context: PluginUiContext = { scope: b.scope, capabilities: action && !editor ? { ...b.capabilities, effects: [] } : b.capabilities };
    if (fields.includes('session.summary') && data.session && data.session.id === b.scope.sessionId)
      context.session = { id: data.session.id, title: data.session.title.slice(0, 1024), status: data.session.status,
        ...(data.session.agentKind ? { agentKind: data.session.agentKind } : {}) };
    if (fields.includes('message.content') && b.scope.kind === 'message' && data.message?.id === b.scope.messageClientId)
      context.message = { id: data.message.id, role: data.message.role, text: data.message.text.slice(0, 16000) };
    if (b.scope.kind === 'tool' && data.tool?.id === b.scope.toolUseId) {
      const tool: NonNullable<PluginUiContext['tool']> = { id: data.tool.id, name: data.tool.name.slice(0, 256) };
      if (fields.includes('tool.input') && data.tool.input !== undefined) {
        try { const json = JSON.stringify(data.tool.input); if (json && Buffer.byteLength(json, 'utf8') <= 16000) tool.input = JSON.parse(json); } catch { /* unavailable input */ }
      }
      if (fields.includes('tool.result') && typeof data.tool.result === 'string') tool.result = data.tool.result.slice(0, 16000);
      if (fields.includes('tool.status') && typeof data.tool.status === 'string') tool.status = data.tool.status.slice(0, 64);
      context.tool = tool;
    }
    if (action && editor?.selectedText !== undefined && b.supportsComposer && b.contribution.context?.includes('selection'))
      context.selection = { text: editor.selectedText };
    if (!await this.rendererCurrent(b)) throw new PluginUiError('NOT_FOUND', 'Renderer changed');
    return context;
  }
  private invocationKey(viewId: string, invocationId: string): string { return JSON.stringify([viewId, invocationId]); }

  /** Bind the page to an already authorized projection; no identity comes from page code. */
  async bindPage(controller: string, sessionId: string, viewId: string, revision: string, isCurrent = () => true) {
    const b = this.bindings.get(viewId);
    const current = () => !!b && b.controller === controller && b.scope.sessionId === sessionId &&
      !!b.contribution.page && !b.command && !b.dirty && String(b.revision) === revision &&
      this.current(b) && isCurrent();
    const assertCurrent = async () => {
      if (!b || !current()) throw new PluginUiError('NOT_FOUND', 'UI page unavailable');
      const access = await this.deps.authorize(b.scope.sessionId, controller);
      if (!current() || !access.current() || !access.allows(b.instanceId) || !await this.rendererCurrent(b))
        throw new PluginUiError('NOT_FOUND', 'UI page unavailable');
      if (b.scope.kind === 'message' || b.scope.kind === 'tool') {
        const target = b.scope.kind === 'message' ? { kind: 'message', id: b.scope.messageClientId } : { kind: 'tool', id: b.scope.toolUseId };
        const scope = await this.deps.resolveScope?.(b.scope.sessionId, b.contribution.point, target);
        if (!scope || JSON.stringify(scope) !== JSON.stringify(b.scope)) throw new PluginUiError('NOT_FOUND', 'UI page unavailable');
      }
      if (!current() || !access.current() || !access.allows(b.instanceId)) throw new PluginUiError('NOT_FOUND', 'UI page unavailable');
    };
    await assertCurrent();
    if (!b) throw new PluginUiError('NOT_FOUND', 'UI page unavailable');
    const capabilities = () => ({ ...b.capabilities, effects: [] });
    return {
      instanceId: b.instanceId, contributionId: b.contribution.id, readOnly: !!b.renderer, current, assertCurrent,
      read: async () => {
        await assertCurrent();
        const context = await this.context(b);
        await assertCurrent();
        return { ...context, capabilities: capabilities() };
      },
      capabilities: async () => { await assertCurrent(); return capabilities(); },
      invoke: async (raw: unknown) => {
        await assertCurrent();
        if (b.renderer || !pluginUiRecord(raw)) throw new PluginUiError('UNSUPPORTED_CAPABILITY', 'UI page action unavailable');
        const result = await this.invokeBound(controller, sessionId, { viewId, expectedRevision: revision,
          invocationId: randomUUID(), actionId: raw.actionId, values: raw.values, data: raw.data }, current, true);
        const navigation = result.navigation && this.deps.navigate
          ? await this.deps.navigate(controller, result.navigation.requestId).catch(() => ({ tab: 'unavailable' as const, page: 'unconfirmed' as const })) : undefined;
        return { status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}),
          ...(result.data !== undefined ? { data: result.data } : {}),
          ...(result.effectError ? { effectError: result.effectError } : {}),
          ...(navigation ? { navigation } : {}), ...(result.navigationError ? { navigationError: result.navigationError } : {}) };
      },
    };
  }

  async invoke(controller: string, sessionId: string, raw: unknown, isCurrent = () => true): Promise<PluginUiInvocationResult> {
    return this.invokeBound(controller, sessionId, raw, isCurrent, false);
  }

  private async invokeBound(controller: string, sessionId: string, raw: unknown, isCurrent: () => boolean, page: boolean): Promise<PluginUiInvocationResult> {
    // Capture intent order before any authorization/context await or plugin work.
    const sequence = ++this.actionSequence;
    const input = parsePluginUiInvokeInput(raw);
    if (!input) throw new PluginUiError('INVALID_PARAMS', 'Invalid UI action');
    const b = this.bindings.get(input.viewId);
    if (!b || b.controller !== controller || b.scope.sessionId !== sessionId || !this.current(b) || !isCurrent())
      throw new PluginUiError('NOT_FOUND', 'UI action context unavailable');
    const access = await this.deps.authorize(b.scope.sessionId, controller);
    if (!this.current(b) || !access.current() || !access.allows(b.instanceId) || !isCurrent())
      throw new PluginUiError('NOT_FOUND', 'UI action context unavailable');
    // Message and tool renderers currently read saved records; viewing history
    // must not become a route for a plugin business write, even through IPC.
    if (b.renderer) throw new PluginUiError('UNSUPPORTED_CAPABILITY', 'Saved renderer is read-only');
    if (!await this.rendererCurrent(b)) throw new PluginUiError('NOT_FOUND', 'Renderer changed');
    if (b.scope.kind === 'message' || b.scope.kind === 'tool') {
      const target = b.scope.kind === 'message' ? { kind: 'message', id: b.scope.messageClientId } : { kind: 'tool', id: b.scope.toolUseId };
      const currentScope = await this.deps.resolveScope?.(b.scope.sessionId, b.contribution.point, target);
      const turnOnly = b.contribution.point === 'message.shortcuts' && b.command?.points?.includes('turn.footer') &&
        !b.command.points.includes('message.actions');
      const currentTurn = turnOnly ? await this.deps.resolveScope?.(b.scope.sessionId, 'turn.footer', target) : currentScope;
      if (!currentScope || !currentTurn || JSON.stringify(currentScope) !== JSON.stringify(b.scope) ||
          JSON.stringify(currentTurn) !== JSON.stringify(b.scope) || !this.current(b) ||
          !access.current() || !access.allows(b.instanceId) || !isCurrent())
        throw new PluginUiError('NOT_FOUND', 'UI target unavailable');
    }
    const key = this.invocationKey(b.id, input.invocationId);
    const fingerprint = JSON.stringify({ ...input, values: Object.fromEntries(Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b))) });
    const previous = this.invocations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PluginUiError('INVALID_PARAMS', 'Invocation parameters changed');
      return previous.result;
    }
    const action = b.content?.actions.find(a => a.id === input.actionId && !a.disabled);
    const controls = b.content?.controls.filter(c => 'actionId' in c && c.actionId === input.actionId) ?? [];
    if (b.dirty || input.expectedRevision !== String(b.revision) || !action ||
        (page ? !b.contribution.page : !controls.some(c => !c.disabled))) throw new PluginUiError('INVALID_PARAMS', 'UI action changed');
    // Select changes carry exactly the declared control id and one of its values.
    if (!page && ((!controls.some(c => !c.disabled && c.kind === 'button') && Object.keys(input.values).length !== 1) ||
        Object.entries(input.values).some(([id, value]) => !controls.some(c => !c.disabled && c.kind === 'select' &&
        c.id === id && c.options.some(o => o.value === value))))) throw new PluginUiError('INVALID_PARAMS', 'Invalid UI values');
    for (const [oldKey, old] of this.invocations) if (this.invocations.size >= 1024 && old.settled) this.invocations.delete(oldKey);
    if (this.invocations.size >= 1024) throw new PluginUiError('UNSUPPORTED_CAPABILITY', 'UI action budget exhausted');
    let settle!: (result: PluginUiInvocationResult) => void;
    const result = new Promise<PluginUiInvocationResult>(resolve => { settle = resolve; });
    const invocation: Invocation = { sequence, binding: b, input, fingerprint, result, settled: false, settling: false,
      guard: () => access.current() && access.allows(b.instanceId) && isCurrent(), settle: value => {
        if (invocation.settled) return;
        invocation.settled = true; clearTimeout(timer); b.stage = value.status; settle(value);
      } };
    const timer = setTimeout(() => invocation.settle({ invocationId: input.invocationId, status: 'outcome-unknown' }), this.deps.actionTimeoutMs ?? 12_000);
    this.invocations.set(key, invocation); b.stage = 'accepted';
    void this.context(b, input.editor, true).then(context => {
      if (invocation.settled || !invocation.guard() || !this.current(b)) return;
      const message: PluginUiHostMessage = b.command
        ? { type: 'event', name: 'ui-command', commandId: b.command.id, invocationId: input.invocationId, viewId: b.id, context }
        : { type: 'event', name: 'ui-action', contributionId: b.contribution.id,
          invocationId: input.invocationId, viewId: b.id, actionId: input.actionId, values: input.values,
          ...(input.data !== undefined ? { data: input.data } : {}), context };
      if (!this.deps.send(b.instanceId, message))
        invocation.settle({ invocationId: input.invocationId, status: 'outcome-unknown' });
    }, () => invocation.settle({ invocationId: input.invocationId, status: 'outcome-unknown' }));
    return result;
  }

  private async finishAction(invocation: Invocation, result: ReturnType<typeof parsePluginUiActionResult> & {}): Promise<void> {
    try {
      const access = await this.deps.authorize(invocation.binding.scope.sessionId, invocation.binding.controller);
      const { edit, openView, ...terminal } = result;
      const editor = invocation.input.editor;
      let effects: PluginUiComposerEffect[] | undefined;
      if (edit && editor && invocation.binding.capabilities.effects.includes(`composer-edit.${edit.operation}`))
        effects = [{ kind: 'composer-edit', ...edit, operationId: randomUUID(), draftKey: editor.draftKey,
          expectedDraftRevision: editor.revision, selection: editor.selection }];
      let navigation: PluginUiInvocationResult['navigation'];
      if (openView && !invocation.settled && invocation.guard() && this.current(invocation.binding)) {
        const ui = parseGhostNativeUi(this.deps.current(invocation.binding.instanceId)?.ui);
        const view = ui?.version === 1 ? ui.tabViews?.find(v => v.id === openView.id) : undefined;
        if (view && invocation.binding.capabilities.tabViews && this.deps.prepareNavigation) {
          try { navigation = this.deps.prepareNavigation({
            controller: invocation.binding.controller, instanceId: invocation.binding.instanceId, id: view.id,
            sessionId: view.scope === 'session' ? invocation.binding.scope.sessionId : null,
            params: openView.params ?? {}, sequence: invocation.sequence,
            current: () => invocation.guard() && this.current(invocation.binding),
          }); } catch { /* Business completion and local navigation have distinct outcomes. */ }
        }
      }
      invocation.settle({ invocationId: invocation.input.invocationId,
        ...(access.current() && access.allows(invocation.binding.instanceId) && invocation.guard() && this.current(invocation.binding)
          ? { ...terminal, ...(effects ? { effects } : edit ? { effectError: 'UNSUPPORTED_EFFECT' as const } : {}),
              ...(navigation ? { navigation } : openView ? { navigationError: 'VIEW_UNAVAILABLE' as const } : {}) }
          : { status: 'outcome-unknown' as const }) });
    } catch { invocation.settle({ invocationId: invocation.input.invocationId, status: 'outcome-unknown' }); }
  }

  inspect() {
    return { capabilities: PLUGIN_UI_CAPABILITIES, bindings: this.bindings.size, queries: this.queries.size,
      pendingActions: [...this.invocations.values()].filter(i => !i.settled).length,
      instances: [...this.instances.values()].map(i => ({ instanceId: i.id,
        contributions: i.contributions.map(c => ({ id: c.id, point: c.point, scope: c.scope,
          reason: !PLUGIN_UI_CAPABILITIES.points.includes(c.point) ? 'UNSUPPORTED_POINT'
            : !pluginUiPointAcceptsScope(c.point, c.scope) ? 'SCOPE_MISMATCH'
              : !this.registrations.get(i.id)?.has(this.registrationKey('contribution', c.id)) ? 'NOT_REGISTERED' : 'REGISTERED' })),
        commands: i.commands.map(c => ({ id: c.id, scope: c.scope,
          reason: !this.registrations.get(i.id)?.has(this.registrationKey('command', c.id)) ? 'NOT_REGISTERED' : 'REGISTERED' })) })),
      views: [...this.bindings.values()].map(b => ({ viewId: b.id, instanceId: b.instanceId,
        contributionId: b.contribution.id, sessionId: b.scope.sessionId, capabilities: b.capabilities,
        revision: String(b.revision), stage: b.stage })) };
  }
}
