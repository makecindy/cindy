import { Button } from '@/components/ui/button';
/**
 * ContactsListPane — 通讯录管理区左列: 搜索 / 过滤 chips / 分组筛选 / 新建 / 列表。
 * 纯展示组件, 状态与数据由 ContactsSection 下发。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Plus, Search, Sparkles, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { ContactGroupWithCount, ContactSummary } from '@/lib/contactsService';

export type ContactsFilter = 'all' | 'person' | 'org' | 'pending';

interface Props {
  contacts: ContactSummary[];
  groups: ContactGroupWithCount[];
  pendingCount: number;
  filter: ContactsFilter;
  groupFilter: string | null;
  query: string;
  selectedId: string | null;
  onFilterChange: (f: ContactsFilter) => void;
  onGroupFilterChange: (groupId: string | null) => void;
  onQueryChange: (q: string) => void;
  /** 列表后面还有未加载的页(浏览模式按页累载, 大库不截断) */
  hasMore: boolean;
  onSelect: (id: string) => void;
  onCreate: (displayName: string, kind: 'person' | 'org') => void;
  onLoadMore: () => void;
  /** 空列表态的"让 AI 整理"引导入口(可选, 由管理浮层注入) */
  onAiOrganize?: () => void;
}

export function ContactsListPane(props: Props) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'person' | 'org'>('person');

  const filters: Array<{ id: ContactsFilter; label: string; badge?: number }> = [
    { id: 'all', label: t('settings.contacts.filters.all') },
    { id: 'person', label: t('settings.contacts.filters.person') },
    { id: 'org', label: t('settings.contacts.filters.org') },
    { id: 'pending', label: t('settings.contacts.filters.pending'), badge: props.pendingCount },
  ];

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    props.onCreate(name, newKind);
    setNewName('');
    setCreating(false);
  };

  return (
    <div className="flex w-[300px] shrink-0 flex-col">
      {/* 搜索 + 新建 */}
      <div className="flex items-center gap-2 p-3 pb-2">
        <div
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <Search size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
          <input
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            placeholder={t('settings.contacts.list.searchPlaceholder')}
            className={cn(
              'min-w-0 flex-1 bg-transparent text-13 outline-none',
              'text-[var(--settings-input-text)] placeholder:text-[var(--settings-section-desc)]',
            )}
          />
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          aria-label={t('settings.contacts.list.newAria')}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
            'text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
          )}
        >
          <Plus size={16} />
        </button>
      </div>

      {/* 新建行(inline, 回车提交) */}
      {creating && (
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate();
              if (e.key === 'Escape') setCreating(false);
            }}
            placeholder={t('settings.contacts.list.newNamePlaceholder')}
            className={cn(
              'h-8 min-w-0 flex-1 rounded-lg px-2.5 text-13 outline-none',
              'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
              'placeholder:text-[var(--settings-section-desc)]',
            )}
          />
          <button
            type="button"
            onClick={() => setNewKind((k) => (k === 'person' ? 'org' : 'person'))}
            aria-label={t('settings.contacts.list.newKindAria')}
            title={t(newKind === 'person' ? 'settings.contacts.kind.person' : 'settings.contacts.kind.org')}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
              'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]',
            )}
          >
            {newKind === 'person' ? <User size={14} /> : <Building2 size={14} />}
          </button>
          <button
            type="button"
            onClick={submitCreate}
            disabled={!newName.trim()}
            className={cn(
              'h-8 shrink-0 rounded-lg px-2.5 text-13 font-medium transition-colors',
              'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {t('settings.contacts.list.newConfirm')}
          </button>
        </div>
      )}

      {/* 过滤 chips + 分组筛选 */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
        <SegmentedControl
          aria-label={t('settings.contacts.title')}
          value={props.filter}
          onValueChange={props.onFilterChange}
          height={28}
          optionHeight={24}
          optionClassName="gap-1 px-2.5"
          options={filters.map((filter) => ({
            value: filter.id,
            label: (
              <>
                {filter.label}
                {filter.id === 'pending' && (filter.badge ?? 0) > 0 && (
                  <span className="rounded-full bg-[var(--status-bar-accent)] px-1.5 text-11 leading-[1.455] text-[var(--status-badge-fg)]">
                    {filter.badge}
                  </span>
                )}
              </>
            ),
          }))}
        />
        {props.groups.length > 0 && (
          <select
            value={props.groupFilter ?? ''}
            onChange={(e) => props.onGroupFilterChange(e.target.value || null)}
            aria-label={t('settings.contacts.list.groupFilterAria')}
            className={cn(
              'h-6 max-w-[120px] rounded-full bg-[var(--settings-input-bg)] px-2 text-12 outline-none',
              'text-[var(--settings-section-desc)]',
            )}
          >
            <option value="">{t('settings.contacts.list.groupFilterAll')}</option>
            {props.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.memberCount})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {props.contacts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-6">
            <p className="text-center text-12 text-[var(--settings-section-desc)]">
              {t(props.query ? 'settings.contacts.list.noResults' : 'settings.contacts.list.empty')}
            </p>
            {!props.query && props.onAiOrganize && (
              <Button variant="cta" size="md" compact type="button" onClick={props.onAiOrganize}>
                <Sparkles size={13} />
                {t('settings.contacts.guide.cta')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {props.contacts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => props.onSelect(c.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  props.selectedId === c.id
                    ? 'bg-[var(--settings-menu-bg-selected)]'
                    : 'hover:bg-[var(--settings-menu-bg-hover)]',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                    'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]',
                  )}
                >
                  {c.kind === 'person' ? <User size={13} /> : <Building2 size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-13 font-medium text-[var(--settings-section-title)]">
                      {c.displayName}
                    </span>
                    {c.status === 'pending' && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--status-bar-accent)]"
                        aria-label={t('settings.contacts.filters.pending')}
                      />
                    )}
                  </span>
                  {c.summary && (
                    <span className="block truncate text-12 text-[var(--settings-section-desc)]">
                      {c.summary}
                    </span>
                  )}
                </span>
              </button>
            ))}
            {props.hasMore && (
              <Button
                variant="secondary"
                tone="quiet"
                size="md"
                compact
                type="button"
                onClick={props.onLoadMore}
                className="mt-1 w-full"
              >
                {t('settings.contacts.list.loadMore')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
