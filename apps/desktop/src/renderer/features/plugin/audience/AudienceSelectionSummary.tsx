/** Selected departments, members, emails and legacy roles as removable chips. */
import { Mail, User, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AuthorDepartment } from '../../../../shared/pluginAuthor';
import {
  departmentParentName,
  draftItemCount,
  indexDepartments,
  memberDetail,
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
  // Nothing selected: the surrounding field shows its add button and the requirement instead.
  if (draftItemCount(draft) === 0) return null;
  const byId = indexDepartments(departments);
  const chip = (key: string, icon: ReactNode, label: string, onRemove: () => void, detail?: string | null) => (
    <li key={key} title={detail ? `${label} · ${detail}` : label}
      className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-[var(--surface-chip)] pl-2.5 pr-0.5 text-12 text-[var(--text-primary)]">
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {/* 「名字 · 部门」 (or the email) and 「部门 · 上级部门」 keep same-named entries apart. */}
      {detail ? <span className="min-w-0 truncate text-[var(--text-secondary)]">· {detail}</span> : null}
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
        icon(Users),
        byId.get(id)?.name ?? (departments ? t(`${copy}.picker.unknownDepartment`) : t(`${copy}.picker.loading`)),
        () => onChange({ ...draft, departmentIds: draft.departmentIds.filter((other) => other !== id) }),
        departmentParentName(id, byId),
      ))}
      {draft.members.map((member) => chip(
        `m:${member.membershipId}`,
        icon(User),
        member.displayName || member.email ? memberLabel(member) : t(`${copy}.picker.memberId`, { id: member.membershipId }),
        () => onChange(toggleMember(draft, member, false)),
        memberDetail(member),
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
