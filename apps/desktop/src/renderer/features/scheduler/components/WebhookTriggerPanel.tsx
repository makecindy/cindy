import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '@cindy/maker-scheduler';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';

type WebhookStatus = Awaited<ReturnType<typeof window.electronAPI.maker.schedule.webhookStatus>>;

const STATUS_REFRESH_MS = 30_000;

function CopyableValue({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-[hsl(var(--content-area))] px-2 py-1 text-11 text-[var(--msg-assistant-text)]" title={value}>
        {value}
      </code>
      <Tip text={t('scheduler.webhook.copy')}>
        <Button
          variant="secondary"
          tone="quiet"
          size="xs"
          aria-label={`${t('scheduler.webhook.copy')} ${label}`}
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          <Copy size={13} strokeWidth={2} />
        </Button>
      </Tip>
    </div>
  );
}

/** 当前状态的一句说明；正常接收时没有说明。 */
function statusHint(status: NonNullable<WebhookStatus>): string | null {
  if (status.receiver === 'signed-out') return 'scheduler.webhook.signedOut';
  if (status.receiver === 'unavailable') return 'scheduler.webhook.serviceUnavailable';
  if (status.receiver === 'local') return 'scheduler.webhook.localOnlyHint';
  if (status.problem === 'suspended') return 'scheduler.webhook.suspended';
  if (status.problem === 'quota') return 'scheduler.webhook.quotaExhausted';
  if (status.problem === 'limit') return 'scheduler.webhook.endpointLimit';
  if (status.problem === 'failed' || !status.url) return 'scheduler.webhook.urlUnavailable';
  if (!status.connected) return 'scheduler.webhook.offline';
  return null;
}

/** 任务详情里的接收地址与密钥。密钥明文只在生成后留在这个组件的内存里，切换任务即消失。 */
export function WebhookTriggerPanel({ schedule }: { schedule: Schedule }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WebhookStatus>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const scheduleId = schedule.id;
  // 运行或配置变化都会让 lastFiredAt / updatedAt 变化，顺带刷新最近投递。
  const revision = `${schedule.updatedAt}:${schedule.lastFiredAt ?? ''}`;

  useEffect(() => {
    setSecret(null);
  }, [scheduleId]);

  useEffect(() => {
    let current = true;
    const load = () => window.electronAPI.maker.schedule.webhookStatus(scheduleId).then(
      (next) => { if (current) setStatus(next); },
      () => { if (current) setStatus(null); },
    );
    void load();
    // 连接状态和接收次数不会改变任务本身，靠定时刷新反映到界面。
    const timer = setInterval(() => void load(), STATUS_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [scheduleId, revision, secret]);

  const rotate = useCallback(async () => {
    setRotating(true);
    try {
      const result = await window.electronAPI.maker.schedule.rotateWebhookSecret(scheduleId);
      setSecret(result.secret);
    } catch {
      toast.error(t('scheduler.webhook.rotateFailed'));
    } finally {
      setRotating(false);
    }
  }, [scheduleId, t]);

  const hint = status ? statusHint(status) : null;
  const canManageSecret = status?.receiver === 'local' || (status?.receiver === 'cloud' && Boolean(status.url));

  return (
    <div className="mx-6 mt-3 flex flex-col gap-2 rounded-xl border border-[var(--cmd-palette-border)] px-3 py-2.5 text-xs text-[var(--cmd-palette-item-meta)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-[var(--msg-assistant-text)]">{t('scheduler.webhook.title')}</span>
        {canManageSecret && (
          <Button variant="secondary" size="sm" disabled={rotating} onClick={() => void rotate()}>
            {status?.hasSecret ? t('scheduler.webhook.rotateSecret') : t('scheduler.webhook.generateSecret')}
          </Button>
        )}
      </div>
      {status?.url && <CopyableValue value={status.url} label={t('scheduler.webhook.url')} />}
      {secret && (
        <div className="flex flex-col gap-1">
          <span className="text-[var(--msg-assistant-text)]">{t('scheduler.webhook.secretOnce')}</span>
          <CopyableValue value={secret} label={t('scheduler.webhook.secret')} />
        </div>
      )}
      {canManageSecret && !status?.hasSecret && !secret && <span>{t('scheduler.webhook.secretMissing')}</span>}
      {hint && (
        <span>
          {t(hint, {
            limit: status?.quotaLimit,
            time: status?.quotaResetAt ? new Date(status.quotaResetAt).toLocaleString() : '',
          })}
        </span>
      )}
      {schedule.webhookTrigger?.events?.length ? (
        <span className="break-words">{t('scheduler.webhook.eventsSummary', { events: schedule.webhookTrigger.events.join(', ') })}</span>
      ) : null}
      {status && (
        <span>
          {status.lastReceivedAt
            ? t('scheduler.webhook.lastReceived', { time: new Date(status.lastReceivedAt).toLocaleString() })
            : t('scheduler.webhook.neverReceived')}
          {status.ignored > 0 ? ` · ${t('scheduler.webhook.ignored', { count: status.ignored })}` : ''}
        </span>
      )}
    </div>
  );
}
