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
import { PluginEventSourceFields } from './PluginEventSourceFields';
import type { SchedulePluginEventSource } from '@cindy/maker-scheduler/plugin-events';
import type { GhostEventSourceCandidate } from '../../../../shared/ghost';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';

/** GitHub / GitLab are one sender each; scope and connection are chosen below the sender. */
type Family = 'github' | 'gitlab';
const FAMILY_PRESETS: Record<Family, { item: string; connections: readonly [string, string] }> = {
  github: { item: 'github-item', connections: ['github-app', 'github'] },
  gitlab: { item: 'gitlab-item', connections: ['gitlab', 'gitlab-token'] },
};
const familyOf = (preset: string): Family | null =>
  (Object.keys(FAMILY_PRESETS) as Family[]).find((family) =>
    FAMILY_PRESETS[family].item === preset || FAMILY_PRESETS[family].connections.includes(preset)) ?? null;
const CONNECTION_LABELS: Record<string, string> = {
  'github-app': 'cindy', github: 'manual', gitlab: 'gitlabSigned', 'gitlab-token': 'gitlabToken',
};

interface WebhookSourceFieldsProps {
  preset: string;
  signed: boolean;
  formatText: string;
  events: string;
  repositories?: string;
  onRepositoriesChange?(value: string): void;
  onEventsChange(value: string): void;
  footerAction?: ReactNode;
  /** Sender or scope change; github-item / gitlab-item select the specific-item scope. */
  onPresetChange(value: string): void;
  /** Connection change inside a family (keeps the scope and any specific item). Defaults to onPresetChange. */
  onConnectionChange?(value: string): void;
  onSignedChange(value: boolean): void;
  onFormatChange(value: string): void;
  /** 插件事件来源（preset=plugin）。 */
  pluginSources?: readonly SchedulePluginEventSource[];
  pluginCandidates?: readonly GhostEventSourceCandidate[] | null;
  onPluginSourcesChange?(value: SchedulePluginEventSource[]): void;
  /** 这台电脑能接收 Webhook 地址（已登录且有接收服务）；否则只能选插件事件或指定 PR / MR。 */
  addressSourcesAvailable?: boolean;
  /** GitHub / GitLab 当前是「指定 PR / MR / Issue」范围。 */
  itemScope?: boolean;
  /** 指定范围下显示的输入框与条件。 */
  itemFields?: ReactNode;
  /** 指定的是需要接收地址的对象（GitLab Issue），在指定范围下也要选接法。 */
  itemNeedsConnection?: boolean;
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
  onConnectionChange = onPresetChange,
  onSignedChange,
  onFormatChange,
  pluginSources = [],
  pluginCandidates = null,
  onPluginSourcesChange,
  addressSourcesAvailable = true,
  itemScope = false,
  itemFields,
  itemNeedsConnection = false,
}: WebhookSourceFieldsProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(!signed);
  const connectionId = useId();
  const scopeId = useId();
  const family = familyOf(preset);
  const pluginSource = preset === 'plugin';
  const repositoryScope = !!family && !itemScope;
  // Address-based settings (events, signing) apply to a whole repository/project or a GitLab issue.
  const connectionVisible = !!family && (repositoryScope || itemNeedsConnection);
  const addressPreset = family && FAMILY_PRESETS[family].connections.includes(preset) ? preset : null;
  const appSource = repositoryScope && preset === 'github-app';
  // Remembers each family's repository connection so switching scope back keeps the user's choice.
  const [lastConnection, setLastConnection] = useState<Record<Family, string>>({
    github: preset === 'github' ? 'github' : 'github-app',
    gitlab: preset === 'gitlab-token' ? 'gitlab-token' : 'gitlab',
  });
  const known = !!family || pluginSource || preset === 'custom' || SCHEDULE_WEBHOOK_PRESETS.some((item) => item.id === preset);
  const pluginOption = pluginSource || (pluginCandidates?.length ?? 0) > 0
    ? [{ value: 'plugin', label: t('scheduler.editor.webhook.plugin.source') }] : [];
  const familyOption = (value: Family) => ({ value, label: value === 'github' ? 'GitHub' : 'GitLab' });
  const options = addressSourcesAvailable ? [
    ...SCHEDULE_WEBHOOK_PRESETS.filter((item) => item.id !== 'gitlab-token')
      .map((item) => (item.id === 'github' || item.id === 'gitlab' ? familyOption(item.id) : { value: item.id, label: item.label })),
    { value: 'custom', label: t('scheduler.editor.webhook.sourceCustom') },
    ...pluginOption,
    // 更新的版本写入的发送方：照原样显示，不改就不会被覆盖。
    ...(known ? [] : [{ value: preset, label: preset }]),
  ] : [...pluginOption, familyOption('github'), familyOption('gitlab')];
  const chooseConnection = (value: string) => {
    if (family) setLastConnection((current) => ({ ...current, [family]: value }));
    onConnectionChange(value);
  };
  const chooseFamily = (value: Family) => {
    if (family === value) return;
    // A single PR / MR needs no account; whole-repository events need a receiver on this computer.
    onPresetChange(addressSourcesAvailable ? lastConnection[value] : FAMILY_PRESETS[value].item);
  };
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
              value={family ?? preset}
              options={options}
              onValueChange={(value) => (value === 'github' || value === 'gitlab' ? chooseFamily(value) : onPresetChange(value))}
            />
          )}
        </FormField>
      </div>
      {family && (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 text-13 font-medium text-[var(--text-primary)]">{t('scheduler.editor.webhook.scopeLabel')}</legend>
          {(['repository', 'item'] as const).map((scope) => {
            const checked = scope === 'item' ? itemScope : repositoryScope;
            const disabled = scope === 'repository' && !addressSourcesAvailable && !repositoryScope;
            const key = family === 'gitlab' ? (scope === 'item' ? 'gitlabItem' : 'project') : scope;
            const label = t(`scheduler.editor.webhook.scope.${key}`);
            const hint = disabled ? t('scheduler.editor.webhook.scope.repositoryNeedsAccount') : t(`scheduler.editor.webhook.scope.${key}Hint`);
            return <label key={scope} className={cn('flex min-w-0 items-start gap-2 py-1 text-13 text-[var(--text-primary)]',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
              <input type="radio" name={scopeId} checked={checked} disabled={disabled} aria-label={label}
                aria-describedby={`${scopeId}-${scope}`} className="mt-1 shrink-0 accent-[var(--text-primary)]"
                onChange={() => onPresetChange(scope === 'item' ? FAMILY_PRESETS[family].item : lastConnection[family])} />
              <span className="min-w-0">
                <span>{label}</span>
                <span id={`${scopeId}-${scope}`} className={`mt-1 block ${hintClass}`}>{hint}</span>
              </span>
            </label>;
          })}
        </fieldset>
      )}
      {itemScope && itemFields}
      {connectionVisible && (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 text-13 font-medium text-[var(--text-primary)]">{t('scheduler.editor.webhook.connectionLabel')}</legend>
          {FAMILY_PRESETS[family!].connections.map((value) => {
            const mode = CONNECTION_LABELS[value];
            return <label key={value} className="flex min-w-0 cursor-pointer items-start gap-2 py-1 text-13 text-[var(--text-primary)]">
              <input type="radio" name={connectionId} checked={addressPreset === value}
                aria-label={t(`scheduler.editor.webhook.${mode}Connection`)} aria-describedby={`${connectionId}-${mode}`} className="mt-1 shrink-0 accent-[var(--text-primary)]"
                onChange={() => chooseConnection(value)} />
              <span className="min-w-0">
                <span>{t(`scheduler.editor.webhook.${mode}Connection`)}</span>
                <span id={`${connectionId}-${mode}`} className={`mt-1 block ${hintClass}`}>{t(`scheduler.editor.webhook.${mode}ConnectionHint`)}</span>
              </span>
            </label>;
          })}
        </fieldset>
      )}
      {pluginSource && (
        <PluginEventSourceFields value={pluginSources} candidates={pluginCandidates}
          onChange={(value) => onPluginSourcesChange?.(value)} />
      )}
      {pluginSource && footerAction}
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
      {!pluginSource && !itemScope && <WebhookEventSelect key={preset} preset={preset} value={events} onChange={onEventsChange} />}
      {repositoryScope && preset === 'github' && <p className={hintClass}>{t('scheduler.editor.webhook.manualSetupHint')}</p>}
      {connectionVisible && family === 'gitlab' && <p className={hintClass}>{t('scheduler.editor.webhook.gitlabSetupHint')}</p>}
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
      {!appSource && !pluginSource && (!itemScope || itemNeedsConnection) && preset !== 'custom' && !signed && (
        <p className="text-12 leading-relaxed text-[var(--text-primary)]">
          {t('scheduler.editor.webhook.unsignedWarning')}
        </p>
      )}
      {!appSource && !pluginSource && (!itemScope || itemNeedsConnection) && <div>
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
