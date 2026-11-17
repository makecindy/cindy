/**
 * ComposerFollowUpHint — 任务运行中、输入框有内容时的一行轻提示：
 * 说明当前默认是排队还是插话，并可一键切换默认。
 * ---------------------------------------------------------------------------
 * 浮在输入框上方，与附件拒绝条、语音状态条同一浮层位，沿用它们的胶囊外观与语义 token。
 * 关闭状态由调用方通过 useComposerFollowUpHintDismissed 本机记忆，与偏好本身无关。
 */
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import type { ComposerFollowUpBehavior } from '@/hooks/useComposerFollowUpPreference';
import { cn } from '@/lib/utils';

export function ComposerFollowUpHint({
  behavior,
  onSwitch,
  onDismiss,
}: {
  /** 当前默认的运行中发送方式。 */
  behavior: ComposerFollowUpBehavior;
  /** 把默认改成另一种。 */
  onSwitch: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-composer-follow-up-hint
      className={cn(
        'pointer-events-auto flex max-w-[640px] flex-wrap items-center gap-x-2 gap-y-1.5',
        'rounded-2xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        'py-2 pl-4 pr-2 text-13 leading-snug text-[var(--cmd-palette-item-text)]',
        'shadow-[shadow:var(--shadow-menu)]',
      )}
    >
      <span className="min-w-0 flex-1 basis-[220px] break-words">
        {t(`newChat.followUpHint.${behavior}Default`)}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          compact
          onClick={onSwitch}
          className="shrink-0"
        >
          {t(behavior === 'queue' ? 'newChat.followUpHint.switchToSteer' : 'newChat.followUpHint.switchToQueue')}
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('newChat.followUpHint.dismiss')}
          className="shrink-0 rounded-full p-1 opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <X aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
