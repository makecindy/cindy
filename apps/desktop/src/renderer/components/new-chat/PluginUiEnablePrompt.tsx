import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { InteractionPromptCardShell } from '@/components/interaction-portal';

import { RemotePluginUiEnablePrompt } from './RemotePluginUiEnablePrompt';

export function PluginUiEnablePrompt({ deviceId }: { deviceId?: string } = {}) {
  return deviceId ? <RemotePluginUiEnablePrompt key={deviceId} deviceId={deviceId} /> : <LocalPluginUiEnablePrompt />;
}
function LocalPluginUiEnablePrompt() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Array<{ id: string; name: string; version: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.electronAPI.ghosts
        .uiPrompts()
        .then((value) => {
          if (active) setItems(value);
        })
        .catch(() => {});
    };
    refresh();
    const off = window.electronAPI.ghosts.onChanged(refresh);
    return () => {
      active = false;
      off();
    };
  }, []);
  const item = items[0];
  if (!item && !enabled) return null;
  const showEnabled = enabled && !item;
  const title = t('newChat.pluginUi.title', { name: item?.name ?? '' });
  return (
    <InteractionPromptCardShell
      viewerState="expanded"
      onViewerStateChange={() => {}}
      collapsible={false}
      minimizedTitle={title}
      restoreAriaLabel={title}
      minimizeAriaLabel={title}
      className="w-full"
    >
      <div className="space-y-3 p-4 text-13 text-[var(--text-primary)]">
        <p>{showEnabled ? t('newChat.pluginUi.ready') : title}</p>
        {error && (
          <p role="alert" className="text-[var(--text-secondary)]">
            {t('settings.ghosts.errors.generic')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {showEnabled ? null : (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(false);
                  try {
                    const result = await window.electronAPI.ghosts.requestUiApproval(item.id);
                    if (result.granted) {
                      setEnabled(true);
                    }
                    setItems((value) => value.filter((entry) => entry.id !== item.id));
                  } catch {
                    setError(true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('newChat.pluginUi.enable')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  try {
                    await window.electronAPI.ghosts.deferUiPrompt(item.id, item.version);
                    setItems((value) => value.filter((entry) => entry.id !== item.id));
                  } catch {
                    setError(true);
                  }
                }}
              >
                {t('newChat.pluginUi.later')}
              </Button>
            </>
          )}
        </div>
      </div>
    </InteractionPromptCardShell>
  );
}
