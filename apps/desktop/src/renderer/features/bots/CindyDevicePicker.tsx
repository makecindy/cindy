import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { CindyDeviceOption } from './cindyDeviceRoster';
import { isBotKnownOffline } from './BotConnectionStatus';

/** Device menu for the single sidebar Cindy entry (the chat header lists computers in 近况). */
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
      className={cn('h-6 w-fit max-w-full px-2 text-11', className)}
      contentClassName="w-64 max-w-[var(--radix-select-content-available-width)]"
      triggerAdornment={
        otherUnread ? (
          <span
            aria-label={t('bots.devicePicker.otherUnread')}
            className="size-1.5 shrink-0 rounded-full bg-[var(--card-status-done)]"
          />
        ) : null
      }
      options={options.map((option) => {
        const offline = isBotKnownOffline(
          option.online,
          'deviceId' in option.bot ? option.bot.connectionKnown : undefined,
        );
        return {
          value: option.key,
          label: option.label,
          title: option.deviceName,
          endAdornment:
            option.unread || offline ? (
              <>
                {offline ? (
                  <span className="text-11 text-[var(--text-secondary)]">
                    {t('bots.remote.offline')}
                  </span>
                ) : null}
                {option.unread ? (
                  <span
                    aria-label={t('bots.devicePicker.unread')}
                    className="size-1.5 shrink-0 rounded-full bg-[var(--card-status-done)]"
                  />
                ) : null}
              </>
            ) : undefined,
        };
      })}
      onValueChange={(key) => {
        const option = options.find((candidate) => candidate.key === key);
        if (option && option.key !== current.key) onSelect(option);
      }}
    />
  );
}
