import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { extractIpcError } from '@/utils/ipcError';
import type { WebhookAccountEndpoint, WebhookAccountOverview } from '../../../../shared/webhookAccount';

const K = 'scheduler.webhook.account';

type Props = { onChanged?: () => void; allowOpenSchedule?: boolean };
export function WebhookAccountManager(props: Props) {
  const owner = useOptionalDataOwnerGeneration();
  return <AccountManager key={owner} {...props} />;
}

/** 只在打开/聚焦时刷新。释放确认留在原行，不叠第二个弹窗，也不丢当前表单。 */
function AccountManager({ onChanged, allowOpenSchedule = true }: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WebhookAccountOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const request = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current += 1; };
  }, []);

  const load = useCallback(async () => {
    const version = ++request.current;
    setLoading(true);
    try {
      const next = await window.electronAPI.maker.schedule.webhookAccount();
      if (!alive.current || version !== request.current) return;
      setData(next);
      setError(null);
    } catch (cause) {
      if (!alive.current || version !== request.current) return;
      setError(extractIpcError(cause)?.message === 'WEBHOOK_MANAGEMENT_UNAVAILABLE' ? 'unavailable' : 'loadFailed');
    } finally {
      if (alive.current && version === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void window.electronAPI.maker.schedule.webhookReceiver().then((receiver) => {
      if (!current) return;
      setAvailable(receiver === 'cloud');
      if (receiver === 'cloud') void load();
    }).catch(() => undefined);
    return () => { current = false; };
  }, [load]);
  useEffect(() => {
    if (!available) return;
    const refresh = () => { if (!busy) void load(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [available, busy, load]);

  const groups = useMemo(() => {
    const grouped = new Map<string, WebhookAccountEndpoint[]>();
    for (const endpoint of data?.endpoints ?? []) {
      const entries = grouped.get(endpoint.deviceId) ?? [];
      entries.push(endpoint);
      grouped.set(endpoint.deviceId, entries);
    }
    return [...grouped.values()].sort((a, b) => Number(b[0].currentDevice) - Number(a[0].currentDevice));
  }, [data]);
  const name = (endpoint: WebhookAccountEndpoint) => endpoint.scheduleName || t(`${K}.unnamed`, { id: endpoint.scheduleId.slice(0, 8) });
  const device = (endpoint: WebhookAccountEndpoint) => endpoint.deviceName || t(`${K}.unnamedDevice`, { id: endpoint.deviceId.slice(0, 8) });
  const release = async (endpoint: WebhookAccountEndpoint) => {
    setBusy(true);
    setNotice('');
    try {
      await window.electronAPI.maker.schedule.releaseWebhookEndpoint(endpoint.id);
      if (!alive.current) return;
      setPending(null);
      setNotice(t(`${K}.released`, { name: name(endpoint) }));
      onChanged?.();
      await load();
    } catch {
      if (alive.current) setError('releaseFailed');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (!available) return null;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (busy) return;
      setOpen(next); setPending(null); setNotice('');
      if (next) void load();
    }}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-12 text-[var(--text-secondary)]">
        <span>{data && !error ? t(`${K}.usage`, { used: data.used, limit: data.limit }) : t(`${K}.title`)}</span>
        <Dialog.Trigger asChild><Button variant="secondary" tone="quiet" size="sm" compact>{t(`${K}.manage`)}</Button></Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          className="modal-panel fixed left-1/2 top-1/2 z-[10000] flex max-h-[85vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 p-4 outline-none"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        >
          <div className="space-y-2">
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{t(`${K}.title`)}</Dialog.Title>
            <Dialog.Description className="text-13 leading-relaxed text-[var(--confirm-desc)]">{t(`${K}.description`)}</Dialog.Description>
          </div>
          {data && !error && <div className="flex flex-wrap items-baseline justify-between gap-2 text-13 text-[var(--text-secondary)]">
            <span className="text-16 font-medium text-[var(--text-primary)]">{t(`${K}.usage`, { used: data.used, limit: data.limit })}</span>
            <span>{t(`${K}.remaining`, { count: Math.max(0, data.limit - data.used) })}</span>
          </div>}
          <div aria-live="polite" className="text-13 leading-relaxed text-[var(--text-secondary)]">
            {notice}
            {error && <p role="alert">{t(`${K}.${error}`)} <Button size="sm" variant="secondary" tone="quiet" compact disabled={busy || loading} onClick={() => void load()}>{t(`${K}.retry`)}</Button></p>}
            {loading && !data && t(`${K}.loading`)}
          </div>
          <div className="min-h-0 overflow-y-auto border-y border-[var(--border-default)]" aria-busy={loading || busy}>
            {data?.endpoints.length === 0 && <p className="py-8 text-center text-13 text-[var(--text-secondary)]">{t(`${K}.empty`)}</p>}
            {groups.map((entries) => <section key={entries[0].deviceId} className="py-3">
              <h3 className="mb-1 flex items-center gap-2 text-12 font-medium text-[var(--text-secondary)]">
                <Monitor size={14} aria-hidden /><span className="min-w-0 break-words">{device(entries[0])}</span>
                {entries[0].currentDevice && <span className="shrink-0">· {t(`${K}.thisDevice`)}</span>}
              </h3>
              <ul className="divide-y divide-[var(--border-default)]">
                {entries.map((endpoint) => <li key={endpoint.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="break-words text-14 font-medium text-[var(--text-primary)]">{name(endpoint)}</p>
                      <p className="text-12 leading-relaxed text-[var(--text-secondary)]">
                        {endpoint.status === 'suspended' ? t(`${K}.suspended`) + ' · ' : ''}
                        {endpoint.lastReceivedAt ? t(`${K}.lastReceived`, { time: new Date(endpoint.lastReceivedAt).toLocaleString(i18n.resolvedLanguage?.includes('x-lzh') ? 'zh' : i18n.resolvedLanguage) }) : t(`${K}.neverReceived`)}
                      </p>
                    </div>
                    {pending !== endpoint.id && <div className="flex shrink-0 gap-1">
                      {allowOpenSchedule && endpoint.currentDevice && <Button size="sm" variant="secondary" tone="quiet" compact disabled={busy} onClick={() => {
                        setOpen(false); navigate(`/cc-agent/scheduled?focus=${encodeURIComponent(endpoint.scheduleId)}`);
                      }}>{t(`${K}.open`)}</Button>}
                      <Button size="sm" variant="secondary" tone="quiet" compact disabled={busy || loading || !!error} onClick={() => setPending(endpoint.id)}>{t(`${K}.release`)}</Button>
                    </div>}
                  </div>
                  {pending === endpoint.id ? <div className="space-y-3 rounded-xl border border-[var(--border-default)] p-3">
                    <p className="text-13 leading-relaxed text-[var(--text-primary)]">{t(`${K}.confirm`, { name: name(endpoint), device: device(endpoint) })}</p>
                    <p className="text-12 leading-relaxed text-[var(--text-secondary)]">{t(`${K}.confirmHint`)}</p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending(null)}>{t(`${K}.cancel`)}</Button>
                      <Button size="sm" tone="danger" loading={busy} disabled={loading || !!error} onClick={() => void release(endpoint)}>{t(`${K}.confirmRelease`)}</Button>
                    </div>
                  </div> : <details className="text-12 text-[var(--text-secondary)]">
                    <summary className="w-fit cursor-pointer py-1 underline underline-offset-2">{t(`${K}.viewAddress`)}</summary>
                    <div className="mt-1 flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all leading-relaxed">{endpoint.url}</code>
                      <Button size="sm" variant="secondary" tone="quiet" compact aria-label={t('scheduler.webhook.copy')} onClick={() => {
                        const label = t('scheduler.webhook.url');
                        void navigator.clipboard.writeText(endpoint.url).then(
                          () => setNotice(t('scheduler.webhook.copied', { label })),
                          () => setNotice(t('scheduler.webhook.copyFailed', { label })),
                        );
                      }}>{t('scheduler.webhook.copy')}</Button>
                    </div>
                  </details>}
                </li>)}
              </ul>
            </section>)}
          </div>
          <div className="flex justify-end"><Dialog.Close asChild><Button variant="secondary" disabled={busy}>{t(`${K}.done`)}</Button></Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
