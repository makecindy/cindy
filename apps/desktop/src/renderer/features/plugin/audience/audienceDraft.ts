/**
 * Editable form of an organization plugin visibility audience. Shared by the publish confirmation
 * screen and (later) the plugin detail page. Roles are legacy: kept and removable, never added.
 */
import type { AuthorDepartment, AuthorVisibilityAudience } from '../../../../shared/pluginAuthor';

export interface AudienceMember {
  membershipId: string;
  displayName: string | null;
  email: string | null;
}

export interface AudienceDraft {
  mode: 'all' | 'matchAny';
  departmentIds: string[];
  members: AudienceMember[];
  /** People matched by email, including ones who have not joined yet. */
  emails: string[];
  roles: string[];
}

export const EMPTY_SPECIFIED_DRAFT: AudienceDraft = {
  mode: 'matchAny', departmentIds: [], members: [], emails: [], roles: [],
};

export const ALL_MEMBERS_DRAFT: AudienceDraft = {
  mode: 'all', departmentIds: [], members: [], emails: [], roles: [],
};

export function memberLabel(member: AudienceMember): string {
  return member.displayName || member.email || member.membershipId;
}

export function draftOf(
  audience: AuthorVisibilityAudience | undefined,
  known: readonly AudienceMember[] = [],
): AudienceDraft {
  if (!audience || audience.type === 'all') return { ...ALL_MEMBERS_DRAFT };
  const byId = new Map(known.map((member) => [member.membershipId, member]));
  return {
    mode: 'matchAny',
    departmentIds: [...(audience.departmentIds ?? [])],
    members: (audience.membershipIds ?? []).map(
      (id) => byId.get(id) ?? { membershipId: id, displayName: null, email: null },
    ),
    emails: [...(audience.emails ?? [])],
    roles: [...(audience.roles ?? [])],
  };
}

export function draftItemCount(draft: AudienceDraft): number {
  return draft.departmentIds.length + draft.members.length + draft.emails.length + draft.roles.length;
}

/** Null when "specified" has nothing selected: publishing must stay disabled. */
export function audienceOf(draft: AudienceDraft): AuthorVisibilityAudience | null {
  if (draft.mode === 'all') return { type: 'all' };
  if (draftItemCount(draft) === 0) return null;
  const membershipIds = draft.members.map((member) => member.membershipId);
  return {
    type: 'matchAny',
    ...(draft.departmentIds.length ? { departmentIds: [...draft.departmentIds] } : {}),
    ...(membershipIds.length ? { membershipIds } : {}),
    ...(draft.emails.length ? { emails: [...draft.emails] } : {}),
    ...(draft.roles.length ? { roles: [...draft.roles] } : {}),
  };
}

export type DepartmentIndex = ReadonlyMap<string, AuthorDepartment>;

export function indexDepartments(departments: readonly AuthorDepartment[] | null): DepartmentIndex {
  return new Map((departments ?? []).map((department) => [department.id, department]));
}

/** Ancestors from nearest to farthest; stops on unknown parents and cycles. */
export function departmentAncestors(id: string, byId: DepartmentIndex): string[] {
  const chain: string[] = [];
  for (
    let parent = byId.get(id)?.parentId ?? null;
    parent && byId.has(parent) && !chain.includes(parent) && parent !== id;
    parent = byId.get(parent)?.parentId ?? null
  ) {
    chain.push(parent);
  }
  return chain;
}

export function departmentPath(id: string, byId: DepartmentIndex): string {
  return departmentAncestors(id, byId)
    .reverse()
    .map((parent) => byId.get(parent)?.name ?? '')
    .filter(Boolean)
    .join(' / ');
}

export function childDepartments(
  departments: readonly AuthorDepartment[],
  byId: DepartmentIndex,
  parent: string | null,
): AuthorDepartment[] {
  return departments
    .filter((department) => (department.parentId && byId.has(department.parentId) ? department.parentId : null) === parent)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

/** Selecting a department folds its already-selected descendants into it. */
export function toggleDepartment(draft: AudienceDraft, id: string, checked: boolean, byId: DepartmentIndex): AudienceDraft {
  return {
    ...draft,
    departmentIds: checked
      ? [...draft.departmentIds.filter((other) => other !== id && !departmentAncestors(other, byId).includes(id)), id]
      : draft.departmentIds.filter((other) => other !== id),
  };
}

export function toggleMember(draft: AudienceDraft, member: AudienceMember, checked: boolean): AudienceDraft {
  const without = draft.members.filter((item) => item.membershipId !== member.membershipId);
  return { ...draft, members: checked ? [...without, member] : without };
}

export function toggleEmail(draft: AudienceDraft, email: string, checked: boolean): AudienceDraft {
  const normalized = email.trim().toLowerCase();
  const without = draft.emails.filter((item) => item !== normalized);
  return { ...draft, emails: checked ? [...without, normalized] : without };
}

export function removeRole(draft: AudienceDraft, role: string): AudienceDraft {
  return { ...draft, roles: draft.roles.filter((item) => item !== role) };
}

/** Names for a one-line summary; null when department names are still loading. */
export function audienceSummaryNames(
  draft: AudienceDraft,
  departments: readonly AuthorDepartment[] | null,
  labels: { unknownDepartment: string; role: (role: string) => string; memberId: (id: string) => string },
): string[] | null {
  if (draft.departmentIds.length > 0 && !departments) return null;
  const byId = indexDepartments(departments);
  return [
    ...draft.departmentIds.map((id) => byId.get(id)?.name ?? labels.unknownDepartment),
    ...draft.members.map((member) =>
      member.displayName || member.email ? memberLabel(member) : labels.memberId(member.membershipId)),
    ...draft.emails,
    ...draft.roles.map(labels.role),
  ];
}
