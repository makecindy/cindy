/**
 * ContactsManagerDialog — 智能通讯录管理浮层(radix Dialog, 与 ScheduleFormDialog
 * 同外壳): 左列表(搜索/过滤/分组/新建) + 右详情。
 *
 * 设计取舍: 通讯录开启后无需初始化、平时也不需要用户持续维护, 管理界面是低频
 * 入口 — 收进弹层, 设置页只留开关小节(不占顶级导航)。
 * 数据加载全部在本组件内(打开才拉, 关闭即弃), 订阅 changed 广播实时刷新。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Import, RefreshCw, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { createLogger } from '@/lib/logger';
import {
  contactsService,
  contactsErrorI18nKey,
  type ContactProfile,
  type ContactSummary,
  type ContactGroupWithCount,
  type ContactsDeviceSyncStatus,
  type ContactsStats,
} from '@/lib/contactsService';
import { ContactsListPane, type ContactsFilter } from './ContactsListPane';
import { ContactDetailPane } from './ContactDetailPane';
import { ContactsImportDialog } from './ContactsImportDialog';

const log = createLogger('ContactsManagerDialog');

/** 列表单页行数(与 store 侧 limit 上限一致); 超过时按页累载, 不截断大库 */
const PAGE_SIZE = 200;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "让 AI 整理"引导(空列表态展示): 由 ContactsSection 注入, 会关闭本浮层并跳新会话草稿 */
  onAiOrganize?: () => void;
  syncStatus?: ContactsDeviceSyncStatus | null;
  syncPending?: boolean;
  syncSummary?: string;
  onSyncNow?: () => void;
}

export function ContactsManagerDialog({
  open,
  onOpenChange,
  onAiOrganize,
  syncStatus,
  syncPending = false,
  syncSummary,
  onSyncNow,
}: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  const [stats, setStats] = useState<ContactsStats | null>(null);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [groups, setGroups] = useState<ContactGroupWithCount[]>([]);
  const [filter, setFilter] = useState<ContactsFilter>('all');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContactProfile | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // 已加载页数(每页 PAGE_SIZE): changed 广播重载时保持深度, 过滤/搜索变化时重置回 1
  const [pageCount, setPageCount] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const listOptions = useMemo(() => {
    const opts: Parameters<typeof contactsService.list>[0] = {};
    if (filter === 'person' || filter === 'org') opts.kind = filter;
    if (filter === 'pending') opts.status = 'pending';
    if (groupFilter) opts.groupId = groupFilter;
    return opts;
  }, [filter, groupFilter]);

  const reload = useCallback(async () => {
    if (!open) return;
    try {
      if (query.trim()) {
        // 搜索模式: FTS 命中转 summary 形状(列表只需要摘要字段)。分组过滤下推
        // 进 SQL(LIMIT 之前生效) — 客户端后过滤会被全局 top-N 挤掉组内命中
        const hits = await contactsService.search(query.trim(), {
          ...(filter === 'person' || filter === 'org' ? { kind: filter } : {}),
          ...(filter === 'pending' ? { status: 'pending' as const } : {}),
          ...(groupFilter ? { groupId: groupFilter } : {}),
          limit: 50,
        });
        setContacts(
          hits.map((h) => ({
            id: h.contactId,
            kind: h.kind,
            displayName: h.displayName,
            aliases: [],
            summary: h.summary,
            status: h.status,
            source: 'agent' as const,
            identityCount: 0,
            updatedAt: '',
          })),
        );
        setHasMore(false);
      } else {
        // store 侧单次 limit 上限 PAGE_SIZE, 大库按页并发拉齐已加载深度;
        // 末页取满说明后面还有 → 显示"加载更多"
        const pages = await Promise.all(
          Array.from({ length: pageCount }, (_, i) =>
            contactsService.list({ ...listOptions, limit: PAGE_SIZE, offset: i * PAGE_SIZE }),
          ),
        );
        setContacts(pages.flat());
        setHasMore((pages[pages.length - 1]?.length ?? 0) === PAGE_SIZE);
      }
      const [s, g] = await Promise.all([contactsService.stats(), contactsService.groupsList()]);
      setStats(s);
      setGroups(g);
    } catch (err) {
      log.warn('contacts reload failed', err);
    }
  }, [open, query, filter, groupFilter, listOptions, pageCount]);

  const reloadDetail = useCallback(async (id: string | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await contactsService.get(id));
    } catch (err) {
      // 被删除(agent 侧 merge/delete)→ 清选择
      log.warn('contacts get failed', err);
      setDetail(null);
      setSelectedId(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void reloadDetail(selectedId);
  }, [selectedId, reloadDetail]);

  useEffect(() => {
    if (!open) return;
    const off = contactsService.onChanged(() => {
      void reload();
      void reloadDetail(selectedId);
    });
    return off;
  }, [open, reload, reloadDetail, selectedId]);

  // 关闭时清搜索/选择, 下次打开是干净状态
  useEffect(() => {
    if (open) return;
    setQuery('');
    setSelectedId(null);
    setDetail(null);
    setFilter('all');
    setGroupFilter(null);
    setPageCount(1);
    setHasMore(false);
  }, [open]);

  // 过滤/分组/搜索是另一份结果集 → 分页深度重置回第一页(同批 setState, 只触发一次 reload)
  const handleFilterChange = useCallback((f: ContactsFilter) => {
    setFilter(f);
    setPageCount(1);
  }, []);
  const handleGroupFilterChange = useCallback((groupId: string | null) => {
    setGroupFilter(groupId);
    setPageCount(1);
  }, []);
  const handleQueryChange = useCallback((q: string) => {
    setQuery(q);
    setPageCount(1);
  }, []);
  const handleLoadMore = useCallback(() => {
    setPageCount((c) => c + 1);
  }, []);

  const handleCreate = useCallback(
    async (displayName: string, kind: 'person' | 'org') => {
      try {
        const created = await contactsService.create({ kind, displayName, source: 'manual' });
        setSelectedId(created.id);
        toast.success(t('settings.contacts.toast.created', { name: created.displayName }));
      } catch (err) {
        log.warn('contacts create failed', err);
        toast.error(t(contactsErrorI18nKey(err)));
      }
    },
    [t],
  );

  const handleDelete = useCallback(
    async (profile: ContactProfile) => {
      const ok = await confirm({
        title: t('settings.contacts.deleteConfirm.title', { name: profile.displayName }),
        description: t('settings.contacts.deleteConfirm.description'),
        confirmText: t('settings.contacts.deleteConfirm.confirm'),
        cancelText: t('settings.contacts.deleteConfirm.cancel'),
      });
      if (!ok) return;
      try {
        await contactsService.delete(profile.id);
        setSelectedId(null);
        toast.success(t('settings.contacts.toast.deleted', { name: profile.displayName }));
      } catch (err) {
        log.warn('contacts delete failed', err);
        toast.error(t(contactsErrorI18nKey(err)));
      }
    },
    [confirm, t],
  );

  const statsLine = stats
    ? t('settings.contacts.stats', {
        people: stats.people,
        orgs: stats.orgs,
        groups: stats.groups,
      })
    : '';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'flex h-[82vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-xl',
            'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <header className="flex shrink-0 items-center gap-4 py-4 pl-6 pr-4">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Dialog.Title className="text-16 font-medium leading-[1.3] text-[var(--settings-section-title)]">
                {t('settings.contacts.manager.title')}
              </Dialog.Title>
              {statsLine && (
                <p className="text-12 leading-[1.4] text-[var(--cmd-palette-item-meta)]">
                  {statsLine}
                </p>
              )}
              {syncSummary && (
                <p
                  className={cn(
                    'text-12 leading-[1.4]',
                    syncStatus?.phase === 'error'
                      ? 'text-[var(--settings-error-text)]'
                      : 'text-[var(--cmd-palette-item-meta)]',
                  )}
                >
                  {syncSummary}
                  {syncStatus?.enabled && syncStatus.onlineDeviceCount > 0
                    ? ` · ${t('settings.contacts.sync.onlineDevices', {
                        count: syncStatus.onlineDeviceCount,
                      })}`
                    : ''}
                </p>
              )}
            </div>
            {syncStatus?.enabled && onSyncNow && (
              <button
                type="button"
                onClick={onSyncNow}
                disabled={syncPending || syncStatus.onlineDeviceCount === 0}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-13 transition-colors',
                  'text-[var(--settings-section-title)] bg-[var(--settings-input-bg)]',
                  'hover:bg-[var(--settings-menu-bg-hover)]',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <span
                  className={cn(
                    'inline-flex',
                    syncPending && 'animate-spinner motion-reduce:animate-none',
                  )}
                  aria-hidden="true"
                >
                  <RefreshCw size={14} />
                </span>
                {t('settings.contacts.sync.syncNow')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              aria-label={t('settings.contacts.import.title')}
              title={t('settings.contacts.import.title')}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-13 transition-colors',
                'text-[var(--settings-section-title)] bg-[var(--settings-input-bg)] hover:bg-[var(--settings-menu-bg-hover)]',
              )}
            >
              <Import size={14} />
              {t('settings.contacts.import.button')}
            </button>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('settings.contacts.manager.closeAria')}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                  'text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
                )}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex min-h-0 flex-1 border-t border-[var(--settings-theme-card-border)]">
            <ContactsListPane
              contacts={contacts}
              groups={groups}
              pendingCount={stats?.pending ?? 0}
              filter={filter}
              groupFilter={groupFilter}
              query={query}
              selectedId={selectedId}
              hasMore={hasMore}
              onFilterChange={handleFilterChange}
              onGroupFilterChange={handleGroupFilterChange}
              onQueryChange={handleQueryChange}
              onSelect={setSelectedId}
              onCreate={handleCreate}
              onLoadMore={handleLoadMore}
              {...(onAiOrganize ? { onAiOrganize } : {})}
            />
            <div className="min-w-0 flex-1 overflow-y-auto border-l border-[var(--settings-theme-card-border)]">
              <ContactDetailPane
                profile={detail}
                groups={groups}
                onChanged={() => {
                  void reload();
                  void reloadDetail(selectedId);
                }}
                onDelete={handleDelete}
              />
            </div>
          </div>
          <ContactsImportDialog open={importOpen} onOpenChange={setImportOpen} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
