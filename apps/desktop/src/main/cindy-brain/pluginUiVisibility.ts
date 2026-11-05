import { parseGhostNativeUi } from '@cindy/plugin-protocol';
import { pluginUiRecord } from '@cindy/maker-shared';
import type { PluginUiVisibilityElement, PluginUiVisibilityValues } from '@cindy/maker-shared/plugin-ui';
import { PLUGIN_UI_VISIBILITY_ELEMENTS } from '../../shared/pluginUiVisibility.js';

interface Instance { id: string; token: string; ui: unknown }
interface Dependencies {
  current(id: string): Instance | null;
  window(id?: number): number | null;
  apply(id: number, values: PluginUiVisibilityValues): Promise<'applied' | 'unconfirmed'>;
}
interface Owner { id: string; token: string }

/** Transient presentation state belongs to the affected local window. */
export class PluginUiVisibilityService {
  private windows = new Map<number, Map<PluginUiVisibilityElement, Owner>>();
  constructor(private readonly deps: Dependencies) {}

  private values(id: number): PluginUiVisibilityValues {
    const hidden = this.windows.get(id);
    return Object.fromEntries(PLUGIN_UI_VISIBILITY_ELEMENTS.map(element => [element, !hidden?.has(element)])) as PluginUiVisibilityValues;
  }

  snapshot(id: number): PluginUiVisibilityValues { return this.values(id); }

  async handle(id: string, raw: unknown, options: { windowId?: number; assertCurrent?: () => void } = {}): Promise<unknown> {
    try {
      options.assertCurrent?.();
      const instance = this.deps.current(id);
      const ui = instance && parseGhostNativeUi(instance.ui);
      if (!instance || ui?.version !== 1 || !ui.appearance?.fields.includes('visibility')) throw new Error('VISIBILITY_UNAVAILABLE');
      const windowId = this.deps.window(options.windowId);
      if (windowId === null) throw new Error('VISIBILITY_UNAVAILABLE');
      if (!pluginUiRecord(raw)) throw new Error('INVALID_PARAMS');
      if (raw.kind === 'read') return { ok: true, data: this.values(windowId) };
      if (raw.kind !== 'set' || !pluginUiRecord(raw.patch) || !Object.keys(raw.patch).length ||
          Object.entries(raw.patch).some(([key, value]) => !PLUGIN_UI_VISIBILITY_ELEMENTS.includes(key as PluginUiVisibilityElement) || typeof value !== 'boolean'))
        throw new Error('INVALID_PARAMS');
      options.assertCurrent?.();
      if (this.deps.current(id)?.token !== instance.token) throw new Error('CONTEXT_CHANGED');
      const hidden = this.windows.get(windowId) ?? new Map<PluginUiVisibilityElement, Owner>();
      for (const [key, visible] of Object.entries(raw.patch)) {
        if (visible) hidden.delete(key as PluginUiVisibilityElement);
        else hidden.set(key as PluginUiVisibilityElement, { id, token: instance.token });
      }
      if (hidden.size) this.windows.set(windowId, hidden); else this.windows.delete(windowId);
      const values = this.values(windowId);
      const status = await this.deps.apply(windowId, values).catch(() => 'unconfirmed' as const);
      return { ok: true, data: { values, application: { status } } };
    } catch (error) {
      const code = error instanceof Error && ['VISIBILITY_UNAVAILABLE', 'INVALID_PARAMS', 'CONTEXT_CHANGED'].includes(error.message)
        ? error.message : 'VISIBILITY_UNAVAILABLE';
      return { ok: false, error: { code, message: code } };
    }
  }

  async release(id: string): Promise<void> {
    const updates: Promise<unknown>[] = [];
    for (const [windowId, hidden] of this.windows) {
      let changed = false;
      for (const [element, owner] of hidden) if (owner.id === id) { hidden.delete(element); changed = true; }
      if (!hidden.size) this.windows.delete(windowId);
      if (changed && this.deps.window(windowId) !== null) updates.push(this.deps.apply(windowId, this.values(windowId)).catch(() => {}));
    }
    await Promise.all(updates);
  }

  async reconcile(): Promise<void> {
    const updates: Promise<unknown>[] = [];
    for (const [windowId, hidden] of this.windows) {
      let changed = false;
      for (const [element, owner] of hidden) if (this.deps.current(owner.id)?.token !== owner.token) { hidden.delete(element); changed = true; }
      if (!hidden.size) this.windows.delete(windowId);
      if (changed && this.deps.window(windowId) !== null) updates.push(this.deps.apply(windowId, this.values(windowId)).catch(() => {}));
    }
    await Promise.all(updates);
  }

  forgetWindow(id: number): void { this.windows.delete(id); }
}
