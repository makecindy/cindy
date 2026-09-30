import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, FolderOpen, Mail, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { BotWorkbench as BotWorkbenchData, BotWorkbenchCard, BotWorkbenchRow } from '../../../shared/botWorkbench';

/**
 * 伙伴工作台:伙伴经 `update_workbench` 写入的卡片,常驻在伙伴对话右侧。
 * 卡片内容全部来自伙伴;这里只负责统一的版式、引导与「按钮 = 替主人发一句话」。
 */
export function BotWorkbench({
  botId,
  botName,
  sessionId,
}: {
  botId: string;
  botName: string;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const [workbench, setWorkbench] = useState<BotWorkbenchData | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.localDb?.bots?.workbench;
    if (!api) return;
    const load = () => {
      void api
        .get(botId)
        .then((next) => {
          if (!cancelled) setWorkbench(next);
        })
        .catch(() => {});
    };
    load();
    const off = window.electronAPI?.maker?.onBotWorkbenchChanged?.((payload) => {
      if (payload.botId === botId) load();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [botId]);

  const sendToBot = useCallback(
    async (text: string) => {
      if (sending) return;
      setSending(true);
      try {
        // 发送链路较重(含 i18n 初始化),点按钮时再加载,不拖慢伙伴页首屏。
        const [{ makerChatStore }, row] = await Promise.all([
          import('@/lib/makerChatStore'),
          sessionService.get(sessionId),
        ]);
        const sent = row.workingDir
          ? await makerChatStore.sendMessage(
              sessionId,
              text,
              row.model,
              row.effort,
              row.permissionMode,
              row.workingDir,
            )
          : false;
        if (!sent) toast.error(t('bots.workbench.sendFailed', { name: botName }));
      } catch {
        toast.error(t('bots.workbench.sendFailed', { name: botName }));
      } finally {
        setSending(false);
      }
    },
    [botName, sending, sessionId, t],
  );

  const giveDirectory = useCallback(async () => {
    const result = await window.electronAPI.dialog?.showOpenDirectory();
    const picked = result?.success ? result.path : null;
    if (picked) void sendToBot(t('bots.workbench.dirPrompt', { path: picked }));
  }, [sendToBot, t]);

  const cards = workbench?.cards ?? [];
  const sources = [
    { key: 'dir', icon: FolderOpen, onClick: giveDirectory },
    { key: 'mail', icon: Mail, onClick: () => void sendToBot(t('bots.workbench.mailPrompt')) },
    { key: 'calendar', icon: CalendarDays, onClick: () => void sendToBot(t('bots.workbench.calendarPrompt')) },
  ] as const;

  return (
    <aside
      aria-label={t('bots.workbench.title')}
      className="hidden w-[340px] shrink-0 flex-col gap-3 overflow-y-auto py-4 pl-1 pr-4 min-[1180px]:flex"
    >
      {cards.map((card, index) => (
        <WorkbenchCard key={`${card.title}-${index}`} card={card} disabled={sending} onAction={sendToBot} />
      ))}

      <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 pb-2 pt-4">
        <h3 className="text-14 font-medium leading-5 text-[var(--text-primary)]">
          {t(cards.length ? 'bots.workbench.moreTitle' : 'bots.workbench.guideTitle', { name: botName })}
        </h3>
        {cards.length === 0 ? (
          <p className="mt-1.5 text-13 leading-5 text-[var(--text-secondary)]">{t('bots.workbench.guideBody')}</p>
        ) : null}
        <div className="mt-2 flex flex-col">
          {sources.map(({ key, icon: Icon, onClick }) => (
            <button
              key={key}
              type="button"
              disabled={sending}
              onClick={onClick}
              className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-tertiary)]">
                <Icon size={15} strokeWidth={1.8} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-13 leading-5 text-[var(--text-primary)]">{t(`bots.workbench.${key}`)}</span>
                <span className="truncate text-12 leading-4 text-[var(--text-secondary)]">{t(`bots.workbench.${key}Hint`)}</span>
              </span>
              <Plus size={15} className="shrink-0 text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]" />
            </button>
          ))}
        </div>
      </section>

      {workbench && cards.length > 0 ? (
        <p className="px-1 text-11 text-[var(--text-secondary)]">
          {t('bots.workbench.updated', {
            time: new Date(workbench.updatedAt).toLocaleString(undefined, {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </p>
      ) : null}
    </aside>
  );
}

function WorkbenchCard({
  card,
  disabled,
  onAction,
}: {
  card: BotWorkbenchCard;
  disabled: boolean;
  onAction: (message: string) => void;
}) {
  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 pb-2 pt-4">
      <header className="flex items-baseline gap-3">
        <h3 className="min-w-0 flex-1 truncate text-14 font-medium leading-5 text-[var(--text-primary)]">{card.title}</h3>
        {card.source ? (
          <span className="max-w-[45%] shrink-0 truncate text-12 text-[var(--text-secondary)]">{card.source}</span>
        ) : null}
      </header>
      <div className="mt-2 flex flex-col">
        {card.rows.map((row, index) => (
          <WorkbenchRowView key={`${row.title}-${index}`} row={row} disabled={disabled} onAction={onAction} />
        ))}
      </div>
    </section>
  );
}

function WorkbenchRowView({
  row,
  disabled,
  onAction,
}: {
  row: BotWorkbenchRow;
  disabled: boolean;
  onAction: (message: string) => void;
}) {
  return (
    <div className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2">
      <span
        aria-hidden="true"
        className={cn(
          'mt-[7px] size-1.5 shrink-0 self-start rounded-full',
          row.flag ? 'bg-[var(--warning-accent)]' : 'bg-[var(--border-default)]',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 leading-5 text-[var(--text-primary)]" title={row.title}>
          {row.title}
        </span>
        {row.detail ? (
          <span className="truncate text-12 leading-4 text-[var(--text-secondary)]" title={row.detail}>
            {row.detail}
          </span>
        ) : null}
      </div>
      {row.action ? (
        <Button
          variant="secondary"
          size="sm"
          compact
          type="button"
          disabled={disabled}
          className="shrink-0 px-3 text-12"
          onClick={() => onAction(row.action!.message)}
        >
          {row.action.label}
        </Button>
      ) : row.status ? (
        <span className="shrink-0 text-12 text-[var(--text-secondary)]">{row.status}</span>
      ) : null}
    </div>
  );
}
