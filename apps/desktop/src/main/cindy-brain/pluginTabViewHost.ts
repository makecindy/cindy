import { randomUUID } from 'node:crypto';
import { parseGhostNativeUi } from '@cindy/plugin-protocol';
import { parsePluginUiValues, pluginUiRecord, pluginUiText,
  type PluginUiNavigationResult, type PluginUiTabViewSnapshot, type PluginUiValues } from '@cindy/maker-shared/plugin-ui-host';
import { PLUGIN_TAB_VIEW_CHANGED, PLUGIN_TAB_VIEW_REQUEST,
  type PluginTabViewMountRequest, type PluginTabViewMountResult } from '../../shared/pluginUi.js';

interface Controller { id: number; role: string; current(): boolean; visible(): boolean; send(channel: string, payload: unknown): void }
interface Guest { id: number; current(): boolean; send(channel: string, payload: unknown): void }
interface Navigation {
  controller: string; instanceId: string; id: string; sessionId: string | null;
  params: PluginUiValues; sequence: number; current(): boolean;
}
interface Mount extends PluginTabViewMountRequest {
  key: string; token: string; installToken: string; pluginId: string; page: string;
  controller: Controller; originalController: number; guard(): boolean;
  snapshot: PluginUiTabViewSnapshot; guest?: Guest; mounted: boolean; received: number;
  nextController?: number;
}
interface Dependencies {
  current(id: string): { token: string; pluginId: string; ui: unknown } | null;
  controller(id: number): Controller | null;
  authorize(controller: number, sessionId: string | null, instanceId: string): Promise<() => boolean>;
  ownerForTab(tabId: string): number | null;
  timeoutMs?: number;
}
const unavailable = (): PluginUiNavigationResult => ({ tab: 'unavailable', page: 'unconfirmed' });
const fail = (): never => { throw new Error('VIEW_UNAVAILABLE'); };
const controllerId = (value: string) => /^local:\d+$/.test(value) ? Number(value.slice(6)) : -1;
const controllerIdFromNavigation = (input: Navigation) => controllerId(input.controller);

/** Native tab state stays in its renderer owner. These are revocable mount
 * projections and one-shot transport requests, never persisted layout/business state. */
export class PluginTabViewHost {
  private readonly hosts = new Map<number, Controller>();
  private readonly mounts = new Map<string, Mount>();
  private readonly projections = new Map<string, Mount>();
  private readonly guests = new Map<number, Mount>();
  private readonly latest = new Map<string, number>();
  private readonly tickets = new Map<string, { input: Navigation; key: string; expires: number; pending?: boolean; result?: Promise<PluginUiNavigationResult> }>();
  private readonly opens = new Map<string, { controller: number; current(): boolean; resolve(tabId: string | null): void }>();
  private readonly deliveries = new Set<() => void>();
  constructor(private readonly deps: Dependencies) {}
  private key(instanceId: string, id: string, sessionId: string | null) { return JSON.stringify([instanceId, id, sessionId]); }
  ready(id: number): void { const controller = this.deps.controller(id); if (controller) this.hosts.set(id, controller); }

  prepare(input: Navigation): { requestId: string } {
    for (const [id, entry] of this.tickets) if (entry.expires < Date.now()) this.tickets.delete(id);
    const retained = new Set([...this.tickets.values()].map(entry => entry.key));
    for (const key of this.latest.keys()) if (!retained.has(key) && !this.projections.has(key)) this.latest.delete(key);
    if (this.tickets.size >= 1024) return fail();
    const key = this.key(input.instanceId, input.id, input.sessionId);
    this.latest.set(key, Math.max(this.latest.get(key) ?? 0, input.sequence));
    const requestId = randomUUID();
    this.tickets.set(requestId, { input, key, expires: Date.now() + 30_000 });
    for (const notify of this.deliveries) notify();
    return { requestId };
  }

  navigate(controller: string, requestId: string): Promise<PluginUiNavigationResult> {
    const entry = this.tickets.get(requestId);
    if (!entry || entry.input.controller !== controller || entry.expires < Date.now()) return Promise.resolve(unavailable());
    if (!entry.result) {
      entry.pending = true;
      entry.result = this.open(entry.input, entry.key).catch(unavailable).finally(() => { entry.pending = false; entry.input.params = {}; });
    }
    return entry.result;
  }
  private async open(input: Navigation, key: string): Promise<PluginUiNavigationResult> {
    if (!input.current()) return unavailable();
    if (this.latest.get(key) !== input.sequence) return { tab: 'superseded', page: 'unconfirmed' };
    const instance = this.deps.current(input.instanceId);
    const ui = parseGhostNativeUi(instance?.ui);
    const view = ui?.version === 1 ? ui.tabViews?.find(v => v.id === input.id) : undefined;
    if (!view || (view.scope === 'global') !== (input.sessionId === null)) return unavailable();
    const source = this.deps.controller(controllerId(input.controller));
    if (!source?.current()) return unavailable();
    const projection = this.projections.get(key);
    const hasProjection = projection && this.valid(projection);
    let target = hasProjection ? this.deps.controller(this.deps.ownerForTab(projection.tabId) ?? projection.nextController ?? projection.controller.id) : source;
    if (!hasProjection && source.role === 'main') {
      // A mounted detached sidebar is the existing native host, not a second layout.
      target = [...this.hosts.values()].find(host => host.role === 'sidebar' && host.current() && host.visible()) ?? source;
    }
    if (!target?.current()) return unavailable();
    const guard = await this.deps.authorize(target.id, input.sessionId, input.instanceId);
    if (!guard() || !input.current() || this.deps.current(input.instanceId)?.token !== instance?.token) return unavailable();
    if (this.latest.get(key) !== input.sequence) return { tab: 'superseded', page: 'unconfirmed' };
    const requestId = randomUUID();
    const tabId = await new Promise<string | null>(resolve => {
      const timer = setTimeout(() => finish(null), this.deps.timeoutMs ?? 5000);
      const finish = (id: string | null) => { clearTimeout(timer); this.opens.delete(requestId); resolve(id); };
      this.opens.set(requestId, { controller: target.id, current: () => guard() && input.current() && this.latest.get(key) === input.sequence, resolve: finish });
      try { target.send(PLUGIN_TAB_VIEW_REQUEST, { requestId, instanceId: input.instanceId, id: input.id,
        sessionId: input.sessionId, params: input.params, sequence: input.sequence }); } catch { finish(null); }
    });
    if (this.latest.get(key) !== input.sequence) return { tab: 'superseded', page: 'unconfirmed' };
    if (!tabId || !guard() || !input.current()) return unavailable();
    const page = await new Promise<'received' | 'unconfirmed'>(resolve => {
      const timer = setTimeout(() => finish('unconfirmed'), this.deps.timeoutMs ?? 5000);
      const finish = (value: 'received' | 'unconfirmed') => { clearTimeout(timer); this.deliveries.delete(check); resolve(value); };
      const check = () => {
        const mount = this.projections.get(key);
        if (!guard() || !input.current() || this.latest.get(key) !== input.sequence) finish('unconfirmed');
        else if (mount && this.valid(mount) && mount.tabId === tabId && mount.received === input.sequence) finish('received');
      };
      this.deliveries.add(check); check();
    });
    return { tab: this.latest.get(key) === input.sequence ? 'opened' : 'superseded', page };
  }
  opened(controller: number, raw: unknown): void {
    if (!pluginUiRecord(raw) || !pluginUiText(raw.requestId)) return;
    const pending = this.opens.get(raw.requestId);
    if (pending?.controller === controller) pending.resolve(pending.current() && pluginUiText(raw.tabId) ? raw.tabId : null);
  }

  async mount(controllerId: number, raw: unknown): Promise<PluginTabViewMountResult> {
    if (!pluginUiRecord(raw) || !pluginUiText(raw.tabId) || !pluginUiText(raw.instanceId) || !pluginUiText(raw.id, 64) ||
        (raw.sessionId !== null && !pluginUiText(raw.sessionId)) || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0 ||
        typeof raw.visible !== 'boolean') return fail();
    const params = parsePluginUiValues(raw.params);
    const controller = this.deps.controller(controllerId);
    const instance = this.deps.current(raw.instanceId);
    const ui = parseGhostNativeUi(instance?.ui);
    const view = ui?.version === 1 ? ui.tabViews?.find(v => v.id === raw.id) : undefined;
    if (!params || !controller?.current() || !instance || !view || (view.scope === 'global') !== (raw.sessionId === null)) return fail();
    const guard = await this.deps.authorize(controllerId, raw.sessionId as string | null, raw.instanceId);
    if (!guard() || !controller.current() || this.deps.current(raw.instanceId)?.token !== instance.token) return fail();
    const key = this.key(raw.instanceId, view.id, raw.sessionId as string | null);
    const old = this.projections.get(key);
    if (old && this.valid(old) && old.tabId !== raw.tabId) return fail();
    const nativeOwner = this.deps.ownerForTab(raw.tabId);
    if (nativeOwner !== null && nativeOwner !== controllerId) return fail();
    if (old && this.valid(old) && old.controller.id !== controllerId && nativeOwner === null &&
        controllerId !== old.originalController && controller.role !== 'sidebar') return fail();
    const token = randomUUID();
    const takeOld = old && this.valid(old) && old.sequence >= (raw.sequence as number);
    // Opening a tab can start the existing detached host before its source has
    // mounted. Hand over the one-shot request, not a persisted parameter copy.
    let position = takeOld ? { params: old.snapshot.params, sequence: old.sequence } : { params, sequence: raw.sequence as number };
    const pending = [...this.tickets.values()].find(entry => entry.key === key && entry.pending && entry.input.current() &&
      entry.expires >= Date.now() && entry.input.sequence === this.latest.get(key) && entry.input.sequence >= position.sequence);
    if (pending) position = { params: pending.input.params, sequence: pending.input.sequence };
    const { sequence } = position;
    const snapshot: PluginUiTabViewSnapshot = { id: view.id,
      scope: raw.sessionId === null ? { kind: 'global' } : { kind: 'session', sessionId: raw.sessionId as string },
      params: position.params, generation: token, visible: raw.visible };
    const mount: Mount = { tabId: raw.tabId, instanceId: raw.instanceId, id: view.id, sessionId: raw.sessionId as string | null,
      params: snapshot.params, sequence, visible: raw.visible, key, token, installToken: instance.token, pluginId: instance.pluginId,
      page: view.page, controller, originalController: old?.originalController ?? (pending ? controllerIdFromNavigation(pending.input) : controllerId), guard,
      snapshot, mounted: true, received: -1 };
    if (old) {
      this.dropMount(old);
    }
    const previousOwners = new Set([old?.controller.id, pending ? controllerIdFromNavigation(pending.input) : undefined]);
    for (const previous of previousOwners) if (previous !== undefined && previous !== controllerId) try {
      this.deps.controller(previous)?.send(PLUGIN_TAB_VIEW_REQUEST, { releaseTabId: raw.tabId, sequence,
        ...(previous === old?.controller.id ? { generation: old.token } : {}) });
    } catch { /* departed owner */ }
    this.mounts.set(token, mount); this.projections.set(key, mount);
    return { token, snapshot, sequence };
  }
  private valid(mount: Mount): boolean {
    return (mount.nextController === undefined ? mount.guard() && mount.controller.current() :
      this.deps.controller(mount.nextController)?.current() === true) && this.deps.current(mount.instanceId)?.token === mount.installToken;
  }
  private dropMount(mount: Mount): void {
    this.mounts.delete(mount.token);
    if (mount.guest) this.guests.delete(mount.guest.id);
    mount.guest = undefined; mount.mounted = false;
  }
  release(controller: number, token: string, moving = false): void {
    const mount = this.mounts.get(token) ?? [...this.projections.values()].find(mount => mount.token === token);
    if (!mount || mount.controller.id !== controller) return;
    this.dropMount(mount);
    // A parked tab still exists. Keep only its revocable read-only projection
    // until its renderer remounts, transfers it, or confirms the actual close.
    const next = this.deps.ownerForTab(mount.tabId);
    if (moving) mount.nextController = next ?? mount.originalController;
    if (!moving || !this.valid(mount)) this.projections.delete(mount.key);
    for (const notify of this.deliveries) notify();
  }
  update(controller: number, raw: unknown): void {
    if (!pluginUiRecord(raw) || !pluginUiText(raw.token) || typeof raw.visible !== 'boolean' || !Number.isSafeInteger(raw.sequence)) return fail();
    const mount = this.mounts.get(raw.token), params = parsePluginUiValues(raw.params);
    if (!mount || mount.controller.id !== controller || !this.valid(mount) || !params) return fail();
    if ((raw.sequence as number) < mount.sequence) return;
    mount.sequence = raw.sequence as number; mount.snapshot = { ...mount.snapshot, params, visible: raw.visible };
    if (mount.guest?.current()) mount.guest.send(PLUGIN_TAB_VIEW_CHANGED, { snapshot: mount.snapshot, sequence: mount.sequence });
  }
  authorizeAttach(controller: number, url: string): { token: string; current(): boolean } | null {
    try {
      const parsed = new URL(url), token = parsed.searchParams.get('cindyView');
      const mount = token ? this.mounts.get(token) : undefined;
      if (!mount?.mounted || !this.valid(mount) || mount.controller.id !== controller ||
          parsed.protocol !== 'cindy-ghost:' || parsed.host !== mount.pluginId || parsed.pathname !== new URL(`cindy-ghost://${mount.pluginId}/${mount.page}`).pathname ||
          parsed.search !== `?cindyView=${token}` || parsed.hash) return null;
      return { token: mount.token, current: () => this.mounts.get(mount.token) === mount && this.valid(mount) };
    } catch { return null; }
  }
  attach(controller: number, url: string, guest: Guest): boolean {
    const access = this.authorizeAttach(controller, url);
    const mount = access && this.mounts.get(access.token);
    if (!mount || mount.guest && mount.guest.id !== guest.id) return false;
    mount.guest = guest; this.guests.set(guest.id, mount); return true;
  }
  private guest(id: number): Mount {
    const mount = this.guests.get(id);
    if (!mount || !this.valid(mount) || this.mounts.get(mount.token) !== mount || !mount.guest?.current()) return fail();
    return mount;
  }
  read(id: number): { snapshot: PluginUiTabViewSnapshot; sequence: number } {
    const mount = this.guest(id); return { snapshot: mount.snapshot, sequence: mount.sequence };
  }
  received(id: number, raw: unknown): void {
    const mount = this.guest(id);
    if (!pluginUiRecord(raw) || raw.generation !== mount.token || raw.sequence !== mount.sequence) return;
    mount.received = mount.sequence; for (const notify of this.deliveries) notify();
  }
  reconcile(): void {
    for (const mount of this.projections.values()) if (!this.valid(mount)) { this.dropMount(mount); this.projections.delete(mount.key); }
    for (const [id, host] of this.hosts) if (!host.current()) this.hosts.delete(id);
    for (const [id, ticket] of this.tickets) if (!ticket.input.current() || ticket.expires < Date.now()) this.tickets.delete(id);
    for (const notify of this.deliveries) notify();
  }
}
