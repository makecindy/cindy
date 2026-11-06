import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginUiView, PluginUiInvokeInput } from '@cindy/maker-shared';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { readPluginUi, invokePluginUi, releasePluginUi, choosePluginUiRenderer, type PluginUiClientTarget } from './pluginUiClient';
import type { PluginUiReadResult, PluginUiRendererChoice } from '../../shared/pluginUi';
import { pluginUiComposerAccess, pluginUiComposerKey } from './pluginUiComposerActions';

const subscriptions = new Map<object, { deviceId?: string; sessionId?: string; point: string }>();
/** Dev diagnostics contain routing metadata only, never plugin content or input. */
export function inspectPluginUiSubscriptions() { return [...subscriptions.values()]; }
const visible = () => document.visibilityState !== 'hidden';

/** Viewing state only. The plugin owns values; a reconnect never repeats a write. */
export function usePluginUiContributions(input: PluginUiClientTarget & { active?: boolean; connected?: boolean; readOnly?: boolean }) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([owner, input.deviceId, input.sessionId, input.point, input.target, input.active, input.connected, input.readOnly]);
  const scope = useMemo(() => ({ key }), [key]);
  const current = useRef(scope); current.current = scope;
  const [state, setState] = useState<{ scope: object; subscriptionId: string; views: PluginUiView[]; renderer?: PluginUiReadResult['renderer']; ready: boolean }>();
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<'unavailable' | 'outcome-unknown' | 'rejected' | 'draftChanged' | 'editorUnavailable'>();
  const inFlight = useRef(new Set<string>());
  const refresh = useRef<() => void>(() => {});
  const activeSubscription = useRef('');
  const enabled = input.active !== false && input.connected !== false && !input.deviceId && !!input.sessionId;
  useEffect(() => {
    const lifetime = new AbortController();
    let reading = false, dirty = false, generation = 0;
    const valid = () => !lifetime.signal.aborted && current.current === scope &&
      isDataOwnerGenerationCurrent(owner) && visible();
    setPending(new Set()); inFlight.current.clear(); setError(undefined);
    if (!enabled) return () => lifetime.abort();
    let subscriptionId = '';
    const release = () => {
      subscriptions.delete(scope);
      if (!subscriptionId) return;
      const original = subscriptionId; subscriptionId = '';
      if (activeSubscription.current === original) activeSubscription.current = '';
      void releasePluginUi(input, original);
    };
    const load = async () => {
      if (!valid() || reading) { dirty = true; return; }
      reading = true; dirty = false; const expected = generation;
      if (!subscriptionId) subscriptionId = crypto.randomUUID();
      const original = subscriptionId; activeSubscription.current = original;
      if (import.meta.env.DEV) subscriptions.set(scope, { sessionId: input.sessionId, point: input.point });
      try {
        const result = await readPluginUi(input, original);
        if (valid() && expected === generation) setState({ scope, subscriptionId: original, views: result.views, renderer: result.renderer, ready: true });
      } catch {
        if (valid() && expected === generation) {
          setState(previous => ({ scope, subscriptionId: original, views: previous?.scope === scope ? previous.views : [], ready: false }));
          setError('unavailable');
        }
      } finally { reading = false; if (valid() && dirty) void load(); }
    };
    const invalidate = () => {
      generation++; dirty = true;
      setState(previous => previous?.scope === scope ? { ...previous, ready: false } : previous);
      void load();
    };
    refresh.current = invalidate;
    const composerKey = pluginUiComposerKey(input);
    const offComposer = pluginUiComposerAccess.onChanged(key => { if (key === composerKey && valid()) invalidate(); });
    const off = window.electronAPI.ghosts.ui.onChanged(event => { if (!event.sessionId || event.sessionId === input.sessionId) invalidate(); });
    const visibility = () => {
      generation++;
      if (visible()) invalidate();
      else {
        release();
        setState(previous => previous?.scope === scope ? { ...previous, ready: false } : previous);
      }
    };
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => { lifetime.abort(); release(); off(); offComposer(); document.removeEventListener('visibilitychange', visibility); refresh.current = () => {}; };
    // All request identity and lifecycle fields are represented by scope.
  }, [scope, enabled]);
  const invoke = useCallback(async (view: PluginUiView, actionId: string, values: PluginUiInvokeInput['values']) => {
    if (!enabled || input.readOnly || !isDataOwnerGenerationCurrent(owner) || !visible() ||
        state?.scope !== scope || state.subscriptionId !== activeSubscription.current || !state.ready || current.current !== scope || inFlight.current.has(view.viewId)) return;
    const originalSubscription = activeSubscription.current;
    const valid = () => current.current === scope && isDataOwnerGenerationCurrent(owner) && visible() &&
      activeSubscription.current === originalSubscription;
    inFlight.current.add(view.viewId); setPending(new Set(inFlight.current)); setError(undefined);
    try {
      const ticket = view.editor ? pluginUiComposerAccess.capture(pluginUiComposerKey(input), view.editor) : null;
      if (!valid()) return;
      const result = await invokePluginUi(input, { viewId: view.viewId, expectedRevision: view.revision,
        invocationId: crypto.randomUUID(), actionId, values, ...(ticket ? { editor: ticket.snapshot } : {}) });
      if (!valid()) return;
      if (result.status !== 'completed') setError(result.status);
      if (result.effectError) setError('editorUnavailable');
      for (const effect of result.effects ?? []) {
        const applied = ticket ? pluginUiComposerAccess.apply(ticket, effect) : 'EDITOR_UNAVAILABLE';
        if (!valid()) return;
        if (applied !== 'applied') setError(applied === 'DRAFT_CHANGED' ? 'draftChanged' : 'editorUnavailable');
      }
      if (result.navigationError) setError('unavailable');
      if (result.navigation && valid()) {
        try {
          const navigation = await window.electronAPI.ghosts.ui.tabViews.navigate(result.navigation.requestId);
          if (valid() && (navigation.tab === 'unavailable' || navigation.page === 'unconfirmed' && navigation.tab !== 'superseded')) setError('unavailable');
        } catch { if (valid()) setError('unavailable'); }
      }
      refresh.current();
    } finally {
      if (current.current === scope) { inFlight.current.delete(view.viewId); setPending(new Set(inFlight.current)); }
    }
  }, [scope, enabled, state]);
  const chooseRenderer = useCallback(async (choice: PluginUiRendererChoice | null) => {
    if (!enabled || choosing || !isDataOwnerGenerationCurrent(owner) || !visible() || state?.scope !== scope ||
        !state.ready || state.subscriptionId !== activeSubscription.current || !state.renderer ||
        (choice && !state.renderer.candidates.some(candidate => candidate.instanceId === choice.instanceId &&
          candidate.contributionId === choice.contributionId))) return;
    setChoosing(true); setError(undefined);
    try {
      await choosePluginUiRenderer(input, choice);
      if (current.current === scope && isDataOwnerGenerationCurrent(owner)) refresh.current();
    } catch {
      if (current.current === scope && isDataOwnerGenerationCurrent(owner)) setError('unavailable');
    } finally { if (current.current === scope) setChoosing(false); }
  }, [scope, enabled, state, choosing]);
  const currentState = state?.scope === scope && enabled && state.subscriptionId === activeSubscription.current ? state : undefined;
  // An update makes actions stale, not the already displayed content. Keep the
  // current renderer mounted until the read completes; failure clears renderer
  // metadata above, and a released/changed subscription has no currentState.
  return { views: currentState?.views ?? [],
    renderer: currentState?.renderer, choosing, chooseRenderer,
    disabled: !enabled || !!input.readOnly || !currentState?.ready, pending, error, invoke };
}
