/**
 * ContactsSection — Settings → 个性化 下的「智能通讯录」小节。
 *
 * 形态(有意保持极简, 不占顶级导航): 开关与手动管理仍在主卡片；开启后
 * 常驻一个「让 AI 帮你管理通讯录」入口。这个入口不按空库状态隐藏：第一次
 * 可用于建库，后续继续处理补充、去重与待确认项。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookUser, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';
import {
  contactsService,
  contactsErrorI18nKey,
  type ContactsDeviceSyncStatus,
  type ContactsStats,
} from '@/lib/contactsService';
import { ContactsManagerDialog } from './ContactsManagerDialog';
import { prefillContactsAiSessionDraft } from './startContactsAiSession';

const log = createLogger('ContactsSection');

export function ContactsSection() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [enabled, setEnabled] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [aiSessionPending, setAiSessionPending] = useState(false);
  const [stats, setStats] = useState<ContactsStats | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<ContactsDeviceSyncStatus | null>(null);
  const [syncPending, setSyncPending] = useState(false);

  const reloadStats = useCallback(async () => {
    try {
      setStats(await contactsService.stats());
    } catch (err) {
      log.warn('contacts stats failed', err);
    }
  }, []);

  useEffect(() => {
    void contactsService
      .settingsGet()
      .then((s) => setEnabled(s.enabled))
      .catch((err) => log.warn('contacts settingsGet failed', err));
    void reloadStats();
    void contactsService
      .syncStatusGet()
      .then(setSyncStatus)
      .catch((err) => log.warn('contacts syncStatusGet failed', err));
    // agent 写入时统计行实时刷新(小节常驻, 订阅成本可忽略)
    const off = contactsService.onChanged(() => void reloadStats());
    const offSync = contactsService.onSyncStatusChanged(setSyncStatus);
    return () => {
      off();
      offSync();
    };
  }, [reloadStats]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      setTogglePending(true);
      try {
        const res = await contactsService.settingsSet(next);
        if (res.codexMcpRefreshed === false) {
          // 开关已落盘(Claude 侧下次会话即生效), 但 Codex 正忙软重启失败 —
          // 明示延迟生效, 不静默报成功(否则用户以为 Codex 也已切换)
          toast.warning(t('settings.contacts.toast.codexRefreshDeferred'));
        } else {
          toast.success(
            t(next ? 'settings.contacts.toast.enabled' : 'settings.contacts.toast.disabled'),
          );
        }
      } catch (err) {
        log.warn('contacts settingsSet failed', err);
        toast.error(t(contactsErrorI18nKey(err)));
        setEnabled(prev);
      } finally {
        setTogglePending(false);
      }
    },
    [enabled, t],
  );

  /** 常驻 AI 管理入口：先打开 contacts 插件，再预填普通新任务草稿。 */
  const startAiSession = useCallback(async () => {
    if (togglePending || aiSessionPending) return;
    setAiSessionPending(true);
    try {
      const pluginState = await window.electronAPI.maker.plugins.getState('contacts');
      if (!pluginState.effectiveEnabled) {
        await window.electronAPI.maker.plugins.setEnabled('contacts', true);
      }
      prefillContactsAiSessionDraft(t('settings.contacts.guide.managementPrompt'));
      setManagerOpen(false);
      navigate('/cc-agent/new');
    } catch (err) {
      log.warn('plugins.setEnabled(contacts) before AI entry failed', err);
      toast.error(t('settings.builtinTools.toast.toggleFailed'));
    } finally {
      setAiSessionPending(false);
    }
  }, [aiSessionPending, navigate, t, togglePending]);

  const statsLine =
    stats && (stats.people > 0 || stats.orgs > 0 || stats.groups > 0)
      ? t('settings.contacts.stats', {
          people: stats.people,
          orgs: stats.orgs,
          groups: stats.groups,
        })
      : '';
  const pendingCount = stats?.pending ?? 0;
  const formatSyncTime = (value: string | null): string => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };
  const syncSummary = (() => {
    if (!syncStatus) return t('settings.contacts.sync.status.loading');
    if (!syncStatus.available) return t('settings.contacts.sync.status.signInRequired');
    if (syncStatus.phase === 'error' && syncStatus.errorCode) {
      return t(`settings.contacts.sync.error.${syncStatus.errorCode}`);
    }
    if (syncStatus.phase === 'syncing') return t('settings.contacts.sync.status.syncing');
    if (syncStatus.phase === 'waiting') return t('settings.contacts.sync.status.waiting');
    if (syncStatus.phase === 'off') return t('settings.contacts.sync.status.off');
    const time = formatSyncTime(syncStatus.lastSyncAt);
    if (time && syncStatus.lastSyncDeviceName) {
      return t('settings.contacts.sync.status.lastSuccess', {
        device: syncStatus.lastSyncDeviceName,
        time,
        route: t(
          syncStatus.lastRoute === 'lan'
            ? 'settings.contacts.sync.route.lan'
            : 'settings.contacts.sync.route.relay',
        ),
      });
    }
    return t('settings.contacts.sync.status.ready');
  })();

  const handleSyncToggle = useCallback(
    async (next: boolean) => {
      const previous = syncStatus;
      setSyncStatus((current) => (current ? { ...current, enabled: next } : current));
      setSyncPending(true);
      try {
        const status = await contactsService.syncEnabledSet(next);
        setSyncStatus(status);
        toast.success(
          t(
            next ? 'settings.contacts.sync.toast.enabled' : 'settings.contacts.sync.toast.disabled',
          ),
        );
      } catch (err) {
        log.warn('contacts syncEnabledSet failed', err);
        let latest = previous;
        try {
          latest = await contactsService.syncStatusGet();
        } catch {
          // 状态读取也失败时才回退到操作前快照。
        }
        setSyncStatus(latest);
        toast.error(
          latest?.errorCode
            ? t(`settings.contacts.sync.error.${latest.errorCode}`)
            : t(contactsErrorI18nKey(err)),
        );
      } finally {
        setSyncPending(false);
      }
    },
    [syncStatus, t],
  );

  const handleSyncNow = useCallback(async () => {
    setSyncPending(true);
    try {
      setSyncStatus(await contactsService.syncNow());
    } catch (err) {
      log.warn('contacts syncNow failed', err);
      toast.error(t(contactsErrorI18nKey(err)));
    } finally {
      setSyncPending(false);
    }
  }, [t]);

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.contacts.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.contacts.description')}
        </p>
      </div>

      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl px-4 py-[14px]',
          'bg-[var(--settings-theme-card-bg)] border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              'bg-[var(--settings-input-bg)]',
            )}
          >
            <BookUser size={18} className="text-[var(--settings-section-title)]" />
          </div>
          <div className="flex flex-col gap-[8px]">
            <p className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
              {t('settings.contacts.enable.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
              {t('settings.contacts.enable.description')}
              {statsLine ? ` · ${statsLine}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 管理入口不随开关禁用: 开关只 gate agent 侧访问, 关闭后用户仍需要
              能进来浏览/清理既有数据(数据 CRUD IPC 通道本就不受 gate) */}
          <button
            type="button"
            onClick={() => setManagerOpen(true)}
            className={cn(
              'flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-13 transition-colors',
              'text-[var(--settings-section-title)] bg-[var(--settings-input-bg)]',
              'hover:bg-[var(--settings-menu-bg-hover)]',
            )}
          >
            {t('settings.contacts.manage')}
            {pendingCount > 0 && (
              <span className="rounded-full bg-[var(--status-bar-accent)] px-1.5 text-11 leading-[16px] text-[var(--accent-pure-cta-fg)]">
                {pendingCount}
              </span>
            )}
          </button>
          <Switch
            checked={enabled}
            disabled={togglePending}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label={t('settings.contacts.enable.toggleAria')}
          />
        </div>
      </div>

      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl px-4 py-[14px]',
          'bg-[var(--settings-theme-card-bg)] border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              'bg-[var(--settings-input-bg)]',
            )}
          >
            <ShieldCheck size={18} className="text-[var(--settings-section-title)]" />
          </div>
          <div className="flex min-w-0 flex-col gap-[6px]">
            <p className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
              {t('settings.contacts.sync.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
              {t('settings.contacts.sync.description')}
            </p>
            <p
              className={cn(
                'text-12 leading-[1.4]',
                syncStatus?.phase === 'error'
                  ? 'text-[var(--settings-error-text)]'
                  : 'text-[var(--settings-section-desc)]',
              )}
            >
              {syncSummary}
              {syncStatus?.enabled && syncStatus.onlineDeviceCount > 0
                ? ` · ${t('settings.contacts.sync.onlineDevices', {
                    count: syncStatus.onlineDeviceCount,
                  })}`
                : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {syncStatus?.enabled && (
            <button
              type="button"
              onClick={() => void handleSyncNow()}
              disabled={syncPending || syncStatus.onlineDeviceCount === 0}
              className={cn(
                'flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-13 transition-colors',
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
                <RefreshCw size={13} />
              </span>
              {t('settings.contacts.sync.syncNow')}
            </button>
          )}
          <Switch
            checked={syncStatus?.enabled ?? false}
            disabled={syncPending || syncStatus === null || !syncStatus.available}
            onCheckedChange={(value) => void handleSyncToggle(value)}
            aria-label={t('settings.contacts.sync.toggleAria')}
          />
        </div>
      </div>

      {/* 唯一常驻入口：不按空库状态隐藏，空库可建库，非空库可继续补充与整理。 */}
      {enabled && (
        <div
          className={cn(
            'flex flex-col gap-2.5 rounded-xl px-4 py-3',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.contacts.guide.hint')}
          </p>
          <div>
            <button
              type="button"
              onClick={() => void startAiSession()}
              disabled={togglePending || aiSessionPending}
              className={cn(
                'flex shrink-0 select-none items-center gap-1.5 rounded-full px-6 py-2.5 text-13 font-medium transition-colors active:scale-[0.98]',
                'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] hover:opacity-90',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <Sparkles size={14} />
              {t('settings.contacts.guide.cta')}
            </button>
          </div>
        </div>
      )}

      {/* 管理浮层仍可复用同一个预填入口。 */}
      <ContactsManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        syncStatus={syncStatus}
        syncPending={syncPending}
        syncSummary={syncSummary}
        onSyncNow={() => void handleSyncNow()}
        {...(enabled ? { onAiOrganize: startAiSession } : {})}
      />
    </div>
  );
}
