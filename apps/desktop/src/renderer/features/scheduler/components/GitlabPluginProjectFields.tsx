/**
 * GitlabPluginProjectFields — GitLab「整个项目」且「通过 GitLab 插件」：项目输入框加事件勾选。
 * 保存为 GitLab 插件的事件来源（project 条件），插件只轮询这个项目。不勾事件表示全部。
 * 规则见 docs/product-rules/schedule-webhook-trigger.md。颜色只用语义 token，Light / Dark 自动适配。
 */
import { useTranslation } from 'react-i18next';

import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { parseGitlabProjectReference } from '@cindy/maker-scheduler/github-item';
import type { GhostEventSourceCandidate } from '../../../../shared/ghost';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';

export function GitlabPluginProjectFields({
  project,
  events,
  candidate,
  onProjectChange,
  onEventsChange,
}: {
  project: string;
  events: readonly string[];
  /** 已安装的 GitLab 插件；为空表示插件不可用（已卸载或停用）。 */
  candidate: GhostEventSourceCandidate | null;
  onProjectChange(value: string): void;
  onEventsChange(value: string[]): void;
}) {
  const { t } = useTranslation();
  const parsed = parseGitlabProjectReference(project);
  const invalid = project.trim() !== '' && !parsed;
  const toggle = (type: string, checked: boolean) => {
    const next = checked ? [...new Set([...events, type])] : events.filter((item) => item !== type);
    onEventsChange(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <FormField
        label={t('scheduler.editor.webhook.gitlabPlugin.projectLabel')}
        hint={t('scheduler.editor.webhook.gitlabPlugin.projectHint')}
        error={invalid ? t('scheduler.editor.webhook.gitlabPlugin.projectInvalid') : undefined}
      >
        {(control) => (
          <Input {...control} value={project} onChange={onProjectChange}
            placeholder="group/project" spellCheck={false} />
        )}
      </FormField>
      {candidate ? (
        <fieldset className="flex min-w-0 flex-col">
          <legend className="mb-2 text-13 font-medium text-[var(--text-primary)]">
            {t('scheduler.editor.webhook.gitlabPlugin.eventsLabel')}
          </legend>
          {candidate.events.map((event) => (
            <label key={event.type}
              className="flex min-h-8 min-w-0 cursor-pointer items-center gap-2 text-13 text-[var(--text-primary)]">
              <Checkbox checked={events.includes(event.type)}
                onChange={(change) => toggle(event.type, change.target.checked)} />
              <span className="min-w-0 truncate">{event.name}</span>
            </label>
          ))}
          <p className={`mt-1 ${hintClass}`}>{t('scheduler.editor.webhook.gitlabPlugin.eventsHint')}</p>
        </fieldset>
      ) : (
        <p className={hintClass}>{t('scheduler.editor.webhook.gitlabPlugin.unavailable')}</p>
      )}
    </div>
  );
}
