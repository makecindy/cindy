/**
 * 「允许被远程调用」for the task engines a plugin provides (docs/plans/acp-plugin-bridge.md).
 *
 * One card per engine in the plugin's configuration section, drawn by Cindy (never by the plugin's
 * own settings page, which could otherwise open this computer on the user's behalf). Turning it on
 * lets the user's other computers (and invited friends when `shareSupported` / `guestWorkspace` is
 * published by the plugin) run tasks on this engine: the agent runs here with this computer's
 * sign-in and quota, while the task's files and commands stay on the computer the task is on.
 *
 * The levels follow an ordinary provider's row: this computer must allow remote control first, and
 * the plugin must offer the mode for that engine; otherwise the switch stays visible but cannot be
 * used, with the reason underneath. The same holds while the user has the engine turned off in
 * Settings → Model providers: nothing can use it until it is turned on there, so the switch shows what
 * is stored but cannot be changed here. The stored state arrives with the engine list (main pushes the
 * complete list after every change), so the card needs no read of its own.
 */
import { MonitorSmartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Switch } from '@/components/ui/switch';
import { ProviderShareEntryButton } from '@/features/provider-share/ProviderShareEntryButton';
import { pendingRequestCountByProvider } from '@/features/provider-share/providerShareFormat';
import { providerShareManagePath } from '@/features/provider-share/providerShareNavigation';
import { useProviderSharePendingRequests } from '@/features/provider-share/providerShareStore';
import { usePluginEngines } from '@/hooks/usePluginEngines';
import { useRemoteControlEnabled } from '@/hooks/useRemoteControlEnabled';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import type { PluginEngineView } from '../../../shared/pluginEngines';

/** The engines of one installed plugin on this computer (empty while it is off or unapproved). */
export function usePluginRemoteUseEngines(ghostId: string | null | undefined, enabled = true): readonly PluginEngineView[] {
  const engines = usePluginEngines(enabled && !!ghostId);
  // Without the setter (an older preload) the switch could not be written: show nothing.
  const writable = typeof window.electronAPI?.maker?.setPluginEngineRemoteUse === 'function';
  if (!ghostId || !writable) return NO_ENGINES;
  const own = engines.filter((engine) => engine.ghostId === ghostId);
  return own.length === 0 ? NO_ENGINES : own;
}

const NO_ENGINES: readonly PluginEngineView[] = Object.freeze([]);

/**
 * The 「允许被远程调用」 switch of one engine: what is stored, and how to change it. Shared by the
 * card in the plugin's own page and the row in Settings → Model providers, so both show the same
 * state (main pushes the complete engine list after every change) and fail the same way.
 */
export function usePluginEngineRemoteUseSwitch(engine: PluginEngineView): {
  supported: boolean;
  shareSupported: boolean;
  enabled: boolean;
  busy: boolean;
  setEnabled(next: boolean): void;
} {
  const { t } = useTranslation();
  const supported = engine.remoteUse?.supported === true;
  const shareSupported = supported && engine.remoteUse?.shareSupported === true;
  const stored = engine.remoteUse?.enabled === true;
  const [enabled, setEnabled] = useState(stored);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEnabled(stored);
  }, [stored]);
  return {
    supported,
    shareSupported,
    enabled,
    busy,
    setEnabled(next) {
      const setRemoteUse = window.electronAPI?.maker?.setPluginEngineRemoteUse;
      if (!setRemoteUse) return;
      const previous = enabled;
      setEnabled(next);
      setBusy(true);
      void setRemoteUse(engine.key, next)
        .then((state) => setEnabled(state.supported && state.enabled))
        .catch((error: unknown) => {
          setEnabled(previous);
          // 主进程说明了原因(插件不支持)就照它说；其余按保存失败处理。
          const unsupported = error instanceof Error && error.message.includes('[PLUGIN_ENGINE_REMOTE_USE_UNSUPPORTED]');
          toast.error(t(unsupported
            ? 'chat.remoteError.PLUGIN_ENGINE_REMOTE_USE_UNSUPPORTED'
            : 'settings.providers.detail.remoteAccess.writeFailed'));
        })
        .finally(() => setBusy(false));
    },
  };
}

function EngineRemoteUseCard({
  engine,
  named,
  remoteControlEnabled,
  pendingShareCount,
  onManageShare,
  surfaceClassName,
}: {
  engine: PluginEngineView;
  /** The plugin provides several engines: the card names the one it is about. */
  named: boolean;
  remoteControlEnabled: boolean;
  pendingShareCount: number;
  onManageShare?: (engine: PluginEngineView) => void;
  surfaceClassName: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { supported, shareSupported, enabled, busy, setEnabled } = usePluginEngineRemoteUseSwitch(engine);
  return (
    <div
      data-plugin-engine-remote-use={engine.key}
      className={cn(surfaceClassName, 'flex min-h-20 items-center gap-3 rounded-xl px-5 py-4')}
    >
      <MonitorSmartphone size={18} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
          {/* 与普通供应商同一个名字的开关：沿用它的文案，不另起一种说法。 */}
          {named
            ? t('settings.ghosts.detail.engineRemoteUse.titleNamed', { engine: engine.name })
            : t('settings.providers.detail.remoteAccess.label')}
        </p>
        <p className="mt-0.5 text-13 leading-[1.54] text-[var(--text-secondary)]">
          {engine.suspended ? (
            <>
              {t('settings.ghosts.detail.engineRemoteUse.providerDisabled')}{' '}
              <button
                type="button"
                onClick={() => navigate('/settings?tab=providers')}
                // 无框文字按钮：圆角只塑形键盘焦点环（DESIGN.md §5 登记）
                className="rounded-sm text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {t('settings.ghosts.detail.engineRemoteUse.openProviders')}
              </button>
            </>
          ) : !remoteControlEnabled ? (
            <>
              {t('settings.ghosts.detail.engineRemoteUse.remoteControlOff')}{' '}
              <button
                type="button"
                onClick={() => navigate('/settings?tab=remote-control')}
                // 无框文字按钮：圆角只塑形键盘焦点环（DESIGN.md §5 登记）
                className="rounded-sm text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {t('providerShare.entry.openRemoteControl')}
              </button>
            </>
          ) : !supported ? (
            t('settings.ghosts.detail.engineRemoteUse.unsupported')
          ) : (
            t(shareSupported
              ? 'settings.ghosts.detail.engineRemoteUse.descriptionShareable'
              : 'settings.ghosts.detail.engineRemoteUse.description')
          )}
        </p>
      </div>
      {shareSupported ? (
        <ProviderShareEntryButton
          groupSize={null}
          pendingCount={pendingShareCount}
          onOpen={() => {
            if (onManageShare) onManageShare(engine);
            else navigate(providerShareManagePath(engine.providerId));
          }}
        />
      ) : null}
      <Switch
        checked={supported && enabled}
        disabled={busy || !remoteControlEnabled || !supported || engine.suspended === true}
        aria-label={t('settings.ghosts.detail.engineRemoteUse.ariaLabel', { engine: engine.name })}
        onCheckedChange={setEnabled}
      />
    </div>
  );
}

/** The cards for the engines `usePluginRemoteUseEngines` returned; nothing until the remote-control state is known. */
export function PluginEngineRemoteUseCards({
  engines,
  onManageShare,
  surfaceClassName,
}: {
  engines: readonly PluginEngineView[];
  onManageShare?: (engine: PluginEngineView) => void;
  surfaceClassName: string;
}) {
  const remoteControlEnabled = useRemoteControlEnabled();
  const pendingRequests = useProviderSharePendingRequests();
  // Not read yet: leave the cards out rather than flash the "remote control is off" explanation.
  if (engines.length === 0 || remoteControlEnabled === null) return null;
  const pendingCounts = pendingRequestCountByProvider(
    pendingRequests.filter((item) => !item.hostDeviceId).map((item) => item.share),
  );
  return (
    <>
      {engines.map((engine) => (
        <EngineRemoteUseCard
          key={engine.key}
          engine={engine}
          named={engines.length > 1}
          remoteControlEnabled={remoteControlEnabled}
          pendingShareCount={pendingCounts.get(engine.providerId) ?? 0}
          onManageShare={onManageShare}
          surfaceClassName={surfaceClassName}
        />
      ))}
    </>
  );
}
