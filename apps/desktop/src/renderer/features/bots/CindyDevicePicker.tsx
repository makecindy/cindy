import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { cn } from '@/lib/utils';
import { useBotProfiles, useBotUnreadCounts } from './botStore';
import { useRemoteBots } from './useRemoteBots';
import { cindyDeviceKey, cindyDeviceOptions, type CindyDeviceOption } from './cindyDeviceRoster';
import { formatBotUnreadBadge } from './botListDisplay';
import type { BotChatIdentity } from './BotSessionContentHeader';

/** Shared device menu for the single sidebar entry and the chat header. */
export function CindyDevicePicker({
  options,
  current,
  onSelect,
  className,
}: {
  options: readonly CindyDeviceOption[];
  current: CindyDeviceOption;
  onSelect: (option: CindyDeviceOption) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const otherUnread = options.some((option) => option.key !== current.key && option.unread);
  return (
    <Select
      label={t('bots.devicePicker.switchDevice', { device: current.label })}
      value={current.key}
      truncateOptions
      className={cn('h-6 max-w-none px-2 text-11', className)}
      triggerAdornment={otherUnread ? (
        <span
          aria-label={t('bots.devicePicker.otherUnread')}
          className="size-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]"
        />
      ) : null}
      options={options.map((option) => ({
        value: option.key,
        label: option.label,
        title: option.deviceName,
        endAdornment: option.unread || !option.online ? (
          <>
            {!option.online ? <span className="text-11 text-[var(--text-secondary)]">{t('deviceId' in option.bot && option.bot.connectionKnown === false ? 'bots.remote.unknown' : 'bots.remote.offline')}</span> : null}
            {option.unread ? (
              option.unreadCount ? (
                <span
                  aria-label={t('bots.list.unread', { count: option.unreadCount })}
                  className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1 text-10 text-[var(--bot-unread-fg)]"
                >
                  {formatBotUnreadBadge(option.unreadCount)}
                </span>
              ) : (
                <span
                  aria-label={t('bots.devicePicker.unread')}
                  className="size-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]"
                />
              )
            ) : null}
          </>
        ) : undefined,
      }))}
      onValueChange={(key) => {
        const option = options.find((candidate) => candidate.key === key);
        if (option && option.key !== current.key) onSelect(option);
      }}
    />
  );
}

export function CindyHeaderDevicePicker({ bot }: { bot: BotChatIdentity }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const remoteBots = useRemoteBots();
  const devices = useDeviceLinkDeviceList();
  const unread = useBotUnreadCounts();
  const options = cindyDeviceOptions(
    bots,
    remoteBots,
    devices ?? [],
    unread,
    t('bots.devicePicker.local'),
  );
  const current = options.find((option) => option.key === cindyDeviceKey(bot));
  if (!current || options.length < 2)
    return bot.deviceId ? (
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className="truncate text-12 text-[var(--text-tertiary)]">{bot.deviceName}</span>
      </div>
    ) : null;
  return (
    <CindyDevicePicker
      options={options}
      current={current}
      onSelect={(option) => navigate(option.route)}
      className="w-44 max-w-full"
    />
  );
}
