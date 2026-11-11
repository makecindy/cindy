import { useEffect } from 'react';
import { getDraft, saveDraft, plainTextToTiptapDoc } from '@/lib/composerDraftStore';
import { pluginUiDraftSnapshot, subscribePluginUiDraft, replacePluginUiDraftSelection, readPluginUiDraftDocument, assertPluginUiDraftWritable } from './pluginUiContext';
import { openPluginUiView } from '@/features/right-sidebar/lib/openPluginUiView';
import { usePluginUiLaunchers, runPluginUiLauncher } from './PluginUiContributions';
import { matchesPluginAppShortcut } from '@/lib/appShortcutStore';
import { isAppInteractionLocked } from '@/lib/appInteractionLock';
import { toast } from '@/lib/toast';
import { useTranslation } from 'react-i18next';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { applyPluginUiRegions } from './pluginUiVisibility';
import { applyPluginAppearanceInWindow } from './usePluginAppearance';
import type { AppearanceSettings } from '../../shared/appearanceSettings';
import { DEFAULT_PLUGIN_UI_REGIONS, type PluginUiRegions } from '../../shared/pluginUi';

/** Main routes editor/layout commands here, including those from detached Views. */
export function PluginUiHost() {
  const commands = usePluginUiLaunchers();
  const { t } = useTranslation();
  useEffect(() => () => applyPluginUiRegions(DEFAULT_PLUGIN_UI_REGIONS), []);
  useEffect(() => {
    if (!commands.some(command => command.shortcut)) return;
    const pressed = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || isAppInteractionLocked() || document.body.dataset.appShortcutRecording === '1') return;
      const command = commands.find(command => command.shortcut && matchesPluginAppShortcut(event, command.shortcut));
      if (!command) return;
      const sessionId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-plugin-ui-task]')?.dataset.pluginUiTask ?? null;
      if (command.scope === 'task' && !sessionId) return;
      event.preventDefault();
      void runPluginUiLauncher(command, sessionId).catch(() => toast.error(t('pluginUi.actionFailed')));
    };
    window.addEventListener('keydown', pressed);
    return () => window.removeEventListener('keydown', pressed);
  }, [commands, t]);
  useEffect(() => {
    const watches = new Map<string, () => void>();
    const unlisten = window.electronAPI.maker.onPluginUiAction(input => {
      if (!input || typeof input !== 'object') return;
      const action = input as Record<string, unknown>;
      if (action.kind === 'regions-sync') {
        if (isDataOwnerPushStampCurrent(action.ownerStamp)) applyPluginUiRegions(action.values as PluginUiRegions);
        return;
      }
      if (typeof action.requestId !== 'string') return;
      const requestId = action.requestId;
      if (action.kind === 'draft-unwatch') { watches.get(requestId)?.(); return; }
      void (async () => {
        let result: unknown;
        let error: string | undefined;
        try {
          if (!isDataOwnerPushStampCurrent(action.ownerStamp)) throw new Error('MCP_APP_OWNER_CHANGED');
          if (action.kind === 'appearance') {
            result = await applyPluginAppearanceInWindow(action.settings as AppearanceSettings);
          } else if (action.kind === 'regions') {
            applyPluginUiRegions(action.values as PluginUiRegions);
            result = { applied: true };
          } else if (action.kind === 'draft-watch' && typeof action.sessionId === 'string') {
            const sessionId = action.sessionId;
            let disposed = false, queued = false, forwarding = false, dirty = false;
            let lastRevision: string | undefined;
            const stop = () => { disposed = true; unsubscribe(); watches.delete(requestId); };
            const changed = () => {
              dirty = true;
              if (disposed || queued || forwarding) return;
              queued = true;
              queueMicrotask(() => { queued = false; void forward(); });
            };
            const forward = async () => {
              if (disposed) return;
              forwarding = true;
              try {
                while (!disposed && dirty) {
                  dirty = false;
                  if (!isDataOwnerPushStampCurrent(action.ownerStamp)) throw new Error('MCP_APP_OWNER_CHANGED');
                  const snapshot = pluginUiDraftSnapshot(sessionId);
                  if (snapshot.revision === lastRevision) continue;
                  lastRevision = snapshot.revision;
                  await window.electronAPI.maker.mcpApps(null, { op: 'host-result', requestId, result: snapshot });
                }
              } catch {
                stop();
              } finally { forwarding = false; }
            };
            watches.get(requestId)?.();
            const unsubscribe = subscribePluginUiDraft(sessionId, changed);
            watches.set(requestId, stop);
            changed();
            return;
          } else if (action.kind === 'draft-read' && typeof action.sessionId === 'string') {
            result = readPluginUiDraftDocument(action.sessionId, action.offset as number | undefined, action.revision as string | undefined);
          } else if (action.kind === 'open' && typeof action.instanceId === 'string' && typeof action.viewId === 'string') {
            await openPluginUiView(action.instanceId, action.viewId, typeof action.sessionId === 'string' ? action.sessionId : null,
              action.input && typeof action.input === 'object' && !Array.isArray(action.input) ? action.input as Record<string, unknown> : undefined);
            result = { opened: true };
          } else if (action.kind === 'draft' && typeof action.sessionId === 'string' && typeof action.text === 'string') {
            assertPluginUiDraftWritable(action.sessionId);
            const current = pluginUiDraftSnapshot(action.sessionId);
            if (action.mode !== 'append' && action.revision !== current.revision) throw new Error('MCP_APP_DRAFT_CHANGED');
            if (action.mode === 'replace-selection') {
              replacePluginUiDraftSelection(action.sessionId, action.text);
            } else {
              const draft = getDraft(action.sessionId);
              const incoming = plainTextToTiptapDoc(action.text);
              const text = action.mode === 'append' && draft?.text
                ? { ...draft.text, content: [...(draft.text.content ?? []), ...(incoming.content ?? [])] }
                : incoming;
              saveDraft(action.sessionId, { ...draft, text, attachments: draft?.attachments ?? [] });
            }
            result = pluginUiDraftSnapshot(action.sessionId);
          } else throw new Error('MCP_APP_INVALID_REQUEST');
        } catch (failure) {
          error = failure instanceof Error && /^MCP_APP_[A-Z_]+$/.test(failure.message) ? failure.message : 'MCP_APP_ACTION_FAILED';
        }
        await window.electronAPI.maker.mcpApps(null, { op: 'host-result', requestId, result, error }).catch(() => {});
      })();
    });
    return () => { unlisten(); for (const stop of watches.values()) stop(); };
  }, []);
  return null;
}
