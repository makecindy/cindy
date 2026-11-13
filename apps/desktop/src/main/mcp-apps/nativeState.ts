import { pluginUiInterestKey, type PluginUiInterest, type PluginUiTarget, type PluginUiControlState, type PluginUiStateChange } from '../../shared/pluginUi.js';

interface Interest extends PluginUiInterest { authority: object }
interface Group { owner: string; epoch: string; interests: Map<string, Interest> }
interface Snapshot { owner: string; authority: object; change: PluginUiStateChange }

/** Small native-control adapter over the existing pipe/IPC, not a page protocol. */
export class NativePluginUiState {
  private groups = new Map<string, Group>();
  private routes = new Map<string, Set<string>>();
  private byInstance = new Map<string, Map<string, Set<string>>>();
  private latest = new Map<string, Snapshot>();
  private demands = new Map<string, PluginUiInterest[]>();
  private pending = new Map<string, { group: Group; changes: Map<string, PluginUiStateChange> }>();
  private scheduled = false;
  private revision = 0;
  constructor(private readonly deps: {
    owner(): string;
    authority(interest: PluginUiInterest): object | undefined;
    send(caller: string, epoch: string, updates: PluginUiStateChange[]): void;
    demand(instance: string, consumers: PluginUiInterest[]): void;
  }) {}

  consumers(instance: string): PluginUiInterest[] | undefined {
    const entries = this.demands.get(instance);
    if (!entries) return undefined;
    const current = entries.filter(entry => {
      const key = pluginUiInterestKey(entry);
      return [...this.routes.get(key) ?? []].some(caller => {
        const group = this.groups.get(caller), binding = group?.interests.get(key);
        return group?.owner === this.deps.owner() && binding && this.deps.authority(binding) === binding.authority;
      });
    });
    return current.length ? current : undefined;
  }

  subscribe(caller: string, epoch: string, entries: PluginUiInterest[]): PluginUiStateChange[] {
    const changed = new Set<string>();
    const retained = new Map(this.latest);
    this.remove(caller, changed);
    const group: Group = { owner: this.deps.owner(), epoch, interests: new Map() };
    this.groups.set(caller, group);
    for (const entry of entries) {
      const authority = this.deps.authority(entry);
      if (!authority) continue;
      const key = pluginUiInterestKey(entry);
      if (group.interests.has(key)) continue;
      group.interests.set(key, { ...entry, authority });
      const snapshot = retained.get(key);
      if (snapshot?.owner === group.owner && snapshot.authority === authority) this.latest.set(key, snapshot);
      let routes = this.routes.get(key);
      if (!routes) { routes = new Set(); this.routes.set(key, routes); }
      routes.add(caller);
      let positions = this.byInstance.get(entry.instanceId);
      if (!positions) { positions = new Map(); this.byInstance.set(entry.instanceId, positions); }
      let keys = positions.get(entry.id);
      if (!keys) { keys = new Set(); positions.set(entry.id, keys); }
      keys.add(key); changed.add(entry.instanceId);
    }
    this.updateDemand(changed);
    return [...group.interests].flatMap(([key, entry]) => {
      const snapshot = this.latest.get(key);
      return snapshot?.owner === group.owner && snapshot.authority === entry.authority ? [snapshot.change] : [];
    });
  }

  release(caller: string): void {
    const changed = new Set<string>(); this.remove(caller, changed); this.updateDemand(changed);
  }

  private remove(caller: string, changed: Set<string>) {
    const group = this.groups.get(caller);
    this.groups.delete(caller); this.pending.delete(caller);
    for (const [key, entry] of group?.interests ?? []) {
      const routes = this.routes.get(key); routes?.delete(caller);
      if (!routes?.size) {
        this.routes.delete(key); this.latest.delete(key);
        const positions = this.byInstance.get(entry.instanceId);
        const keys = positions?.get(entry.id); keys?.delete(key);
        if (!keys?.size) positions?.delete(entry.id);
        if (!positions?.size) this.byInstance.delete(entry.instanceId);
      }
      changed.add(entry.instanceId);
    }
  }

  private updateDemand(instances: Set<string>) {
    for (const instance of instances) {
      const entries = new Map<string, PluginUiInterest>();
      for (const keys of this.byInstance.get(instance)?.values() ?? []) for (const key of keys) {
        const caller = this.routes.get(key)?.values().next().value;
        const entry = caller && this.groups.get(caller)?.interests.get(key);
        if (entry) entries.set(key, { instanceId: instance, id: entry.id, sessionId: entry.sessionId ?? null,
          ...(entry.clientId ? { clientId: entry.clientId } : {}) });
      }
      const next = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
      if (JSON.stringify(next) === JSON.stringify(this.demands.get(instance) ?? [])) continue;
      if (next.length) this.demands.set(instance, next); else this.demands.delete(instance);
      this.deps.demand(instance, next);
    }
  }

  publish(instance: string, id: string, target: PluginUiTarget | undefined, build: () => PluginUiControlState): boolean {
    const keys = this.byInstance.get(instance)?.get(id);
    if (!keys?.size) return false; // No payload, serialization, scheduling or plugin wake.
    const selected = target ? [pluginUiInterestKey({ instanceId: instance, id, ...target })] : keys;
    const deliveries: Array<{ caller: string; group: Group; key: string }> = [];
    for (const key of selected) for (const caller of this.routes.get(key) ?? []) {
      const group = this.groups.get(caller), entry = group?.interests.get(key);
      if (group && entry && group.owner === this.deps.owner() && this.deps.authority(entry) === entry.authority)
        deliveries.push({ caller, group, key });
    }
    if (!deliveries.length) return false;
    const raw = build();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        raw.title !== undefined && (typeof raw.title !== 'string' || raw.title.length > 200) ||
        raw.value !== undefined && (typeof raw.value !== 'string' || raw.value.length > 256) ||
        raw.disabled !== undefined && typeof raw.disabled !== 'boolean' || raw.visible !== undefined && typeof raw.visible !== 'boolean')
      throw new Error('MCP_APP_INVALID_CONTROL_STATE');
    const state = { ...(raw.title !== undefined ? { title: raw.title } : {}), ...(raw.value !== undefined ? { value: raw.value } : {}),
      ...(raw.disabled !== undefined ? { disabled: raw.disabled } : {}), ...(raw.visible !== undefined ? { visible: raw.visible } : {}) };
    const revision = ++this.revision;
    for (const { caller, group, key } of deliveries) {
      const change = { key, revision, state };
      this.latest.set(key, { owner: group.owner, authority: group.interests.get(key)!.authority, change });
      let pending = this.pending.get(caller);
      if (!pending) { pending = { group, changes: new Map() }; this.pending.set(caller, pending); }
      pending.changes.set(key, change);
    }
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => this.flush()); }
    return true;
  }

  private flush() {
    this.scheduled = false;
    const pending = this.pending; this.pending = new Map();
    for (const [caller, { group, changes }] of pending) {
      if (this.groups.get(caller) !== group || group.owner !== this.deps.owner()) continue;
      const current = [...changes.values()].filter(change => {
        const entry = group.interests.get(change.key);
        return entry && this.deps.authority(entry) === entry.authority;
      });
      if (!current.length) continue;
      try { this.deps.send(caller, group.epoch, current); } catch { this.release(caller); }
    }
  }
}
