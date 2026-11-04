import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SCHEDULE_WEBHOOK_PRESETS } from '@cindy/maker-scheduler/webhook-formats';
import { parseWebhookFormatText } from '../lib/scheduleFormLogic';
import { WebhookEventSelect } from './WebhookEventSelect';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';

interface WebhookSourceFieldsProps {
  preset: string;
  signed: boolean;
  formatText: string;
  events: string;
  onEventsChange(value: string): void;
  footerAction?: ReactNode;
  onPresetChange(value: string): void;
  onSignedChange(value: boolean): void;
  onFormatChange(value: string): void;
}

/** 发送方、是否验证签名，以及自定义格式。密钥和接收地址在任务详情里管理。 */
export function WebhookSourceFields({
  preset,
  signed,
  formatText,
  events,
  onEventsChange,
  footerAction,
  onPresetChange,
  onSignedChange,
  onFormatChange,
}: WebhookSourceFieldsProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(!signed);
  const known = preset === 'custom' || SCHEDULE_WEBHOOK_PRESETS.some((item) => item.id === preset);
  const options = [
    ...SCHEDULE_WEBHOOK_PRESETS.map((item) => ({ value: item.id, label: item.label })),
    { value: 'custom', label: t('scheduler.editor.webhook.sourceCustom') },
    // 更新的版本写入的发送方：照原样显示，不改就不会被覆盖。
    ...(known ? [] : [{ value: preset, label: preset }]),
  ];
  const formatInvalid =
    preset === 'custom' && formatText.trim() !== '' && !parseWebhookFormatText(formatText);

  return (
    <div className="flex min-w-0 flex-col gap-4 border-t border-[var(--border-default)] pt-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <FormField label={t('scheduler.editor.webhook.sourceLabel')}>
          {(control) => (
            <Select
              {...control}
              label={t('scheduler.editor.webhook.sourceLabel')}
              className="w-full"
              value={preset}
              options={options}
              onValueChange={onPresetChange}
            />
          )}
        </FormField>
        <WebhookEventSelect key={preset} preset={preset} value={events} onChange={onEventsChange} />
      </div>
      {preset === 'custom' ? (
        <FormField
          label={t('scheduler.editor.webhook.customLabel')}
          hint={t('scheduler.editor.webhook.customHint')}
          error={formatInvalid ? t('scheduler.editor.webhook.customInvalid') : undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              value={formatText}
              onChange={onFormatChange}
              rows={6}
              spellCheck={false}
              className="resize-y font-mono text-12 leading-relaxed"
            />
          )}
        </FormField>
      ) : null}
      {preset !== 'custom' && !signed && (
        <p className="text-12 leading-relaxed text-[var(--text-primary)]">
          {t('scheduler.editor.webhook.unsignedWarning')}
        </p>
      )}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            tone="quiet"
            compact
            size="sm"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            {t('routines.advancedSettings')}
            <ChevronDown
              size={14}
              aria-hidden
              className={cn('transition-transform', advancedOpen && 'rotate-180')}
            />
          </Button>
          {footerAction}
        </div>
        <Collapse open={advancedOpen}>
          <div className="flex flex-col gap-4 pt-4">
            {preset !== 'custom' && (
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-13 font-medium text-[var(--text-primary)]">
                    {t('scheduler.editor.webhook.signedLabel')}
                  </span>
                  <span className={hintClass}>{t('scheduler.editor.webhook.signedHint')}</span>
                </div>
                <Switch
                  aria-label={t('scheduler.editor.webhook.signedLabel')}
                  checked={signed}
                  onCheckedChange={onSignedChange}
                />
              </div>
            )}
            <p className={hintClass}>{t('scheduler.editor.webhook.quotaHint')}</p>
          </div>
        </Collapse>
      </div>
    </div>
  );
}
