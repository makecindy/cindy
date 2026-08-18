import { MessageCircleMore } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import {
  applyImMutualExclusion,
  botChannelDisplayName,
  buildBotChannelChips,
} from './botChannelChips';
import type { BotChannelConnection } from './botStore';

const BUILTIN_ABILITY_KEYS = ['writing', 'research', 'doing', 'schedule', 'collab'] as const;

/**
 * "TA 会的" —— 自带能力墙(纯陈述,无开关;permissions/automation 恒随模板默认,
 * 个体收紧挪到高级)+ 可以连上的通道列表(复用 toggleChannel/mountedChannelFor,
 * 单 IM 互斥用 applyImMutualExclusion 处理)。
 */
export function BotAbilityWall({
  connections,
  isChannelMounted,
  channelBusyId,
  onToggleChannel,
}: {
  connections: readonly BotChannelConnection[];
  isChannelMounted: (connection: BotChannelConnection) => boolean;
  channelBusyId: string | null;
  onToggleChannel: (connection: BotChannelConnection) => void;
}) {
  const { t } = useTranslation();
  const chips = applyImMutualExclusion(buildBotChannelChips(connections, isChannelMounted));

  return (
    <div>
      <p className="text-11 font-medium uppercase tracking-[0.1em] text-[var(--text-tertiary)]">
        {t('bots.abilityWall.builtinTitle')}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {BUILTIN_ABILITY_KEYS.map((key) => (
          <span
            key={key}
            className="rounded-full bg-[var(--surface-chip)] px-3 py-1.5 text-12 text-[var(--text-secondary)]"
          >
            {t(`bots.abilityWall.abilities.${key}`)}
          </span>
        ))}
      </div>

      <p className="mt-4 text-11 font-medium uppercase tracking-[0.1em] text-[var(--text-tertiary)]">
        {t('bots.abilityWall.connectableTitle')}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {chips.map((chip) => {
          const channelName = botChannelDisplayName(chip.kind);
          const label = chip.accountLabel ? `${channelName} · ${chip.accountLabel}` : channelName;
          const blocked = Boolean(chip.blockedByImKind);
          return (
            <div
              key={chip.id}
              className={cn(
                'flex items-start justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-2',
                (chip.disabled || blocked) && 'opacity-60',
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 truncate text-12 text-[var(--text-primary)]">
                  <MessageCircleMore size={13} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
                  {label}
                </span>
                {blocked && chip.blockedByImKind ? (
                  <span className="mt-0.5 block text-10 leading-4 text-[var(--text-tertiary)]">
                    {t('bots.abilityWall.imBlocked', {
                      channel: botChannelDisplayName(chip.blockedByImKind),
                    })}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                disabled={chip.disabled || blocked || !chip.connection || channelBusyId !== null}
                onClick={() => {
                  if (chip.connection) onToggleChannel(chip.connection);
                }}
                className="h-7 shrink-0 rounded-full border border-[var(--border-default)] px-2.5 text-10 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-70"
              >
                {chip.connection && channelBusyId === chip.connection.id
                  ? '…'
                  : chip.mounted
                    ? t('bots.channelMounted')
                    : t('bots.channelMount')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
