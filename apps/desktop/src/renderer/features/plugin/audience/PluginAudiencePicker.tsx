/**
 * Department / member picker for an organization plugin visibility audience.
 *
 * Same shape as the enterprise console picker (#1504 rule 1): the department tree lists each
 * department's direct active members before its sub-departments; members and sub-departments of a
 * selected department show "included"; search groups departments, members and emails; a complete
 * email can be added on its own. Legacy role conditions are shown and removable, never added.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Building2, ChevronRight, Mail, User, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { AuthorDepartment, Colleague, PluginAuthorRendererApi } from '../../../../shared/pluginAuthor';
import {
  childDepartments,
  departmentAncestors,
  departmentPath,
  draftItemCount,
  EMAIL_PATTERN,
  indexDepartments,
  memberLabel,
  removeRole,
  toggleDepartment,
  toggleEmail,
  toggleMember,
  type AudienceDraft,
  type AudienceMember,
} from './audienceDraft';

const copy = 'settings.ghosts.audience.picker';
const SEARCH_DEBOUNCE_MS = 200;

interface DepartmentPage {
  members: Colleague[];
  total: number;
  page: number;
}

export function PluginAudiencePicker({
  open,
  initial,
  departments,
  departmentsFailed,
  onRetryDepartments,
  api,
  onCancel,
  onDone,
}: {
  open: boolean;
  initial: AudienceDraft;
  /** null while loading. */
  departments: readonly AuthorDepartment[] | null;
  departmentsFailed: boolean;
  onRetryDepartments: () => void;
  api: Pick<PluginAuthorRendererApi, 'departmentMembers' | 'searchColleagues'>;
  onCancel: () => void;
  onDone: (draft: AudienceDraft) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AudienceDraft>(initial);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [found, setFound] = useState<Colleague[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [nodes, setNodes] = useState<Record<string, DepartmentPage | undefined>>({});
  const [loadingNodes, setLoadingNodes] = useState<ReadonlySet<string>>(new Set());
  const [failedNodes, setFailedNodes] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode re-runs effects after a cleanup; mark mounted again each time.
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const byId = useMemo(() => indexDepartments(departments), [departments]);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...initial, mode: 'matchAny' });
    setQuery('');
    // Ancestors of selected departments start expanded so the selection is visible.
    setExpanded(new Set(initial.departmentIds.flatMap((id) => departmentAncestors(id, byId))));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the picker opens
  }, [open]);

  const keyword = query.trim();
  useEffect(() => {
    if (!open || !keyword) {
      setFound(null);
      setSearchFailed(false);
      return;
    }
    let cancelled = false;
    setFound(null);
    setSearchFailed(false);
    const timer = setTimeout(() => {
      api.searchColleagues(keyword).then(
        (members) => { if (!cancelled) setFound(members.filter((member) => member.active)); },
        () => { if (!cancelled) setSearchFailed(true); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, keyword, api]);

  const loadNode = (id: string, page: number) => {
    if (loadingNodes.has(id)) return;
    setLoadingNodes((current) => new Set([...current, id]));
    setFailedNodes((current) => { const next = new Set(current); next.delete(id); return next; });
    api.departmentMembers(id, page).then(
      (result) => {
        if (!mounted.current) return;
        setNodes((current) => {
          const previous = current[id];
          const members = page === 1 || !previous ? result.members : [...previous.members, ...result.members];
          return { ...current, [id]: { members, total: result.total, page } };
        });
      },
      () => {
        if (mounted.current) setFailedNodes((current) => new Set([...current, id]));
      },
    ).finally(() => {
      if (!mounted.current) return;
      setLoadingNodes((current) => { const next = new Set(current); next.delete(id); return next; });
    });
  };

  useEffect(() => {
    if (!open) return;
    for (const id of expanded) {
      if (!nodes[id] && !loadingNodes.has(id) && !failedNodes.has(id)) loadNode(id, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load newly expanded departments once
  }, [open, expanded]);

  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selected = new Set(draft.departmentIds);
  const covered = (id: string) => departmentAncestors(id, byId).some((parent) => selected.has(parent));
  const pickedMember = (id: string) => draft.members.some((member) => member.membershipId === id);
  const count = draftItemCount(draft);

  const includedTag = <span className="shrink-0 text-12 text-[var(--text-tertiary)]">{t(`${copy}.included`)}</span>;
  const indent = (depth: number) => ({ paddingLeft: depth * 16 });

  const departmentRow = (department: AuthorDepartment, depth: number, options: { expandable: boolean; path?: string }) => {
    const inherited = covered(department.id);
    const isOpen = options.expandable && expanded.has(department.id);
    return (
      <li key={`d:${department.id}`} style={indent(depth)} className="flex min-h-8 items-center gap-1 rounded-lg pr-2 hover:bg-[var(--surface-hover)]">
        {options.expandable ? (
          <button type="button" aria-expanded={isOpen}
            aria-label={t(isOpen ? `${copy}.collapse` : `${copy}.expand`, { name: department.name })}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            onClick={() => toggleExpand(department.id)}>
            <ChevronRight size={14} aria-hidden="true" className={isOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
          </button>
        ) : <span className="size-6 shrink-0" aria-hidden="true" />}
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1">
          <Checkbox checked={inherited || selected.has(department.id)} disabled={inherited}
            onChange={(event) => setDraft((current) => toggleDepartment(current, department.id, event.target.checked, byId))} />
          <Building2 size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-13 text-[var(--text-primary)]">{department.name}</span>
            {options.path ? <span className="truncate text-12 text-[var(--text-tertiary)]">{options.path}</span> : null}
          </span>
          {inherited ? includedTag : null}
        </label>
      </li>
    );
  };

  const note = (key: string, depth: number, content: ReactNode) => (
    <li key={key} style={indent(depth)} className="flex min-h-8 items-center gap-2 pl-7 pr-2 text-12 text-[var(--text-tertiary)]">{content}</li>
  );

  const memberRow = (member: AudienceMember, key: string, depth: number, inherited: boolean) => (
    <li key={key} style={indent(depth)}>
      <label className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-lg pr-2 hover:bg-[var(--surface-hover)] ${depth > 0 ? 'pl-7' : 'pl-2'}`}>
        <Checkbox checked={inherited || pickedMember(member.membershipId)} disabled={inherited}
          onChange={(event) => setDraft((current) => toggleMember(current, member, event.target.checked))} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 truncate text-13 text-[var(--text-primary)]">{memberLabel(member)}</span>
          {member.email && member.email !== memberLabel(member)
            ? <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]">{member.email}</span> : null}
        </span>
        {inherited ? includedTag : null}
      </label>
    </li>
  );

  const people = (department: AuthorDepartment, depth: number): ReactNode[] => {
    const page = nodes[department.id];
    const failed = failedNodes.has(department.id);
    const retry = (pageNumber: number) => (
      <span className="flex items-center gap-2">
        {t(`${copy}.loadFailed`)}
        <Button size="sm" variant="secondary" compact onClick={() => loadNode(department.id, pageNumber)}>{t(`${copy}.retry`)}</Button>
      </span>
    );
    if (failed && !page) return [note(`e:${department.id}`, depth, retry(1))];
    if (!page) return [note(`l:${department.id}`, depth, t(`${copy}.loading`))];
    const inherited = selected.has(department.id) || covered(department.id);
    return [
      ...page.members.map((member) => memberRow(member, `${department.id}:${member.membershipId}`, depth, inherited)),
      ...(page.members.length < page.total
        ? [note(`m:${department.id}`, depth, failed ? retry(page.page + 1) : (
          <Button size="sm" variant="secondary" tone="quiet" compact disabled={loadingNodes.has(department.id)}
            onClick={() => loadNode(department.id, page.page + 1)}>{t(`${copy}.loadMore`)}</Button>
        ))]
        : []),
    ];
  };

  const tree = (parent: string | null, depth: number): ReactNode[] =>
    childDepartments(departments ?? [], byId, parent).flatMap((department) => [
      // Every department may have direct members, so every department can expand.
      departmentRow(department, depth, { expandable: true }),
      ...(expanded.has(department.id) ? [...people(department, depth + 1), ...tree(department.id, depth + 1)] : []),
    ]);

  const groupLabel = (text: string) => (
    <p className="px-2 pb-1 pt-3 text-12 font-medium text-[var(--text-tertiary)] first:pt-1">{text}</p>
  );

  const browse = (() => {
    if (departmentsFailed) {
      return (
        <p role="alert" className="m-3 flex flex-wrap items-center gap-2 text-13 text-[var(--text-secondary)]">
          {t(`${copy}.loadFailed`)}
          <Button size="sm" variant="secondary" compact onClick={onRetryDepartments}>{t(`${copy}.retry`)}</Button>
        </p>
      );
    }
    if (!keyword) {
      return (
        <>
          {groupLabel(t(`${copy}.departments`))}
          {!departments ? <p className="px-2 py-2 text-12 text-[var(--text-tertiary)]">{t(`${copy}.loading`)}</p>
            : departments.length === 0 ? <p className="px-2 py-2 text-12 text-[var(--text-tertiary)]">{t(`${copy}.searchMembersOnly`)}</p>
            : <ul aria-label={t(`${copy}.departments`)}>{tree(null, 0)}</ul>}
        </>
      );
    }
    const lower = keyword.toLowerCase();
    const emailCandidate = EMAIL_PATTERN.test(keyword) && found !== null &&
      !found.some((member) => member.email?.toLowerCase() === lower) ? lower : null;
    const matchedDepartments = (departments ?? []).filter((department) => department.name.toLowerCase().includes(lower));
    return (
      <>
        {matchedDepartments.length > 0 ? (
          <>
            {groupLabel(t(`${copy}.departments`))}
            <ul aria-label={t(`${copy}.departments`)}>
              {matchedDepartments.map((department) =>
                departmentRow(department, 0, { expandable: false, path: departmentPath(department.id, byId) }))}
            </ul>
          </>
        ) : null}
        {groupLabel(t(`${copy}.members`))}
        {searchFailed ? <p role="alert" className="px-2 py-2 text-12 text-[var(--text-secondary)]">{t(`${copy}.loadFailed`)}</p>
          : found === null ? <p className="px-2 py-2 text-12 text-[var(--text-tertiary)]">{t(`${copy}.loading`)}</p>
          : found.length === 0 ? <p className="px-2 py-2 text-12 text-[var(--text-tertiary)]">{t(`${copy}.noMembers`)}</p>
          : <ul aria-label={t(`${copy}.members`)}>{found.map((member) => memberRow(member, `s:${member.membershipId}`, 0, false))}</ul>}
        {emailCandidate ? (
          <>
            {groupLabel(t(`${copy}.emails`))}
            <ul aria-label={t(`${copy}.emails`)}>
              <li>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-[var(--surface-hover)]">
                  <Checkbox checked={draft.emails.includes(emailCandidate)}
                    onChange={(event) => setDraft((current) => toggleEmail(current, emailCandidate, event.target.checked))} />
                  <span className="min-w-0 truncate text-13 text-[var(--text-primary)]">{t(`${copy}.addEmail`, { email: emailCandidate })}</span>
                </label>
              </li>
            </ul>
          </>
        ) : null}
      </>
    );
  })();

  const pickedRow = (key: string, icon: ReactNode, name: string, detail: string | undefined, onRemove: () => void) => (
    <li key={key} className="flex min-h-9 items-center gap-2 py-1">
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 text-[var(--text-primary)]">{name}</span>
        {detail ? <span className="truncate text-12 text-[var(--text-tertiary)]">{detail}</span> : null}
      </span>
      <Button size="sm" variant="secondary" tone="quiet" className="w-7 px-0" aria-label={t(`${copy}.remove`, { name })} onClick={onRemove}>
        <X size={14} aria-hidden="true" />
      </Button>
    </li>
  );
  const iconClass = 'shrink-0 text-[var(--text-tertiary)]';

  const selectedList = (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
      {count === 0 ? <p className="py-6 text-center text-12 text-[var(--text-tertiary)]">{t(`${copy}.noneSelected`)}</p> : null}
      {draft.departmentIds.length > 0 ? (
        <>
          {groupLabel(t(`${copy}.departments`))}
          <ul aria-label={t(`${copy}.departments`)}>
            {draft.departmentIds.map((id) => {
              const department = byId.get(id);
              const name = department?.name ?? (departments ? t(`${copy}.unknownDepartment`) : id);
              return pickedRow(`d:${id}`, <Building2 size={14} aria-hidden="true" className={iconClass} />, name,
                department ? departmentPath(id, byId) || undefined : undefined,
                () => setDraft((current) => toggleDepartment(current, id, false, byId)));
            })}
          </ul>
        </>
      ) : null}
      {draft.members.length > 0 ? (
        <>
          {groupLabel(t(`${copy}.members`))}
          <ul aria-label={t(`${copy}.members`)}>
            {draft.members.map((member) => pickedRow(`m:${member.membershipId}`, <User size={14} aria-hidden="true" className={iconClass} />,
              member.displayName || member.email ? memberLabel(member) : t(`${copy}.memberId`, { id: member.membershipId }),
              member.email && member.email !== memberLabel(member) ? member.email : undefined,
              () => setDraft((current) => toggleMember(current, member, false))))}
          </ul>
        </>
      ) : null}
      {draft.roles.length > 0 ? (
        <>
          {groupLabel(t(`${copy}.roles`))}
          <ul aria-label={t(`${copy}.roles`)}>
            {draft.roles.map((role) => pickedRow(`r:${role}`, <User size={14} aria-hidden="true" className={iconClass} />,
              t(`settings.ghosts.audience.roleLabels.${role}`, { defaultValue: role }), undefined,
              () => setDraft((current) => removeRole(current, role))))}
          </ul>
        </>
      ) : null}
      {draft.emails.length > 0 ? (
        <>
          {groupLabel(t(`${copy}.emails`))}
          <ul aria-label={t(`${copy}.emails`)}>
            {draft.emails.map((email) => pickedRow(`e:${email}`, <Mail size={14} aria-hidden="true" className={iconClass} />, email, undefined,
              () => setDraft((current) => toggleEmail(current, email, false))))}
          </ul>
        </>
      ) : null}
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal-nested" />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-modal-nested flex h-[min(560px,85vh)] w-[calc(100vw-32px)] max-w-[720px] -translate-x-1/2 -translate-y-1/2 flex-col p-4">
          <Dialog.Title className="text-18 font-medium text-[var(--text-primary)]">{t(`${copy}.title`)}</Dialog.Title>
          <Dialog.Description className="mt-1 text-13 leading-[1.54] text-[var(--text-secondary)]">{t('settings.ghosts.audience.impact')}</Dialog.Description>
          <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex min-h-0 flex-col rounded-lg border border-[var(--border-default)]">
              <div className="p-2">
                <Input type="search" value={query} onChange={setQuery} ariaLabel={t(`${copy}.search`)} placeholder={t(`${copy}.search`)} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">{browse}</div>
            </div>
            <div className="flex min-h-0 flex-col rounded-lg border border-[var(--border-default)]">
              <div className="flex min-h-11 items-center justify-between gap-2 px-3">
                <span className="text-13 font-medium text-[var(--text-primary)]">{t(`${copy}.selected`, { count })}</span>
                {count > 0 ? (
                  <Button size="sm" variant="secondary" tone="quiet" compact
                    onClick={() => setDraft((current) => ({ ...current, departmentIds: [], members: [], emails: [], roles: [] }))}>
                    {t(`${copy}.clear`)}
                  </Button>
                ) : null}
              </div>
              {selectedList}
            </div>
          </div>
          <div className="mt-4 flex shrink-0 justify-end gap-2">
            <Button variant="secondary" onClick={onCancel}>{t(`${copy}.cancel`)}</Button>
            <Button variant="cta" onClick={() => onDone({ ...draft, mode: 'matchAny' })}>{t(`${copy}.done`)}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
