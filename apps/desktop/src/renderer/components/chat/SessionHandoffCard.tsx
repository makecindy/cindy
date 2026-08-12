import { ArrowUpRight, CornerDownRight, History } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { getSessionRouteOwnerId, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { shortSessionId } from '@/lib/sessionId';
import {
  useSessionNavigationIntent,
  useSessionNavigationMode,
} from '@/features/cc-agent/embeddedSessionNavigation';

export interface SessionHandoffCardProps {
  sessionId: string;
  title: string | null;
  wake: 'resumed' | 'already-active' | 'created';
  lastActive: string | null;
  dispatcherSessionId?: string;
  dispatcherTitle?: string | null;
}

const MS_MINUTE = 60_000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

export function SessionHandoffCard({
  sessionId,
  title,
  wake,
  lastActive,
  dispatcherSessionId,
  dispatcherTitle,
}: SessionHandoffCardProps) {
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const reportSessionNavigation = useSessionNavigationIntent();
  const navigationRequestVersionRef = useRef(0);
  const { t } = useTranslation();
  const displayTitle = title?.trim() || t('ccAgent.handoff.card.unnamedSession');
  // created / resumed 用实心强调样式(新建或被唤醒,值得注意);already-active 用描边弱样式。
  const solidBadge = wake === 'created' || wake === 'resumed';
  const badgeLabel =
    wake === 'created'
      ? t('ccAgent.handoff.card.wake.created')
      : wake === 'resumed'
        ? t('ccAgent.handoff.card.wake.resumed')
        : t('ccAgent.handoff.card.wake.alreadyActive');

  useEffect(
    () => () => {
      navigationRequestVersionRef.current += 1;
    },
    [sessionId, navigationMode],
  );

  const formatLastActive = (value: string): string => {
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) return t('ccAgent.handoff.card.lastActive.recently');
    const delta = Math.max(0, Date.now() - ms);
    if (delta < MS_MINUTE) return t('ccAgent.handoff.card.lastActive.justNow');
    if (delta < MS_HOUR) {
      return t('ccAgent.handoff.card.lastActive.minutes', {
        count: Math.floor(delta / MS_MINUTE),
      });
    }
    if (delta < MS_DAY) {
      return t('ccAgent.handoff.card.lastActive.hours', {
        count: Math.floor(delta / MS_HOUR),
      });
    }
    return t('ccAgent.handoff.card.lastActive.days', {
      count: Math.floor(delta / MS_DAY),
    });
  };

  const handleClick = () => {
    const navigationRequestVersion = ++navigationRequestVersionRef.current;
    void resolveSessionRoute(sessionId).then((target) => {
      if (navigationRequestVersionRef.current !== navigationRequestVersion) return;
      reportSessionNavigation?.(sessionId, getSessionRouteOwnerId(target) ?? sessionId);
      navigate(target, {
        state: dispatcherSessionId
          ? {
              from: {
                kind: 'handoff',
                dispatcherSessionId,
                dispatcherTitle: dispatcherTitle ?? null,
              },
            }
          : undefined,
      });
    });
  };

  const interactive = navigationMode !== 'sidebar-embedded';
  const Root = interactive ? 'button' : 'div';

  return (
    <Root
      data-split-pane-route-action={interactive ? '' : undefined}
      {...(interactive ? { type: 'button' as const, onClick: handleClick } : {})}
      className={cn(
        'my-2 flex w-full min-w-0 items-center gap-[14px] rounded-[12px]',
        'border border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)] p-4 text-left',
        interactive &&
          'group transition-colors duration-150 hover:border-[var(--msg-assistant-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          'bg-[hsl(var(--content-area))] transition-colors duration-150 group-hover:bg-foreground',
        )}
      >
        <CornerDownRight
          size={18}
          strokeWidth={2}
          className="text-foreground transition-colors duration-150 group-hover:text-background"
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-14 font-semibold leading-5 text-[var(--msg-tool-card-text)]">
            {displayTitle}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-[2px] text-10 font-medium uppercase leading-4 tracking-[0.4px]',
              solidBadge
                ? 'bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)]'
                : 'border border-[var(--send-btn-bg)] bg-[var(--cmd-palette-bg)] text-[var(--send-btn-bg)]',
            )}
          >
            {badgeLabel}
          </span>
        </span>

        <span className="flex min-w-0 items-center gap-[6px]">
          {lastActive ? (
            <>
              <History
                size={12}
                strokeWidth={2}
                className="shrink-0 text-[var(--settings-section-desc)]"
              />
              <span className="truncate text-12 leading-4 text-[var(--settings-section-desc)]">
                {formatLastActive(lastActive)}
              </span>
            </>
          ) : (
            <span className="truncate text-12 italic leading-4 text-[var(--cmd-palette-item-meta)]">
              {t('ccAgent.handoff.card.neverActive')}
            </span>
          )}
          <span className="shrink-0 text-12 leading-4 text-[var(--cmd-palette-item-meta)]">·</span>
          <span className="shrink-0 font-mono text-11 leading-4 text-[var(--cmd-palette-item-meta)]">
            {shortSessionId(sessionId)}
          </span>
        </span>
      </span>

      {interactive && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <ArrowUpRight
            size={16}
            strokeWidth={2}
            className="text-[var(--settings-section-desc)] transition-colors duration-150 group-hover:text-foreground"
          />
        </span>
      )}
    </Root>
  );
}
