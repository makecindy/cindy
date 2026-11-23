/**
 * Visibility audience editor: all members, or specific departments / members / emails.
 * Shared by the publish confirmation screen and the team plugin detail (#1541).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { AuthorDepartment, PluginAuthorRendererApi } from '../../../../shared/pluginAuthor';
import type { PublisherAudienceUnresolved } from '../../../../shared/pluginPublisher';
import { audienceOf, type AudienceDraft } from './audienceDraft';
import { AudienceSelectionSummary } from './AudienceSelectionSummary';
import { PluginAudiencePicker } from './PluginAudiencePicker';

const copy = 'settings.ghosts.audience';

export function AudienceEditor({
  draft,
  onChange,
  unresolved = [],
  api,
  disabled = false,
}: {
  draft: AudienceDraft;
  onChange: (draft: AudienceDraft) => void;
  /** Names from the conversation that could not be matched to one department or member. */
  unresolved?: readonly PublisherAudienceUnresolved[];
  api: Pick<PluginAuthorRendererApi, 'departments' | 'departmentMembers' | 'searchColleagues'>;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
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

  const modeOptions = useMemo(() => [
    { value: 'all' as const, label: t(`${copy}.all`) },
    { value: 'matchAny' as const, label: t(`${copy}.specified`) },
  ], [t]);
  const complete = audienceOf(draft) !== null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-13 font-medium text-[var(--text-primary)]">{t(`${copy}.title`)}</h3>
        <SegmentedControl
          aria-label={t(`${copy}.title`)}
          value={draft.mode}
          options={modeOptions}
          disabled={disabled}
          onValueChange={(mode) => onChange({ ...draft, mode })}
        />
      </div>
      {draft.mode === 'matchAny' ? (
        <>
          <AudienceSelectionSummary draft={draft} departments={departments} onChange={onChange} />
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="secondary" compact disabled={disabled} onClick={() => setPickerOpen(true)}>
              {t(`${copy}.choose`)}
            </Button>
            {!complete ? (
              <p role="status" className="text-12 text-[var(--text-secondary)]">{t(`${copy}.requireOne`)}</p>
            ) : null}
          </div>
          <p className="text-12 leading-[1.333] text-[var(--text-tertiary)]">{t(`${copy}.impact`)}</p>
        </>
      ) : null}
      <PluginAudiencePicker
        open={pickerOpen}
        initial={draft}
        departments={departments}
        departmentsFailed={departmentsFailed}
        onRetryDepartments={loadDepartments}
        api={api}
        onCancel={() => setPickerOpen(false)}
        onDone={(next) => {
          onChange(next);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
