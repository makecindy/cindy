import { useCallback, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { PLUGIN_UI_INTEREST_LIMIT, pluginUiInterestKey, type PluginUiControlState, type PluginUiInterest, type PluginUiStateChange } from '../../shared/pluginUi';

type Consumer = { interest: PluginUiInterest; listeners: Set<() => void>; latest?: PluginUiStateChange };
type Update = { epoch: string; updates: PluginUiStateChange[] };

/** One interest set and one listener per window; native controls do not open App frames. */
export class PluginUiControls {
  private consumers = new Map<string, Consumer>();
  private owner?: object;
  private stop?: () => void;
  private dirty = false;
  private scheduled = false;
  private sending = false;
  private revision = 0;
  private epoch = '';
  constructor(private readonly deps: {
    owner(): object;
    replace(epoch: string, entries: PluginUiInterest[]): Promise<{ updates: PluginUiStateChange[] }>;
    listen(receive: (update: Update) => void): () => void;
  }) {}

  snapshot(interest: PluginUiInterest): PluginUiControlState | undefined {
    return this.owner === this.deps.owner() ? this.consumers.get(pluginUiInterestKey(interest))?.latest?.state : undefined;
  }

  subscribe(interest: PluginUiInterest, changed: () => void): () => void {
    if (this.owner !== this.deps.owner()) {
      this.consumers.clear(); this.stop?.(); this.stop = undefined;
      this.owner = this.deps.owner(); this.epoch = '';
    }
    if (!this.stop) this.stop = this.deps.listen(update => this.apply(update));
    const key = pluginUiInterestKey(interest);
    let consumer = this.consumers.get(key);
    if (!consumer) {
      consumer = { interest, listeners: new Set() }; this.consumers.set(key, consumer); this.schedule();
    }
    const current = consumer;
    current.listeners.add(changed);
    return () => {
      current.listeners.delete(changed);
      if (!current.listeners.size && this.consumers.get(key) === current) { this.consumers.delete(key); this.schedule(); }
    };
  }

  private apply(update: Update) {
    if (this.owner !== this.deps.owner() || update.epoch !== this.epoch) return;
    for (const change of update.updates) {
      const consumer = this.consumers.get(change.key);
      if (!consumer || consumer.latest && consumer.latest.revision >= change.revision) continue;
      consumer.latest = change;
      for (const changed of consumer.listeners) changed();
    }
  }

  private schedule() {
    this.dirty = true;
    if (this.scheduled || this.sending) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.flush(); });
  }

  private async flush() {
    if (this.sending || !this.dirty) return;
    this.dirty = false; this.sending = true;
    const owner = this.owner, epoch = this.epoch = String(++this.revision);
    try {
      // Only mounted, active controls register. Keep their stable registration order;
      // overflow retains declared defaults and takes a slot when a consumer leaves.
      const entries: PluginUiInterest[] = [];
      for (const consumer of this.consumers.values()) {
        if (entries.length === PLUGIN_UI_INTEREST_LIMIT) break;
        entries.push(consumer.interest);
      }
      const result = await this.deps.replace(epoch, entries);
      if (owner === this.deps.owner()) this.apply({ epoch, updates: result.updates });
    } catch {
      // Passive enhancement keeps the declared control; no retry timer or global error banner.
      if (owner === this.deps.owner()) for (const consumer of this.consumers.values()) {
        consumer.latest = undefined;
        for (const changed of consumer.listeners) changed();
      }
    } finally {
      this.sending = false;
      if (this.dirty) this.schedule();
      else if (!this.consumers.size) { this.stop?.(); this.stop = undefined; this.epoch = ''; }
    }
  }
}

const controls = new PluginUiControls({
  owner: getDataOwnerGeneration,
  replace: async (epoch, entries) => window.electronAPI.maker.mcpApps(null, { op: 'native-interest', epoch, entries }) as Promise<{ updates: PluginUiStateChange[] }>,
  listen: receive => window.electronAPI.maker.onPluginUiState(receive),
});

export function usePluginUiControl(interest: PluginUiInterest, authority: object, active = true) {
  const subscribe = useCallback((changed: () => void) => active ? controls.subscribe(interest, changed) : () => {}, [interest, authority, active]);
  const snapshot = useCallback(() => active ? controls.snapshot(interest) : undefined, [interest, authority, active]);
  return useSyncExternalStore(subscribe, snapshot, () => undefined);
}
