/**
 * Visibility audience editor: all members, or specific departments / members / emails.
 * Shared by the publish confirmation screen and the team plugin detail (#1541).
 */
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AuthorDepartment, PluginAuthorRendererApi } from '../../../../shared/pluginAuthor';
import type { PublisherAudienceUnresolved } from '../../../../shared/pluginPublisher';
import { audienceOf, audienceOverLimit, draftItemCount, type AudienceDraft } from './audienceDraft';
import { AudienceSelectionSummary } from './AudienceSelectionSummary';
import { PluginAudiencePicker } from './PluginAudiencePicker';

const copy = 'settings.ghosts.audience';

export function AudienceEditor({
  draft,
  onChange,
  unresolved = [],
  api,
  disabled = false,
  hideLegend = false,
}: {
  draft: AudienceDraft;
  onChange: (draft: AudienceDraft) => void;
  /** Names from the conversation that could not be matched to one department or member. */
  unresolved?: readonly PublisherAudienceUnresolved[];
  api: Pick<PluginAuthorRendererApi, 'departments' | 'departmentMembers' | 'searchColleagues'>;
  disabled?: boolean;
  /** The surrounding dialog already names the field (修改可见范围): keep the legend for screen readers only. */
  hideLegend?: boolean;
}) {
  const { t } = useTranslation();
  const radioName = useId();
  // Choosing 指定部门和成员 with nothing selected opens the picker at once; cancelling that first
  // pick with still nothing selected goes back to 全部成员 instead of leaving an empty choice.
  const [picker, setPicker] = useState<{ revertToAll: boolean } | null>(null);
  const pickerOpen = picker !== null;
  const [departments, setDepartments] = useState<AuthorDepartment[] | null>(null);
  const [departmentsFailed, setDepartmentsFailed] = useState(false);
  const [departmentsRequested, setDepartmentsRequested] = useState(false);

  // Department names are only needed once something department-related is on screen.
  const needsDepartments = pickerOpen || draft.departmentIds.length > 0;
  const loadDepartments = useCallback(() => {
    setDepartmentsFailed(false);
    setDepartmentsRequested(true);
    api.departments().then(setDepartments, () => setDepartmentsFailed(true));
  }, [api]);
  useEffect(() => {
    if (needsDepartments && !departmentsRequested) loadDepartments();
  }, [needsDepartments, departmentsRequested, loadDepartments]);

  const complete = audienceOf(draft) !== null;
  const overLimit = audienceOverLimit(draft);
  const empty = draftItemCount(draft) === 0;
  const choose = (mode: AudienceDraft['mode']) => {
    if (mode === draft.mode) return;
    onChange({ ...draft, mode });
    if (mode === 'matchAny' && empty) setPicker({ revertToAll: true });
  };
  const closePicker = (next?: AudienceDraft) => {
    const revert = picker?.revertToAll;
    setPicker(null);
    if (next) onChange(next);
    else if (revert && empty) onChange({ ...draft, mode: 'all' });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className={hideLegend ? 'sr-only' : 'mb-2 text-13 text-[var(--text-secondary)]'}>{t(`${copy}.title`)}</legend>
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
        {(['all', 'matchAny'] as const).map((mode) => (
          <div key={mode} className={mode === 'matchAny' ? 'border-t border-[var(--border-default)]' : undefined}>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2.5 text-14 text-[var(--text-primary)]">
              <input type="radio" name={radioName} checked={draft.mode === mode} onChange={() => choose(mode)}
                className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--text-primary)]" />
              {t(mode === 'all' ? `${copy}.all` : `${copy}.specified`)}
            </label>
            {mode === 'matchAny' && draft.mode === 'matchAny' ? (
              <div className="space-y-1.5 pb-3 pl-9 pr-3">
                <div className={cn('flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border px-2 py-1.5',
                  complete ? 'border-[var(--border-default)]' : 'border-[var(--error-border)]')}>
                  <AudienceSelectionSummary draft={draft} departments={departments} onChange={onChange} />
                  <Button size="sm" variant="secondary" tone="quiet" compact onClick={() => setPicker({ revertToAll: false })}>
                    <Plus size={14} aria-hidden="true" />{t(empty ? `${copy}.choose` : `${copy}.add`)}
                  </Button>
                </div>
                {!complete ? (
                  <p role="status" className="text-12 leading-[1.667] text-[var(--error-fg)]">{t(`${copy}.requireOne`)}</p>
                ) : null}
                {unresolved.length > 0 ? (
                  <ul aria-label={t(`${copy}.unresolvedLabel`)} className="space-y-1 text-13 leading-[1.54]">
                    {unresolved.map((item) => (
                      <li key={`${item.kind}:${item.text}`} className="flex flex-wrap gap-x-2">
                        <span className="text-[var(--text-primary)]">{item.text}</span>
                        <span className="text-[var(--text-secondary)]">
                          {t(item.reason === 'ambiguous' ? `${copy}.ambiguous` : `${copy}.notFound`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {overLimit ? (
                  <p role="alert" className="text-12 leading-[1.667] text-[var(--text-secondary)]">
                    {t(`${copy}.tooMany`, { kind: t(`${copy}.picker.${overLimit.kind}`), max: overLimit.max, count: overLimit.count })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <PluginAudiencePicker
        open={pickerOpen}
        initial={draft}
        departments={departments}
        departmentsFailed={departmentsFailed}
        onRetryDepartments={loadDepartments}
        api={api}
        onCancel={() => closePicker()}
        onDone={(next) => closePicker(next)}
      />
    </fieldset>
  );
}
