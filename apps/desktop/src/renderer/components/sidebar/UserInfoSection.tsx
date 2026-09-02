import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  Check,
  Flame,
  Settings,
  Shield,
  Smartphone,
  UserPlus,
  UserRound,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useUpdateBannerDismiss } from '@/hooks/useUpdateBannerDismiss';
import { useBetaChannelSettings } from '@/hooks/useBetaChannelSettings';
import { Tip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import type { DesktopSavedAccount } from '@/lib/authService';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { shouldLabelRegion } from '../../../shared/regionCode';
import { MobileDownloadDialog } from './MobileDownloadDialog';

interface UserInfoSectionProps {
  isCollapsed: boolean;
  onOpenUpdateNotice?: () => void;
}

function AccountMenuAvatar({ account }: { account: DesktopSavedAccount }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = account.kind === 'org' ? account.orgLogoUrl : account.avatarUrl;

  useEffect(() => setImageFailed(false), [imageUrl]);

  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt=""
        className="h-7 w-7 shrink-0 rounded-full object-cover"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-hover)] text-[var(--text-secondary)]">
      {account.kind === 'org' ? (
        <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </span>
  );
}

export function UserInfoSection({ isCollapsed, onOpenUpdateNotice }: UserInfoSectionProps) {
  const { user, mode, dataOwnerId, isCanary, listAccounts, syncAccounts, switchAccount } =
    useAuth();
  const confirmDialog = useOptionalConfirmDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const [avatarError, setAvatarError] = useState(false);
  const [mobileDownloadOpen, setMobileDownloadOpen] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<DesktopSavedAccount[]>([]);
  const [savedAccountsOwnerKey, setSavedAccountsOwnerKey] = useState<string | null>(null);
  const [accountsMutationAllowed, setAccountsMutationAllowed] = useState(true);
  const [accountsSyncing, setAccountsSyncing] = useState(false);
  const [switchingAccountKey, setSwitchingAccountKey] = useState<string | null>(null);
  const mobileDownloadButtonRef = useRef<HTMLButtonElement>(null);
  const accountsLoadGenerationRef = useRef(0);
  const { t } = useTranslation();
  const accountsOwnerKey = mode === 'cloud' ? dataOwnerId : null;
  const accountsReadyForOwner = savedAccountsOwnerKey === accountsOwnerKey;

  // 火焰按钮双职责:
  // - 正常情况(无 pending update 或 banner 未 dismiss)→ 弹更新历史 Dialog。
  // - 有 pending update 且 banner 已被 dismiss → 涂黑 + 点击唤回 banner
  //   (更新历史入口暂时让位,banner 再次出现后关掉才会回到"历史入口"模式)。
  const { status } = useUpdateStatus();
  const { dismissed, restore } = useUpdateBannerDismiss();
  const { state: betaChannelState } = useBetaChannelSettings();
  const hasPendingUpdate = status === 'ready' || status === 'superseding';
  const isFlameReopen = hasPendingUpdate && dismissed;
  const showBetaLabel = !betaChannelState.loading && betaChannelState.enableBeta;

  // 头像地址变化(设置页改头像 / 服务端资料更新)时重置加载失败标记,
  // 让新地址有机会渲染,而不是永远停在首字母兜底。
  const isLocal = mode === 'local';
  const displayName = user?.name ?? (isLocal ? t('settings.userProfile.local.name') : '');
  const moreLabel = t('sidebar.user.moreLabel', { name: displayName });
  const avatarUrl = user?.avatar ?? null;
  useEffect(() => {
    setAvatarError(false);
  }, [avatarUrl]);

  // Account snapshots belong to the active data owner. Invalidate them as
  // soon as ownership changes so a reopened menu can never act on the prior
  // account while the fresh list is loading.
  useEffect(() => {
    accountsLoadGenerationRef.current += 1;
    setSavedAccountsOwnerKey(null);
    setSavedAccounts([]);
    setAccountsMutationAllowed(false);
    setAccountsSyncing(false);
    setSwitchingAccountKey(null);
  }, [accountsOwnerKey]);

  if (!user && !isLocal) return null;

  const initial = displayName.charAt(0).toUpperCase();
  // 未登录(跳过登录)态没有身份可展示:头像兜底用中性人形图标,而不是拿状态文案
  // 取首字——那会渲染成「未」/「N」这类无意义字符,且四语各不相同。
  const showNotSignedInGlyph = !user && isLocal;
  const appDisplayVersion = window.electronAPI.appDisplayVersion;
  const appDisplayVersionDetail = window.electronAPI.appDisplayVersionDetail;
  // 版本行的区域前缀。「哪些区域要标」只有 CINDY_REGION_CODE 一个事实源(issue
  // 反馈链路同源),口径见 DESIGN.md §16.3 与 region-and-editions.md §2.3:
  // cn → CN、dev → Dev、**global 不标**——Cindy 默认版本不给自己贴标签自证是全球版,
  // global 构建这一行只剩版本号。展示文案走 i18n(同 login.regionPill.* 的做法),
  // 便于日后改判为「中国大陆版」这类可译文案时不必回改组件;key 写成字面量分支而非
  // 动态拼接,保证 pnpm check:i18n 的静态提取能看到全部 key。一致性由
  // __tests__/regionCode.consistency.test.ts 逐区域逐语言断言。
  const appRegionLabel = !shouldLabelRegion(CURRENT_CINDY_REGION)
    ? null
    : CURRENT_CINDY_REGION === 'cn'
      ? t('sidebar.user.regionCodeCn')
      : t('sidebar.user.regionCodeDev');
  const appVersionLabel = appRegionLabel
    ? `${appRegionLabel} · ${appDisplayVersion}`
    : appDisplayVersion;
  const appVersionLabelDetail = appRegionLabel
    ? `${appRegionLabel} · ${appDisplayVersionDetail}`
    : appDisplayVersionDetail;
  const remoteAvailable = mode === 'cloud';

  const openSettings = () => {
    if (location.pathname !== '/settings') navigate('/settings');
  };

  const openAddAccount = async () => {
    if (!(await confirmRunningTaskInterruption())) return;
    navigate('/add-account', {
      state: { returnTo: `${location.pathname}${location.search}` },
    });
  };

  const refreshSavedAccounts = async () => {
    if (mode !== 'cloud') return;
    const generation = ++accountsLoadGenerationRef.current;
    setSavedAccountsOwnerKey(null);
    setSavedAccounts([]);
    setAccountsMutationAllowed(false);
    setAccountsSyncing(true);
    try {
      const initialSnapshot = await listAccounts();
      if (generation !== accountsLoadGenerationRef.current) return;
      setSavedAccounts(initialSnapshot.accounts);
      setAccountsMutationAllowed(initialSnapshot.mutationAllowed);
      setSavedAccountsOwnerKey(accountsOwnerKey);

      const syncedSnapshot = await syncAccounts();
      if (generation !== accountsLoadGenerationRef.current) return;
      setSavedAccounts(syncedSnapshot.accounts);
      setAccountsMutationAllowed(syncedSnapshot.mutationAllowed);
      setSavedAccountsOwnerKey(accountsOwnerKey);
    } catch {
      if (generation === accountsLoadGenerationRef.current) {
        toast.error(t('sidebar.accountSwitcher.syncFailed'));
      }
    } finally {
      if (generation === accountsLoadGenerationRef.current) setAccountsSyncing(false);
    }
  };

  const confirmRunningTaskInterruption = async (): Promise<boolean> => {
    const { makerChatStore } = await import('@/lib/makerChatStore');
    const hasRunningTask = [...makerChatStore.getRunningSnapshot().values()].some(
      (status) => status.isRunning,
    );
    if (!hasRunningTask) return true;
    if (!confirmDialog) return false;
    return confirmDialog.confirm({
      title: t('sidebar.accountSwitcher.runningTaskTitle'),
      description: t('sidebar.accountSwitcher.runningTaskDescription'),
      confirmText: t('sidebar.accountSwitcher.runningTaskConfirm'),
      cancelText: t('logic.confirm.cancel'),
      confirmVariant: 'destructive',
    });
  };

  const switchSavedAccount = async (account: DesktopSavedAccount) => {
    if (
      account.isCurrent ||
      switchingAccountKey ||
      !accountsMutationAllowed ||
      !accountsReadyForOwner
    )
      return;
    setSwitchingAccountKey(account.accountKey);
    try {
      if (!(await confirmRunningTaskInterruption())) return;
      await switchAccount(account.accountKey);
    } catch {
      toast.error(t('sidebar.accountSwitcher.switchFailed'));
    } finally {
      setSwitchingAccountKey(null);
    }
  };

  const renderSavedAccountItems = () => {
    const switchableAccounts = savedAccounts.filter((account) => !account.isCurrent);
    if (mode !== 'cloud' || !accountsReadyForOwner || switchableAccounts.length === 0) return null;

    return (
      <>
        {savedAccounts.map((account) => {
          const hasDistinctOrgName =
            account.kind === 'org' &&
            Boolean(account.orgName?.trim()) &&
            account.orgName !== account.displayName;
          const primaryLabel = hasDistinctOrgName ? account.orgName : account.displayName;
          const secondaryLabel =
            account.kind === 'org' && hasDistinctOrgName ? account.displayName : account.email;
          const switching = switchingAccountKey === account.accountKey;

          return (
            <DropdownMenuItem
              key={account.accountKey}
              disabled={
                account.isCurrent || switchingAccountKey !== null || !accountsMutationAllowed
              }
              onSelect={() => void switchSavedAccount(account)}
              className="gap-2.5 py-2"
            >
              <AccountMenuAvatar account={account} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-13 font-medium">{primaryLabel}</span>
                {secondaryLabel ? (
                  <span className="mt-0.5 block truncate text-11 text-[var(--text-secondary)]">
                    {secondaryLabel}
                  </span>
                ) : null}
              </span>
              {switching ? (
                <Spinner size={14} className="shrink-0 text-[var(--text-secondary)]" />
              ) : account.isCurrent ? (
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {accountsSyncing ? (
          <div className="px-2 py-1 text-11 text-[var(--text-secondary)]">
            {t('sidebar.accountSwitcher.syncing')}
          </div>
        ) : null}
      </>
    );
  };

  const renderMoreMenu = (trigger: ReactNode) => (
    <DropdownMenu onOpenChange={(open) => open && void refreshSavedAccounts()}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[190px]">
        {renderSavedAccountItems()}
        {mode === 'cloud' &&
        accountsReadyForOwner &&
        savedAccounts.some((account) => !account.isCurrent) ? (
          <DropdownMenuSeparator />
        ) : null}
        {mode === 'local' ? (
          <DropdownMenuItem onSelect={() => void openAddAccount()} className="gap-2.5">
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {t('sidebar.user.menuAddAccount')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={openSettings} className="gap-2.5">
          <Settings className="h-4 w-4" aria-hidden="true" />
          {t('sidebar.user.menuSettings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const openRemoteSettings = () => {
    setMobileDownloadOpen(false);
    navigate('/settings?tab=remote-control');
  };

  const openLinkedDevices = () => {
    setMobileDownloadOpen(false);
    navigate('/settings?tab=remote-control&section=devices');
  };

  const mobileDownloadEntry = (
    <Tip text={t('sidebar.user.downloadMobile')} side="right">
      <button
        ref={mobileDownloadButtonRef}
        type="button"
        onClick={() => setMobileDownloadOpen(true)}
        aria-label={t('sidebar.user.downloadMobile')}
        className={cn(
          'mobile-download-btn',
          'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full',
          !isCollapsed && 'mr-1',
          'border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)]',
          'text-[var(--sidebar-user-card-text)] transition-colors hover:bg-sidebar-item-hover',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        <Smartphone className="h-3 w-3" aria-hidden="true" />
      </button>
    </Tip>
  );

  if (isCollapsed) {
    return (
      <>
        <div className="mt-auto flex h-[66px] flex-col items-center justify-center gap-1 px-3">
          <Tip text={moreLabel} side="right">
            {renderMoreMenu(
              <button
                aria-label={moreLabel}
                className="flex min-w-0 items-center justify-center text-left"
              >
                <div className="relative h-9 w-9 shrink-0">
                  {user?.avatar && !avatarError ? (
                    <img
                      src={user.avatar}
                      alt={displayName}
                      className="h-9 w-9 rounded-full object-cover"
                      onError={() => setAvatarError(true)}
                    />
                  ) : (
                    <div
                      className={cn(
                        'flex h-9 w-9 items-center justify-center rounded-full',
                        'border border-sidebar-border bg-sidebar-item-hover text-base font-medium text-foreground',
                      )}
                    >
                      {showNotSignedInGlyph ? (
                        <UserRound aria-hidden="true" size={18} strokeWidth={1.75} />
                      ) : (
                        initial
                      )}
                    </div>
                  )}
                  {isCanary && (
                    <span
                      aria-label={t('sidebar.user.canaryBadge')}
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5',
                        'flex h-3 w-3 items-center justify-center rounded-full',
                        'bg-foreground text-background ring-2 ring-sidebar',
                      )}
                    >
                      <Shield size={8} strokeWidth={2.5} />
                    </span>
                  )}
                </div>
              </button>,
            )}
          </Tip>
          {mobileDownloadEntry}
        </div>
        <MobileDownloadDialog
          open={mobileDownloadOpen}
          onOpenChange={setMobileDownloadOpen}
          remoteAvailable={remoteAvailable}
          onOpenRemoteSettings={openRemoteSettings}
          onOpenDevices={openLinkedDevices}
          triggerRef={mobileDownloadButtonRef}
        />
      </>
    );
  }

  return (
    <div className="mt-auto px-3 pb-3 pt-2">
      {/* 胶囊整体承载 hover(方案 D):玻璃底色加深一档;悬停右侧操作按钮时用
        :has() 把胶囊底色还原,只让当前按钮高亮,避免双层叠色。 */}
      <div
        className={cn(
          'flex h-10 items-center rounded-full border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)] px-[7px]',
          'transition-colors hover:bg-[var(--sidebar-user-card-bg-hover)]',
          'has-[.flame-btn:hover]:bg-[var(--sidebar-user-card-bg)]',
          'has-[.mobile-download-btn:hover]:bg-[var(--sidebar-user-card-bg)]',
        )}
      >
        {renderMoreMenu(
          <button
            aria-label={moreLabel}
            className={cn('flex min-w-0 flex-1 items-center gap-[10px]', 'text-left')}
          >
            {/* Avatar — admin 用户加 1.5px 反色描边 + 右下角盾牌角标 */}
            <div
              className="relative h-[27px] w-[27px] shrink-0"
              title={isCanary ? t('sidebar.user.canaryBadge') : undefined}
            >
              {user?.avatar && !avatarError ? (
                <img
                  src={user.avatar}
                  alt={displayName}
                  className={cn('h-[27px] w-[27px] rounded-full object-cover')}
                  onError={() => setAvatarError(true)}
                />
              ) : (
                <div
                  className={cn(
                    'flex h-[27px] w-[27px] items-center justify-center rounded-full',
                    'border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)] text-14 font-medium text-[var(--sidebar-user-card-text)]',
                  )}
                >
                  {showNotSignedInGlyph ? (
                    <UserRound aria-hidden="true" size={15} strokeWidth={1.75} />
                  ) : (
                    initial
                  )}
                </div>
              )}
              {isCanary && (
                // ring-2 ring-sidebar 用 sidebar 背景色作为分隔环，避免角标和头像糊在一起
                <span
                  aria-label={t('sidebar.user.canaryBadge')}
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5',
                    'flex h-3 w-3 items-center justify-center rounded-full',
                    'bg-[var(--sidebar-user-card-text)] text-background ring-2 ring-sidebar',
                  )}
                >
                  <Shield size={8} strokeWidth={2.5} />
                </span>
              )}
            </div>

            {/* Name & plan — fade in/out with collapse。
            折叠 rail（64px）下必须整个移出布局（hidden）——flex-1 占位会把
            头像挤出 64px 可视区（旧 w-0 折叠时代 opacity 即可，rail 时代不行）。 */}
            <div
              className={cn(
                'flex min-w-0 flex-1 flex-col justify-center',
                'transition-opacity duration-200 ease-in-out',
                'opacity-100',
              )}
            >
              <p className="truncate text-14 font-semibold leading-[1.286] text-[var(--sidebar-user-card-text)]">
                {displayName}
              </p>
              {/* 2px gap 与同栏 userNameContainer 保持一致。 */}
              <p
                className="flex min-w-0 items-center gap-1 text-10 leading-[1.3] text-[var(--sidebar-user-card-text)]"
                title={appVersionLabelDetail}
              >
                <span className="truncate opacity-80">{appVersionLabel}</span>
                {showBetaLabel ? (
                  <span
                    className="shrink-0 select-none opacity-80"
                    data-testid="sidebar-beta-channel-label"
                  >
                    {t('settings.betaChannel.badge')}
                  </span>
                ) : null}
              </p>
            </div>
          </button>,
        )}

        {mobileDownloadEntry}

        {/* Flame icon button — 默认打开更新历史;banner 被 dismiss 且有 pending
          update 时切换为「唤回 banner」入口,视觉涂黑(fill 实心 + foreground 主色)
          告诉用户还有更新等待确认。rail 走上面的头像-only 分支,不会渲染这颗;
          busy 让路时折叠火焰才是最小化提醒,展开态才用这颗涂黑入口。 */}
        {(onOpenUpdateNotice || isFlameReopen) && (
          <Tip
            text={
              isFlameReopen
                ? t('sidebar.user.reopenUpdateBanner')
                : t('sidebar.user.viewReleaseNotes')
            }
            side="right"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isFlameReopen) {
                  restore();
                } else {
                  onOpenUpdateNotice?.();
                }
              }}
              aria-label={
                isFlameReopen
                  ? t('sidebar.user.reopenUpdateBanner')
                  : t('sidebar.user.viewReleaseNotes')
              }
              className={cn(
                'flame-btn',
                'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full',
                'border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)]',
                'transition-colors hover:bg-sidebar-item-hover',
                'transition-opacity duration-200 ease-in-out',
                'opacity-100',
              )}
            >
              <Flame
                className={cn(
                  'h-3 w-3',
                  isFlameReopen
                    ? 'fill-current text-[var(--sidebar-user-card-text)]'
                    : 'text-[var(--sidebar-user-card-text)]',
                )}
              />
            </button>
          </Tip>
        )}
      </div>

      <MobileDownloadDialog
        open={mobileDownloadOpen}
        onOpenChange={setMobileDownloadOpen}
        remoteAvailable={remoteAvailable}
        onOpenRemoteSettings={openRemoteSettings}
        onOpenDevices={openLinkedDevices}
        triggerRef={mobileDownloadButtonRef}
      />
    </div>
  );
}
