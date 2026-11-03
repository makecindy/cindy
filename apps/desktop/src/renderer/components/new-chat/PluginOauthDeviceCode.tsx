import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import type {
  PluginOauthDeviceCodeTarget,
  PluginOauthDeviceCodeView,
} from '../../../shared/pluginOauthDeviceCode';

// Notification deduplication contains only card IDs/deadlines, never authorization material.
const notified = new Map<string, number>();

export interface PluginOauthPresentation {
  view: PluginOauthDeviceCodeView | null;
  now: number;
  working: 'copy' | 'reopen' | null;
  failed: boolean;
  operate: (operation: 'copy' | 'reopen') => Promise<void>;
}

/** Ephemeral view; it never writes to the chat store, messages, localStorage or remote transport. */
export function PluginOauthDeviceCode({
  target,
  active,
  children,
  running = false,
}: {
  target: PluginOauthDeviceCodeTarget;
  active: boolean;
  running?: boolean;
  children?: (state: PluginOauthPresentation) => ReactNode;
}) {
  return (
    <DeviceCodeView
      key={JSON.stringify(target)}
      target={target}
      active={active}
      running={running}
      children={children}
    />
  );
}

function DeviceCodeView({
  target,
  active,
  children,
  running,
}: {
  target: PluginOauthDeviceCodeTarget;
  active: boolean;
  running: boolean;
  children?: (state: PluginOauthPresentation) => ReactNode;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<PluginOauthDeviceCodeView | null>(null);
  const [now, setNow] = useState(Date.now);
  const [working, setWorking] = useState<'copy' | 'reopen' | null>(null);
  const [failed, setFailed] = useState(false);
  const current = useRef(false);
  const command = useRef(false);
  const epoch = useRef(0);
  const key = JSON.stringify([target.deviceId, target.ghostId, target.requestId, target.actionId]);

  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++epoch.current;
    command.current = false;
    setWorking(null);
    setFailed(false);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!active || !window.electronAPI.maker.pluginOauthDeviceCode) {
      setView(null);
      return;
    }
    const read = async () => {
      try {
        const next = await window.electronAPI.maker.pluginOauthDeviceCode({
          ...target,
          operation: 'read',
        });
        if (!alive || generation !== epoch.current) return;
        setNow(Date.now());
        setView(
          next &&
            (next.phase === 'ready' || next.phase === 'browser') &&
            next.expiresAt <= Date.now()
            ? { phase: 'expired' }
            : next,
        );
        if (next?.phase === 'ready' && next.expiresAt > Date.now()) {
          for (const [id, expiry] of notified) if (expiry <= Date.now()) notified.delete(id);
          const notice = `${key}:${next.expiresAt}`;
          if (!notified.has(notice)) {
            if (notified.size >= 64) notified.delete(notified.keys().next().value!);
            notified.set(notice, next.expiresAt);
            toast.success(t('newChat.pluginSetup.deviceCode.copiedHint'), { duration: 5000 });
          }
        }
        if (!next || next.phase === 'ready' || next.phase === 'browser' || running)
          timer = setTimeout(() => void read(), 750);
      } catch {
        if (alive) setView((previous) => (previous ? { phase: 'ended' } : null));
      }
    };
    void read();
    return () => {
      alive = false;
      ++epoch.current;
      clearTimeout(timer);
    };
  }, [key, active, running, t]);

  useEffect(() => {
    if (view?.phase !== 'ready' && view?.phase !== 'browser') return;
    const timer = setTimeout(
      () => setView({ phase: 'expired' }),
      Math.max(0, view.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view?.phase, view?.phase === 'ready' || view?.phase === 'browser' ? view.expiresAt : null]);

  const ready = active && view?.phase === 'ready' && view.expiresAt > now ? view : null;
  const operate = async (operation: 'copy' | 'reopen') => {
    const available =
      active &&
      (view?.phase === 'ready' || view?.phase === 'browser') &&
      view.expiresAt > Date.now();
    if (!available || (operation === 'copy' && !ready) || command.current) return;
    command.current = true;
    const generation = epoch.current;
    setWorking(operation);
    setFailed(false);
    try {
      const next = await window.electronAPI.maker.pluginOauthDeviceCode({ ...target, operation });
      if (!current.current || generation !== epoch.current) return;
      setView(next);
      setNow(Date.now());
      if (operation === 'copy' && next?.phase === 'ready')
        toast.success(t('newChat.pluginSetup.deviceCode.copied'));
    } catch {
      if (current.current && generation === epoch.current) setFailed(true);
    } finally {
      if (generation === epoch.current) command.current = false;
      if (current.current && generation === epoch.current) setWorking(null);
    }
  };
  if (children) return children({ view: active ? view : null, now, working, failed, operate });
  if (!active || !view || view.phase === 'browser') return null;
  const seconds = ready ? Math.max(0, Math.ceil((ready.expiresAt - now) / 1000)) : 0;
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
      data-plugin-oauth-device-code
    >
      {ready ? (
        <>
          <p className="text-13 text-[var(--text-secondary)]" role="status">
            {t('newChat.pluginSetup.deviceCode.copiedHint')}
          </p>
          <code
            className="select-all whitespace-pre-wrap break-all text-20 font-medium tracking-wider text-[var(--text-primary)]"
            aria-label={t('newChat.pluginSetup.deviceCode.label')}
          >
            {ready.userCode}
          </code>
          <p className="text-13 leading-5 text-[var(--text-secondary)]">
            {t('newChat.pluginSetup.deviceCode.instructions', { host: ready.verificationHost })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void operate('copy')}
              disabled={!!working}
              className="gap-2"
            >
              <Copy size={14} aria-hidden="true" />
              {t('newChat.pluginSetup.deviceCode.copyAgain')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void operate('reopen')}
              disabled={!!working}
              className="gap-2"
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t('newChat.pluginSetup.deviceCode.reopen')}
            </Button>
          </div>
          <p className="text-12 text-[var(--text-secondary)]">
            {t('newChat.pluginSetup.deviceCode.remaining', { time })}
          </p>
          {failed ? (
            <p role="alert" className="text-13 text-[var(--error-fg)]">
              {t('newChat.pluginSetup.deviceCode.actionFailed')}
            </p>
          ) : null}
        </>
      ) : (
        <p role="status" className="text-13 text-[var(--text-secondary)]">
          {t(`newChat.pluginSetup.deviceCode.${view.phase === 'ready' ? 'expired' : view.phase}`)}
        </p>
      )}
    </div>
  );
}
