import { useId, useState, type ReactNode } from 'react';
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
import { parseWebhookFormatText, validGithubRepositories } from '../lib/scheduleFormLogic';
import { GithubAppCard } from '@/features/cc-agent/GithubAppCard';
import { WebhookEventSelect } from './WebhookEventSelect';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';

interface WebhookSourceFieldsProps {
  preset: string;
  signed: boolean;
  formatText: string;
  events: string;
  repositories?: string;
  onRepositoriesChange?(value: string): void;
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
  repositories = '',
  onRepositoriesChange,
  onEventsChange,
  footerAction,
  onPresetChange,
  onSignedChange,
  onFormatChange,
}: WebhookSourceFieldsProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(!signed);
  const connectionId = useId();
  const appSource = preset === 'github-app';
  const githubSource = appSource || preset === 'github';
  const known = appSource || preset === 'custom' || SCHEDULE_WEBHOOK_PRESETS.some((item) => item.id === preset);
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
      <div>
        <FormField label={t('scheduler.editor.webhook.sourceLabel')}>
          {(control) => (
            <Select
              {...control}
              label={t('scheduler.editor.webhook.sourceLabel')}
              className="w-full"
              value={appSource ? 'github' : preset}
              options={options}
              onValueChange={(value) => onPresetChange(value === 'github' ? (githubSource ? preset : 'github-app') : value)}
            />
          )}
        </FormField>
      </div>
      {githubSource && (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 text-13 font-medium text-[var(--text-primary)]">{t('scheduler.editor.webhook.connectionLabel')}</legend>
          {(['github-app', 'github'] as const).map((value) => {
            const mode = value === 'github-app' ? 'cindy' : 'manual';
            return <label key={value} className="flex min-w-0 cursor-pointer items-start gap-2 py-1 text-13 text-[var(--text-primary)]">
              <input type="radio" name={connectionId} checked={preset === value}
                aria-label={t(`scheduler.editor.webhook.${mode}Connection`)} aria-describedby={`${connectionId}-${mode}`} className="mt-1 shrink-0 accent-[var(--text-primary)]"
                onChange={() => onPresetChange(value)} />
              <span className="min-w-0">
                <span>{t(`scheduler.editor.webhook.${mode}Connection`)}</span>
                <span id={`${connectionId}-${mode}`} className={`mt-1 block ${hintClass}`}>{t(`scheduler.editor.webhook.${mode}ConnectionHint`)}</span>
              </span>
            </label>;
          })}
        </fieldset>
      )}
      {appSource && <GithubAppCard automation repositories={repositories.split(/[\s,]+/).filter(Boolean)} />}
      {appSource && (
        <>
          <FormField
            label={t('scheduler.editor.webhook.repositoriesLabel')}
            hint={t('scheduler.editor.webhook.repositoriesHint')}
            error={repositories.trim() && !validGithubRepositories(repositories)
              ? t('scheduler.editor.webhook.repositoriesInvalid') : undefined}
          >
            {(control) => <Textarea {...control} value={repositories} onChange={value => onRepositoriesChange?.(value)}
              rows={3} spellCheck={false} placeholder="makecindy/cindy" />}
          </FormField>
          {footerAction}
        </>
      )}
      <WebhookEventSelect key={preset} preset={preset} value={events} onChange={onEventsChange} />
      {preset === 'github' && <p className={hintClass}>{t('scheduler.editor.webhook.manualSetupHint')}</p>}
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
      {!appSource && preset !== 'custom' && !signed && (
        <p className="text-12 leading-relaxed text-[var(--text-primary)]">
          {t('scheduler.editor.webhook.unsignedWarning')}
        </p>
      )}
      {!appSource && <div>
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
      </div>}
    </div>
  );
}
