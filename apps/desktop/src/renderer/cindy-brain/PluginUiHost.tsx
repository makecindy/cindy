import { useEffect } from 'react';
import { getDraft, saveDraft, plainTextToTiptapDoc } from '@/lib/composerDraftStore';
import { pluginUiDraftSnapshot } from './pluginUiContext';
import { openPluginUiView } from '@/features/right-sidebar/lib/openPluginUiView';
import { usePluginUiLaunchers, runPluginUiLauncher } from './PluginUiContributions';
import { matchesPluginAppShortcut } from '@/lib/appShortcutStore';
import { isAppInteractionLocked } from '@/lib/appInteractionLock';
import { toast } from '@/lib/toast';
import { useTranslation } from 'react-i18next';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';

/** Commands arrive only from a Main-bound View, on its owning window. */
export function PluginUiHost() {
  const commands = usePluginUiLaunchers();
  const { t } = useTranslation();
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
  useEffect(() => window.electronAPI.maker.onPluginUiAction(input => {
    if (!input || typeof input !== 'object') return;
    const action = input as Record<string, unknown>;
    if (typeof action.requestId !== 'string') return;
    void (async () => {
      let result: unknown;
      let error: string | undefined;
      try {
        if (!isDataOwnerPushStampCurrent(action.ownerStamp)) throw new Error('MCP_APP_OWNER_CHANGED');
        if (action.kind === 'open' && typeof action.instanceId === 'string' && typeof action.viewId === 'string') {
          await openPluginUiView(action.instanceId, action.viewId, typeof action.sessionId === 'string' ? action.sessionId : null,
            action.input && typeof action.input === 'object' && !Array.isArray(action.input) ? action.input as Record<string, unknown> : undefined);
          result = { opened: true };
        } else if (action.kind === 'draft' && typeof action.sessionId === 'string' && typeof action.text === 'string') {
          const current = pluginUiDraftSnapshot(action.sessionId);
          if (action.mode === 'replace' && action.revision !== current.revision) throw new Error('MCP_APP_DRAFT_CHANGED');
          const draft = getDraft(action.sessionId);
          const incoming = plainTextToTiptapDoc(action.text);
          const text = action.mode === 'append' && draft?.text
            ? { ...draft.text, content: [...(draft.text.content ?? []), ...(incoming.content ?? [])] }
            : incoming;
          saveDraft(action.sessionId, { ...draft, text, attachments: draft?.attachments ?? [] });
          result = pluginUiDraftSnapshot(action.sessionId);
        } else throw new Error('MCP_APP_INVALID_REQUEST');
      } catch (failure) {
        error = failure instanceof Error && /^MCP_APP_[A-Z_]+$/.test(failure.message) ? failure.message : 'MCP_APP_ACTION_FAILED';
      }
      await window.electronAPI.maker.mcpApps(null, { op: 'host-result', requestId: action.requestId, result, error }).catch(() => {});
    })();
  }), []);
  return null;
}
