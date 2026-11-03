import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SCHEDULE_WEBHOOK_PRESETS } from '@cindy/maker-scheduler/webhook-formats';
import { parseWebhookFormatText } from '../lib/scheduleFormLogic';

const hintClass = 'text-xs text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]';

interface WebhookSourceFieldsProps {
  preset: string;
  signed: boolean;
  formatText: string;
  onPresetChange(value: string): void;
  onSignedChange(value: boolean): void;
  onFormatChange(value: string): void;
}

/** 发送方、是否验证签名，以及自定义格式。密钥和接收地址在任务详情里管理。 */
export function WebhookSourceFields({
  preset,
  signed,
  formatText,
  onPresetChange,
  onSignedChange,
  onFormatChange,
}: WebhookSourceFieldsProps) {
  const { t } = useTranslation();
  const known = preset === 'custom' || SCHEDULE_WEBHOOK_PRESETS.some((item) => item.id === preset);
  const options = [
    ...SCHEDULE_WEBHOOK_PRESETS.map((item) => ({ value: item.id, label: item.label })),
    { value: 'custom', label: t('scheduler.editor.webhook.sourceCustom') },
    // 更新的版本写入的发送方：照原样显示，不改就不会被覆盖。
    ...(known ? [] : [{ value: preset, label: preset }]),
  ];
  const formatInvalid = preset === 'custom' && formatText.trim() !== '' && !parseWebhookFormatText(formatText);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <span aria-hidden className="text-13 leading-none text-[var(--settings-btn-secondary-text)]">
          {t('scheduler.editor.webhook.sourceLabel')}
        </span>
        <Select
          label={t('scheduler.editor.webhook.sourceLabel')}
          className="w-full"
          value={preset}
          options={options}
          onValueChange={onPresetChange}
        />
      </div>
      {preset === 'custom' ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={formatText}
            onChange={(event) => onFormatChange(event.target.value)}
            aria-label={t('scheduler.editor.webhook.customLabel')}
            aria-invalid={formatInvalid}
            rows={8}
            spellCheck={false}
            className={cn(
              'w-full resize-y rounded-xl border bg-transparent px-3 py-2 font-mono text-xs leading-[1.5] outline-none',
              'border-[var(--settings-input-border)] text-[var(--settings-input-text)]',
            )}
          />
          <span className={hintClass}>
            {formatInvalid ? t('scheduler.editor.webhook.customInvalid') : t('scheduler.editor.webhook.customHint')}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-13 leading-none text-[var(--settings-btn-secondary-text)]">
                {t('scheduler.editor.webhook.signedLabel')}
              </span>
              <span className={hintClass}>{t('scheduler.editor.webhook.signedHint')}</span>
            </div>
            <Switch aria-label={t('scheduler.editor.webhook.signedLabel')} checked={signed} onCheckedChange={onSignedChange} />
          </div>
          {!signed && (
            <span className="text-xs font-medium text-[var(--msg-assistant-text)]">
              {t('scheduler.editor.webhook.unsignedWarning')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
