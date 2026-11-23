/** Selected departments, members, emails and legacy roles as removable chips. */
import { Building2, Mail, User, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AuthorDepartment } from '../../../../shared/pluginAuthor';
import {
  draftItemCount,
  memberLabel,
  removeRole,
  toggleEmail,
  toggleMember,
  type AudienceDraft,
} from './audienceDraft';

const copy = 'settings.ghosts.audience';

export function AudienceSelectionSummary({
  draft,
  departments,
  onChange,
}: {
  draft: AudienceDraft;
  /** null while loading: department names are not guessed. */
  departments: readonly AuthorDepartment[] | null;
  onChange: (draft: AudienceDraft) => void;
}) {
  const { t } = useTranslation();
  if (draftItemCount(draft) === 0) {
    return <p className="text-13 text-[var(--text-secondary)]">{t(`${copy}.picker.noneSelected`)}</p>;
  }
  const byId = new Map((departments ?? []).map((department) => [department.id, department]));
  const chip = (key: string, icon: ReactNode, label: string, onRemove: () => void, detail?: string | null) => (
    <li key={key} title={detail ? `${label} · ${detail}` : label}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border-default)] py-0.5 pl-2 pr-0.5 text-13 text-[var(--text-primary)]">
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {/* People with the same name stay distinguishable. */}
      {detail ? <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]">{detail}</span> : null}
      <button
        type="button"
        aria-label={t(`${copy}.picker.remove`, { name: label })}
        onClick={onRemove}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  );
  const icon = (Icon: typeof User) => <Icon size={12} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />;
  return (
    <ul aria-label={t(`${copy}.selectedLabel`)} className="flex flex-wrap gap-1.5">
      {draft.departmentIds.map((id) => chip(
        `d:${id}`,
        icon(Building2),
        byId.get(id)?.name ?? (departments ? t(`${copy}.picker.unknownDepartment`) : t(`${copy}.picker.loading`)),
        () => onChange({ ...draft, departmentIds: draft.departmentIds.filter((other) => other !== id) }),
      ))}
      {draft.members.map((member) => chip(
        `m:${member.membershipId}`,
        icon(User),
        member.displayName || member.email ? memberLabel(member) : t(`${copy}.picker.memberId`, { id: member.membershipId }),
        () => onChange(toggleMember(draft, member, false)),
        member.email && member.email !== memberLabel(member) ? member.email : null,
      ))}
      {draft.emails.map((email) => chip(`e:${email}`, icon(Mail), email, () => onChange(toggleEmail(draft, email, false))))}
      {draft.roles.map((role) => chip(
        `r:${role}`,
        icon(User),
        t(`${copy}.roleLabels.${role}`, { defaultValue: role }),
        () => onChange(removeRole(draft, role)),
      ))}
    </ul>
  );
}
