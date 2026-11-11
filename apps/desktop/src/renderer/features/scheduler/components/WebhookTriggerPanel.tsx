import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule } from '@cindy/maker-scheduler';
import {
  DEFAULT_SCHEDULE_WEBHOOK_PRESET,
  scheduleWebhookPreset,
  scheduleWebhookSecretFrom,
} from '@cindy/maker-scheduler/webhook-formats';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Input } from '@/components/ui/input';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { WebhookAccountManager } from './WebhookAccountManager';
import { webhookEventOptions } from '../lib/webhookEventOptions';

type WebhookStatus = Awaited<ReturnType<typeof window.electronAPI.maker.schedule.webhookStatus>>;

const STATUS_REFRESH_MS = 30_000;
const setupSeenKey = (scheduleId: string) => `scheduler.webhook.setup-seen.${scheduleId}`;
const setupSeenWithoutStorage = new Set<string>();

function hasSeenSetup(scheduleId: string): boolean {
  if (setupSeenWithoutStorage.has(scheduleId)) return true;
  try {
    return localStorage.getItem(setupSeenKey(scheduleId)) === '1';
  } catch {
    return false;
  }
}

function markSetupSeen(scheduleId: string): void {
  try {
    // Only persist the one-time UI hint, never an address or secret.
    localStorage.setItem(setupSeenKey(scheduleId), '1');
  } catch {
    setupSeenWithoutStorage.add(scheduleId);
  }
}

function CopyableValue({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] py-2 pl-3 pr-2">
      <code
        className="min-w-0 flex-1 truncate text-12 leading-relaxed text-[var(--text-primary)]"
        title={value}
      >
        {value}
      </code>
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        compact
        aria-label={`${t('scheduler.webhook.copy')} ${label}`}
        onClick={() => void navigator.clipboard.writeText(value).then(
          () => toast.success(t('scheduler.webhook.copied', { label })),
          () => toast.error(t('scheduler.webhook.copyFailed', { label })),
        )}
      >
        <Copy size={14} strokeWidth={2} aria-hidden />
        {t('scheduler.webhook.copy')}
      </Button>
    </div>
  );
}

/** 当前状态的一句说明；正常接收时没有说明。 */
function statusHint(status: NonNullable<WebhookStatus>): string | null {
  if (status.receiver === 'signed-out') return 'scheduler.webhook.signedOut';
  if (status.receiver === 'unavailable') return 'scheduler.webhook.serviceUnavailable';
  if (status.receiver === 'local') return 'scheduler.webhook.localOnlyHint';
  if (status.problem === 'released') return 'scheduler.webhook.account.releasedHint';
  if (status.problem === 'suspended') return 'scheduler.webhook.suspended';
  if (status.problem === 'quota') return 'scheduler.webhook.quotaExhausted';
  if (status.problem === 'limit') return 'scheduler.webhook.endpointLimit';
  if (status.problem === 'failed') return 'scheduler.webhook.urlUnavailable';
  if (!status.url) return 'scheduler.webhook.preparing';
  if (!status.connected) return 'scheduler.webhook.offline';
  return null;
}

const errorCode = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  const statusRequest = useRef<Promise<void> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(() =>
    hasSeenSetup(schedule.id) ? false : null,
  );
  const settingsId = useId();
  const scheduleId = schedule.id;
  // 运行或配置变化都会让 lastFiredAt / updatedAt 变化，顺带刷新最近投递。
  const scheduleRevision = `${schedule.updatedAt}:${schedule.lastFiredAt ?? ''}`;
  const source = schedule.webhookTrigger?.source;
  const preset = scheduleWebhookPreset(source?.preset ?? DEFAULT_SCHEDULE_WEBHOOK_PRESET);
  const senderName =
    source?.preset === 'custom' || !preset ? t('scheduler.webhook.genericSender') : preset.label;
  const secretField = preset?.secretField ?? 'Secret';

  useEffect(() => {
    setSecret(null);
    setPasted('');
    setSettingsOpen(hasSeenSetup(scheduleId) ? false : null);
  }, [scheduleId]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      // A new revision waits for the existing read; disposed effects never queue
      // another IPC request when that read eventually finishes.
      if (statusRequest.current) await statusRequest.current;
      if (!current) return;
      const request = window.electronAPI.maker.schedule.webhookStatus(scheduleId).then(
        (next) => {
          if (current) setStatus(next);
        },
        () => {
          if (current) setStatus(null);
        },
      );
      statusRequest.current = request;
      await request;
      if (statusRequest.current === request) statusRequest.current = null;
      if (current) timer = setTimeout(() => void load(), STATUS_REFRESH_MS);
    };
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [scheduleId, scheduleRevision, revision]);

  useEffect(() => {
    if (status?.problem === 'released') {
      setSecret(null);
      setPasted('');
    }
  }, [status?.problem]);

  const run = useCallback(
    async (action: () => Promise<void>, failedKey: string) => {
      setBusy(true);
      try {
        await action();
      } catch (error) {
        const code = errorCode(error);
        toast.error(
          t(
            code.includes('WEBHOOK_SECRET_INVALID') ? 'scheduler.webhook.secretInvalid' : failedKey,
          ),
        );
      } finally {
        setBusy(false);
        setRevision((value) => value + 1);
      }
    },
    [t],
  );

  const generate = () =>
    run(async () => {
      const result = await window.electronAPI.maker.schedule.setWebhookSecret(scheduleId);
      setSecret(result.secret ?? null);
      // 状态刷新后仍保留配置区，让用户复制只显示一次的新密钥。
      setSettingsOpen(true);
    }, 'scheduler.webhook.rotateFailed');

  const savePasted = () =>
    run(async () => {
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
    if (confirmed)
      await run(
        () => window.electronAPI.maker.schedule.rotateWebhookUrl(scheduleId).then(() => undefined),
        'scheduler.webhook.rotateUrlFailed',
      );
  };

  const hint = status ? statusHint(status) : null;
  const local = status?.receiver === 'local';
  const ready = local || (status?.receiver === 'cloud' && Boolean(status.url));
  // 开发版的本机入口只认 GitHub 格式，密钥一律由 Cindy 生成。
  const secretFrom = local ? 'cindy' : scheduleWebhookSecretFrom(source);
  const canGenerate = ready && (secretFrom === 'cindy' || secretFrom === 'either');
  const canPaste = ready && (secretFrom === 'sender' || secretFrom === 'either');
  const hasSecret = Boolean(status?.hasSecret);
  const needsSecret = ready && secretFrom !== null && !hasSecret;
  const expanded = settingsOpen ?? (needsSecret || Boolean(secret));
  useEffect(() => {
    if (ready && status?.problem !== 'released') markSetupSeen(scheduleId);
  }, [ready, scheduleId, status?.problem]);

  const receivedText = status
    ? status.lastReceivedAt
      ? t('scheduler.webhook.lastReceived', {
          time: new Date(status.lastReceivedAt).toLocaleString(),
        })
      : t(
          !hint && status.connected && !needsSecret && schedule.status === 'active'
            ? 'scheduler.webhook.waitingEvent'
            : 'scheduler.webhook.neverReceived',
        )
    : null;
  const summary = hint
    ? t(hint, {
        limit: status?.quotaLimit,
        time: status?.quotaResetAt ? new Date(status.quotaResetAt).toLocaleString() : '',
      })
    : needsSecret
      ? t(
          secretFrom === 'sender'
            ? 'scheduler.webhook.secretPasteMissing'
            : 'scheduler.webhook.secretMissing',
        )
      : receivedText;
  const eventKey = 'scheduler.editor.webhook.eventPicker';
  const eventLabels = new Map(
    webhookEventOptions(source?.preset ?? DEFAULT_SCHEDULE_WEBHOOK_PRESET).flatMap((group) =>
      group.options.map(
        (option) =>
          [
            option.value,
            `${t(`${eventKey}.groups.${group.label}`)} · ${t(`${eventKey}.actions.${option.label}`)}`,
          ] as const,
      ),
    ),
  );

  return (
    <section className="mt-4 border-y border-[var(--border-default)] py-4 text-12 leading-relaxed text-[var(--text-secondary)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-13 font-medium text-[var(--text-primary)]">
            {t('scheduler.cell.tagWebhook')}{' '}
            <span className="font-normal text-[var(--text-secondary)]">· {senderName}</span>
          </h3>
          {summary && <p role="status">{summary}</p>}
          {status && status.ignored > 0 && (
            <p>{t('scheduler.webhook.ignored', { count: status.ignored })}</p>
          )}
        </div>
        <Button
          variant="secondary"
          tone="quiet"
          size="sm"
          compact
          className="shrink-0"
          aria-expanded={expanded}
          aria-controls={settingsId}
          onClick={() => setSettingsOpen(!expanded)}
        >
          {t('scheduler.webhook.manageConnection')}
          <ChevronDown
            size={14}
            aria-hidden
            className={cn('transition-transform', expanded && 'rotate-180')}
          />
        </Button>
      </div>
      {secretFrom === null && ready && (
        <p className="mt-2 text-[var(--text-primary)]">{t('scheduler.webhook.unsignedNotice')}</p>
      )}
      {status?.problem === 'released' && (
        <div className="mt-3">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void (async () => {
                if (
                  !confirmDialog ||
                  !(await confirmDialog.confirm({
                    title: t('scheduler.webhook.account.reconnectConfirm'),
                    description: t('scheduler.webhook.account.reconnectConfirmHint'),
                    confirmText: t('scheduler.webhook.account.reconnect'),
                  }))
                )
                  return;
                await run(
                  () => window.electronAPI.maker.schedule.restoreWebhookEndpoint(scheduleId),
                  'scheduler.webhook.account.reconnectFailed',
                );
              })()
            }
          >
            {t('scheduler.webhook.account.reconnect')}
          </Button>
        </div>
      )}
      <Collapse open={expanded} id={settingsId}>
        <div className="space-y-4 pt-4">
          {ready && status?.problem !== 'released' && (
            <>
              <div className="space-y-2">
                <p className="text-13 font-medium text-[var(--text-primary)]">
                  {t('scheduler.webhook.url')}
                </p>
                {status?.url && (
                  <CopyableValue value={status.url} label={t('scheduler.webhook.url')} />
                )}
                <p>{t('scheduler.webhook.addressHint', { sender: senderName })}</p>
                {!local && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void rotateUrl()}
                  >
                    {t('scheduler.webhook.rotateUrl')}
                  </Button>
                )}
              </div>
              {secretFrom !== null && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-13 font-medium text-[var(--text-primary)]">
                      {t('scheduler.webhook.secret')}
                    </p>
                    {canGenerate && !hasSecret && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void generate()}
                      >
                        {t('scheduler.webhook.generateSecret')}
                      </Button>
                    )}
                    {hasSecret && !secret && (
                      <span className="inline-flex items-center gap-1.5">
                        <Check size={14} aria-hidden />
                        {t('scheduler.webhook.secretSaved')}
                      </span>
                    )}
                  </div>
                  {secret && (
                    <div className="flex flex-col gap-2">
                      <CopyableValue value={secret} label={t('scheduler.webhook.secret')} />
                      <span>
                        {t('scheduler.webhook.secretOnce')}{' '}
                        {t('scheduler.webhook.secretFillHint', {
                          sender: senderName,
                          field: secretField,
                        })}
                      </span>
                    </div>
                  )}
                  {canPaste && (
                    <form
                      className="flex min-w-0 flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (pasted.trim()) void savePasted();
                      }}
                    >
                      <Input
                        type="password"
                        autoComplete="off"
                        value={pasted}
                        onChange={setPasted}
                        placeholder={t('scheduler.webhook.secretPastePlaceholder', {
                          sender: senderName,
                          field: secretField,
                        })}
                        aria-label={t('scheduler.webhook.secretPastePlaceholder', {
                          sender: senderName,
                          field: secretField,
                        })}
                        size="md"
                        className="min-w-0 flex-1"
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        disabled={busy || !pasted.trim()}
                      >
                        {t('scheduler.webhook.secretSave')}
                      </Button>
                    </form>
                  )}
                </div>
              )}
              <div className="space-y-1">
                {!status?.lastReceivedAt && (
                  <p>{t('scheduler.webhook.testHint', { sender: senderName })}</p>
                )}
                {schedule.webhookTrigger?.events?.length ? (
                  <span className="break-words">
                    {t('scheduler.webhook.eventsSummary', {
                      events: schedule.webhookTrigger.events
                        .map((event) => eventLabels.get(event) ?? event)
                        .join(', '),
                    })}
                  </span>
                ) : null}
              </div>
              {canGenerate && hasSecret && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void generate()}
                  >
                    {t('scheduler.webhook.rotateSecret')}
                  </Button>
                </div>
              )}
            </>
          )}
          <div className="border-t border-[var(--border-default)] pt-3">
            <WebhookAccountManager onChanged={() => setRevision((value) => value + 1)} />
          </div>
        </div>
      </Collapse>
    </section>
  );
}
