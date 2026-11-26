/**
 * AutoRouteInfoButton —— 「线路选择」旁边的轻量 (i) 按钮，点开展示自动选路规则。
 * 设备连接拓扑（DeviceNodePopover）与远程供应商拓扑（RemoteProviderTopology）共用一份。
 */

import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function AutoRouteInfoButton() {
  const { t } = useTranslation();
  const title = t('settings.remoteControl.v2.popover.autoRule.title');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] data-[state=open]:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          aria-label={title}
          title={title}
          onClick={(e) => e.stopPropagation()}
        >
          <Info size={12} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-3 text-12 leading-[1.5]">
        <div className="mb-1.5 font-medium text-[var(--text-primary)]">{title}</div>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-12 text-[var(--text-secondary)]">
          <li>{t('settings.remoteControl.v2.popover.autoRule.faster')}</li>
          <li>{t('settings.remoteControl.v2.popover.autoRule.thresholds')}</li>
          <li>{t('settings.remoteControl.v2.popover.autoRule.cooldown')}</li>
          <li>{t('settings.remoteControl.v2.popover.autoRule.peerOverride')}</li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
