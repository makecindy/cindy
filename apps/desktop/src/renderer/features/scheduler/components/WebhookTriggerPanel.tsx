import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '@cindy/maker-scheduler';
import {
  DEFAULT_SCHEDULE_WEBHOOK_PRESET,
  scheduleWebhookPreset,
  scheduleWebhookSecretFrom,
} from '@cindy/maker-scheduler/webhook-formats';
import { Button } from '@/components/ui/button';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
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

const errorCode = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 任务详情里的接收地址与密钥。生成的密钥明文只留在这个组件的内存里，切换任务即消失；
 * 粘贴的密钥保存后立即清空输入框，不回显。
 */
export function WebhookTriggerPanel({ schedule }: { schedule: Schedule }) {
  const { t } = useTranslation();
  const confirmDialog = useOptionalConfirmDialog();
  const [status, setStatus] = useState<WebhookStatus>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const scheduleId = schedule.id;
  // 运行或配置变化都会让 lastFiredAt / updatedAt 变化，顺带刷新最近投递。
  const scheduleRevision = `${schedule.updatedAt}:${schedule.lastFiredAt ?? ''}`;
  const source = schedule.webhookTrigger?.source;
  const preset = scheduleWebhookPreset(source?.preset ?? DEFAULT_SCHEDULE_WEBHOOK_PRESET);
  const senderName = source?.preset === 'custom' || !preset ? t('scheduler.webhook.genericSender') : preset.label;
  const secretField = preset?.secretField ?? 'Secret';

  useEffect(() => {
    setSecret(null);
    setPasted('');
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
  }, [scheduleId, scheduleRevision, revision]);

  const run = useCallback(async (action: () => Promise<void>, failedKey: string) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      const code = errorCode(error);
      toast.error(t(code.includes('WEBHOOK_SECRET_INVALID') ? 'scheduler.webhook.secretInvalid' : failedKey));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }, [t]);

  const generate = () => run(async () => {
    const result = await window.electronAPI.maker.schedule.setWebhookSecret(scheduleId);
    setSecret(result.secret ?? null);
  }, 'scheduler.webhook.rotateFailed');

  const savePasted = () => run(async () => {
    await window.electronAPI.maker.schedule.setWebhookSecret(scheduleId, pasted.trim());
    setPasted('');
    setSecret(null);
    toast.success(t('scheduler.webhook.secretSaved'));
  }, 'scheduler.webhook.secretSaveFailed');

  const rotateUrl = async () => {
    const confirmed = confirmDialog
      ? await confirmDialog.confirm({
        title: t('scheduler.webhook.rotateUrlConfirmTitle'),
        description: t('scheduler.webhook.rotateUrlConfirmBody'),
        confirmText: t('scheduler.webhook.rotateUrl'),
      })
      : true;
    if (confirmed) await run(() => window.electronAPI.maker.schedule.rotateWebhookUrl(scheduleId).then(() => undefined), 'scheduler.webhook.rotateUrlFailed');
  };

  const hint = status ? statusHint(status) : null;
  const local = status?.receiver === 'local';
  const ready = local || (status?.receiver === 'cloud' && Boolean(status.url));
  // 开发版的本机入口只认 GitHub 格式，密钥一律由 Cindy 生成。
  const secretFrom = local ? 'cindy' : scheduleWebhookSecretFrom(source);
  const canGenerate = ready && (secretFrom === 'cindy' || secretFrom === 'either');
  const canPaste = ready && (secretFrom === 'sender' || secretFrom === 'either');
  const hasSecret = Boolean(status?.hasSecret);

  return (
    <div className="mx-6 mt-3 flex flex-col gap-2 rounded-xl border border-[var(--cmd-palette-border)] px-3 py-2.5 text-xs text-[var(--cmd-palette-item-meta)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-[var(--msg-assistant-text)]">{t('scheduler.webhook.title')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {canGenerate && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void generate()}>
              {hasSecret ? t('scheduler.webhook.rotateSecret') : t('scheduler.webhook.generateSecret')}
            </Button>
          )}
          {ready && !local && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void rotateUrl()}>
              {t('scheduler.webhook.rotateUrl')}
            </Button>
          )}
        </div>
      </div>
      {status?.url && <CopyableValue value={status.url} label={t('scheduler.webhook.url')} />}
      {secret && (
        <div className="flex flex-col gap-1">
          <span className="text-[var(--msg-assistant-text)]">
            {t('scheduler.webhook.secretOnce')} {t('scheduler.webhook.secretFillHint', { sender: senderName, field: secretField })}
          </span>
          <CopyableValue value={secret} label={t('scheduler.webhook.secret')} />
        </div>
      )}
      {canPaste && (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (pasted.trim()) void savePasted();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={t('scheduler.webhook.secretPastePlaceholder', { sender: senderName, field: secretField })}
            aria-label={t('scheduler.webhook.secretPastePlaceholder', { sender: senderName, field: secretField })}
            className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--settings-input-border)] bg-transparent px-2 text-xs text-[var(--settings-input-text)] outline-none"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={busy || !pasted.trim()}>
            {t('scheduler.webhook.secretSave')}
          </Button>
        </form>
      )}
      {secretFrom === null && ready && (
        <span className="font-medium text-[var(--msg-assistant-text)]">{t('scheduler.webhook.unsignedNotice')}</span>
      )}
      {secretFrom !== null && ready && !hasSecret && !secret && (
        <span>{t(secretFrom === 'sender' ? 'scheduler.webhook.secretPasteMissing' : 'scheduler.webhook.secretMissing')}</span>
      )}
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
