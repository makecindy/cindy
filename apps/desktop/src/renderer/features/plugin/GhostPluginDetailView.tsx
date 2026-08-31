/**
 * Plugin detail presentation for configuration, Tools, permissions, and factual metadata.
 *
 * Inputs: the renderer-safe Plugin detail model plus the installed Ghost when available.
 * Outputs: accessible detail interactions, a single-row responsive action hero, and the sticky
 * top bar that carries the back affordance plus this page's macOS window-drag region.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AppWindow,
  AlertTriangle,
  ArrowUp,
  Bot,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  MessageCircle,
  FileCode2,
  FilePen,
  FolderOpen,
  FolderPlus,
  Globe,
  GraduationCap,
  KeyRound,
  LayoutTemplate,
  Library,
  MapPin,
  Megaphone,
  MessageCircleQuestion,
  MoreVertical,
  PanelLeft,
  PanelRight,
  Radio,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CindyCapabilityPrefs } from '@/cindy-brain/CindyCapabilityPrefs';
import { GhostLibrarySection } from './GhostLibrarySection';
import { GhostErrandPrefs } from '@/cindy-brain/GhostErrandPrefs';
import { GhostSettingsWebview } from '@/cindy-brain/GhostSettingsWebview';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import {
  isOfficialGhostId,
  type GhostPermissionItem,
  type GhostToolDecl,
  type InstalledGhost,
} from '../../../shared/ghost';
import { type GhostPluginDetail } from './lib/ghostPluginViewModel';
import { GhostPluginIcon } from './GhostPluginIcon';
import { ghostPluginSummary } from './lib/ghostPluginDetailModel';
import { ghostPrimaryAction } from './lib/ghostPluginViewModel';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import './plugin-motion.css';

interface GhostPluginDetailViewProps {
  ghost: InstalledGhost | null;
  detail: GhostPluginDetail;
  panelStatus: string | null;
  enabledOverride?: boolean;
  onBack: () => void;
  onToggle: (enabled: boolean) => void;
  /** 主动作:面板型「使用」/ 指令或 Host 能力型「对话」;纯工具型不渲染主按钮。 */
  onUse: () => void;
  /** main-view 入口偏好只影响侧边栏，不改变插件启用态或路由资格。 */
  mainViewSidebarVisible?: boolean;
  onMainViewSidebarVisibleChange?: (visible: boolean) => void;
  /** 头部更新 CTA:市场有新版本时走市场更新确认流。 */
  onUpdate: () => void;
  /**
   * 安装记录缺失或损坏时的恢复入口。可选:仅插件页宿主注入；未注入时按钮不出现，
   * 门控见下方 `needsReapproval && !detail.builtin && onReapprove`。
   */
  onReapprove?: () => void;
  /** ⋮ 菜单的兜底路径:从本地 .cindy 文件更新。 */
  onUpdateFromFile: () => void;
  /** 市场存在新版本时的目标版本号;设置后头部展示显著的更新按钮。 */
  updateVersion?: string;
  updateBusy?: boolean;
  onUninstall: () => void;
  /** 导出 .cindy;当前详情非已装插件(纯市场视图)时缺省,菜单项不渲染。 */
  onExport?: () => void;
  toggleDisabled: boolean;
  onIconLoadError?: () => void;
}

const PERMISSION_ICON: Record<GhostPermissionItem['kind'], LucideIcon> = {
  cindy: Sparkles,
  agent: Bot,
  node: Cpu,
  tool: Wrench,
  command: Terminal,
  panel: PanelRight,
  'main-view': AppWindow,
  code: FileCode2,
  subscribe: Radio,
  card: LayoutTemplate,
  network: Globe,
  notify: Megaphone,
  confirm: MessageCircleQuestion,
  fs: FilePen,
  library: Library,
  'session-context': MapPin,
  pick: FolderOpen,
  preview: AppWindow,
  skill: GraduationCap,
  'ios-simulator': Smartphone,
  workspace: FolderPlus,
};

/** Chooses a visual affordance without changing the host-owned permission title or meaning. */
function permissionItemIcon(item: GhostPermissionItem): LucideIcon {
  if (item.labelKey === 'panelLeft') return PanelLeft;
  if (
    item.labelKey === 'networkSecret' ||
    item.labelKey === 'networkSecretOauth' ||
    item.labelKey === 'networkSecretGhCli' ||
    item.labelKey === 'networkSecretIdentity'
  ) {
    return KeyRound;
  }
  return PERMISSION_ICON[item.kind];
}

const DETAIL_SECTION_CLASS = 'mt-10';
const DETAIL_SECTION_HEADING_CLASS =
  'text-18 font-medium leading-[1.444] text-[var(--text-primary)]';
const DETAIL_SECTION_CONTENT_CLASS = 'mt-5 max-w-[760px]';
const DETAIL_SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';
const DETAIL_SURFACE_INTERACTIVE_CLASS =
  'transition-[background-color,border-color,transform] duration-150 hover:border-[var(--border-default)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_96%,var(--surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:scale-[0.99]';

/** Installed Ghost detail surface, ordered around configuration and capability review. */
export function GhostPluginDetailView({
  ghost,
  detail,
  panelStatus,
  enabledOverride,
  onBack,
  onToggle,
  onUse,
  mainViewSidebarVisible = true,
  onMainViewSidebarVisibleChange,
  onUpdate,
  onReapprove,
  onUpdateFromFile,
  updateVersion,
  updateBusy = false,
  onUninstall,
  onExport,
  toggleDisabled,
  onIconLoadError,
}: GhostPluginDetailViewProps) {
  const { t } = useTranslation();
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionOverflows, setDescriptionOverflows] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  // 安装记录不完整时不可运行:enabled 直接门控为 false(说明现状 + 给恢复入口,不让它
  // 看起来只是"被关掉了"),再喂 main 改版的 primaryAction/primaryEnabled。
  const needsReapproval = detail.approvalState !== 'approved';
  const enabled = (enabledOverride ?? detail.enabled) && !needsReapproval;
  const primaryAction = ghostPrimaryAction(detail);
  const primaryEnabled =
    enabled &&
    (primaryAction === 'panel' ||
      primaryAction === 'capability' ||
      (primaryAction === 'command' && detail.canUse));
  const cindyCapabilities = detail.cindyCapabilities;
  const hasConfiguration =
    detail.hasMainView || detail.hasSettingsUi || cindyCapabilities.length > 0 || detail.hasErrand;
  const summary = ghostPluginSummary(detail.description, detail.id);
  /**
   * 「从 .cindy 文件更新」是否可用。官方保留前缀(cindy- / filo- / xd-)在**非 dev
   * 构建**上会被 Main 的用户装入通道以 GHOST_ID_RESERVED 直接拒绝(见
   * main/cindy-brain/index.ts 的 rejectReservedGhostId),把这个必失败的动作摆在
   * 菜单里只会让用户选文件、等一下、然后吃一个错误。
   *
   * 判据用 `import.meta.env.DEV` 而不是新开一条 IPC 去问 app.isPackaged:打包产物
   * 必然 DEV=false,覆盖 Main 拒绝的全部场景;唯一偏差是「本地 build 但未打包运行」
   * 会多隐藏一次入口——方向保守(少一个入口 vs 给用户一个必失败按钮),可接受。
   * 普通第三方插件不受影响。
   */
  const localUpdateAvailable = import.meta.env.DEV || !isOfficialGhostId(detail.id);
  const hasAdditionalActions = localUpdateAvailable || onExport !== undefined;

  useLayoutEffect(() => {
    setDescriptionExpanded(false);
    const description = descriptionRef.current;
    if (!description) return;
    const measure = () => {
      const computedStyle = window.getComputedStyle(description);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight);
      const width = description.getBoundingClientRect().width;
      if (!Number.isFinite(lineHeight) || width <= 0) {
        setDescriptionOverflows(false);
        return;
      }

      // Chromium reports the clamped element's scrollHeight as the visible height.
      // Measure an unclamped, off-screen clone so the affordance only appears when
      // the complete description genuinely exceeds three lines.
      const measurement = description.cloneNode(true) as HTMLParagraphElement;
      measurement.classList.remove('line-clamp-3');
      Object.assign(measurement.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: `${width}px`,
        height: 'auto',
        maxHeight: 'none',
        overflow: 'visible',
        visibility: 'hidden',
        pointerEvents: 'none',
        WebkitLineClamp: 'unset',
        WebkitBoxOrient: 'initial',
      });
      document.body.appendChild(measurement);
      const fullHeight = measurement.getBoundingClientRect().height;
      measurement.remove();
      setDescriptionOverflows(fullHeight > lineHeight * 3 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(description);
    return () => observer.disconnect();
  }, [detail.id, summary]);

  return (
    <main
      className="plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]"
      onScroll={onScroll}
    >
      <PluginDetailTopBar
        label={t('settings.ghosts.detail.backToList')}
        onBack={onBack}
        scrolled={scrolled}
      />
      <article className="plugin-detail-frame mx-auto w-full max-w-[824px] px-8 pb-16 pt-5 max-[760px]:px-6">
        <header>
          <div className="plugin-detail-hero grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3">
            <GhostPluginIcon
              iconDataUrl={detail.iconDataUrl}
              iconId={detail.id}
              iconName={detail.name}
              size="detail"
              onIconLoadError={onIconLoadError}
            />
            <div className="min-w-0">
              <h1 className="truncate text-28 font-medium leading-[1.214] text-[var(--text-primary)]">
                {detail.name}
              </h1>
              <GhostPluginMetadata author={detail.author} version={detail.version} />
            </div>

            <div
              className="plugin-detail-actions flex shrink-0 flex-nowrap items-center gap-1.5"
              style={WINDOW_NO_DRAG_STYLE}
            >
              {needsReapproval && !detail.builtin && onReapprove ? (
                <button
                  type="button"
                  onClick={onReapprove}
                  disabled={updateBusy}
                  className={cn(
                    'inline-flex h-10 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 text-13 font-medium text-[var(--text-primary)]',
                    'transition-[background-color,border-color,transform,opacity] duration-150 hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    'disabled:cursor-wait disabled:opacity-40 disabled:active:scale-100',
                  )}
                >
                  {t('settings.ghosts.reapproval.action')}
                </button>
              ) : updateVersion ? (
                // 更新提级(设计定稿):有新版本时黑色主 CTA 直达市场更新确认流。
                <button
                  type="button"
                  onClick={onUpdate}
                  disabled={updateBusy}
                  aria-label={
                    updateVersion === detail.version
                      ? t('settings.ghosts.market.update')
                      : t('settings.ghosts.market.updateTo', { version: updateVersion })
                  }
                  aria-busy={updateBusy || undefined}
                  className={cn(
                    'inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-5 text-13 font-medium',
                    'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
                    'transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--accent-hover)] active:scale-[0.98]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    'disabled:cursor-wait disabled:opacity-60 disabled:active:scale-100',
                  )}
                >
                  {updateBusy ? (
                    <Spinner size={14} />
                  ) : (
                    <>
                      <ArrowUp size={14} aria-hidden="true" />
                      {updateVersion === detail.version
                        ? t('settings.ghosts.market.update')
                        : t('settings.ghosts.market.updateTo', { version: updateVersion })}
                    </>
                  )}
                </button>
              ) : null}
              {primaryAction !== 'manage' ? (
                <button
                  type="button"
                  onClick={onUse}
                  disabled={!primaryEnabled}
                  title={!enabled ? t('settings.ghosts.detail.useDisabled') : undefined}
                  className={cn(
                    'plugin-detail-primary-action inline-flex h-10 min-w-[88px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-13 font-medium',
                    updateVersion
                      ? 'border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)]'
                      : 'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] hover:bg-[var(--accent-hover)]',
                    'transition-[background-color,transform,opacity] duration-150 active:scale-[0.98]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
                  )}
                >
                  {primaryAction === 'command' || primaryAction === 'capability' ? (
                    <MessageCircle size={14} aria-hidden="true" />
                  ) : null}
                  {t(
                    primaryAction === 'panel'
                      ? 'settings.ghosts.detail.useAction'
                      : 'settings.ghosts.detail.chatAction',
                  )}
                </button>
              ) : null}
              {/* 启用开关带明确文字(设计定稿):状态一目了然,点文字同样可切换。 */}
              <button
                type="button"
                role="switch"
                onClick={() => {
                  // 未批准的安装不可切换启用(点了 Main 也会拒);与 updateBusy 同级门控。
                  if (!toggleDisabled && !needsReapproval) onToggle(!enabled);
                }}
                disabled={toggleDisabled || needsReapproval}
                aria-checked={enabled}
                aria-label={t('settings.ghosts.enableAria', { name: detail.name })}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-full py-1 pl-3 pr-1 transition-colors duration-150',
                  'hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                <span
                  className={cn(
                    'text-12',
                    enabled ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
                  )}
                >
                  {t(
                    enabled
                      ? 'settings.ghosts.detail.enabledLabel'
                      : 'settings.ghosts.detail.disabledLabel',
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
                    enabled
                      ? 'bg-[var(--switch-track-on)]'
                      : 'bg-[var(--switch-track-off)]',
                  )}
                >
                  <span
                    className={cn(
                      'block h-4 w-4 rounded-full ring-0 transition-transform',
                      enabled
                        ? 'translate-x-4 bg-background'
                        : 'translate-x-0 bg-[var(--switch-thumb-off)]',
                    )}
                  />
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('settings.ghosts.detail.moreActions')}
                    className="grid size-10 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] data-[state=open]:bg-[var(--surface-chip)]"
                  >
                    <MoreVertical size={18} aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={8}
                  className="w-56 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
                >
                  {localUpdateAvailable ? (
                    <DropdownMenuItem
                      onSelect={onUpdateFromFile}
                      disabled={updateBusy}
                      className="h-10 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)]"
                    >
                      {t('settings.ghosts.detail.updateFromFile')}
                    </DropdownMenuItem>
                  ) : null}
                  {onExport ? (
                    <DropdownMenuItem
                      onSelect={onExport}
                      className="h-10 gap-2.5 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)]"
                    >
                      <Download size={15} aria-hidden="true" />
                      {t('settings.ghosts.detail.exportPackage')}
                    </DropdownMenuItem>
                  ) : null}
                  {hasAdditionalActions ? (
                    <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
                  ) : null}
                  <DropdownMenuItem
                    onSelect={onUninstall}
                    className="h-10 gap-2.5 rounded-lg px-3 text-13 text-[var(--error-fg)] focus:bg-[var(--error-bg)] focus:text-[var(--error-fg-strong)]"
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    {t('settings.ghosts.uninstall')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="mt-5">
            <p
              ref={descriptionRef}
              className={cn(
                'text-14 leading-[1.571] text-[var(--text-secondary)]',
                !descriptionExpanded && 'line-clamp-3',
              )}
            >
              {summary}
            </p>
            {descriptionOverflows ? (
              <button
                type="button"
                onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                aria-expanded={descriptionExpanded}
                className="mt-1.5 rounded-full text-13 leading-5 text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                {t(
                  descriptionExpanded
                    ? 'settings.ghosts.detail.descriptionCollapse'
                    : 'settings.ghosts.detail.descriptionExpand',
                )}
              </button>
            ) : null}
          </div>

          {needsReapproval ? (
            <div className={cn('mt-5 rounded-xl px-4 py-3.5', DETAIL_SURFACE_CLASS)} role="status">
              <p className="text-13 font-medium text-[var(--text-primary)]">
                {t('settings.ghosts.reapproval.noticeTitle')}
              </p>
              <p className="mt-1 text-13 leading-5 text-[var(--text-secondary)]">
                {t(
                  detail.builtin
                    ? 'settings.ghosts.reapproval.bodyBuiltinRestart'
                    : detail.approvalState === 'invalid'
                      ? 'settings.ghosts.reapproval.bodyInvalid'
                      : 'settings.ghosts.reapproval.bodyLegacy',
                )}
              </p>
            </div>
          ) : null}
        </header>

        {hasConfiguration ? (
          <section className={DETAIL_SECTION_CLASS} aria-labelledby="ghost-configuration-title">
            <DetailSectionHeader
              id="ghost-configuration-title"
              title={t('settings.ghosts.detail.configurationTitle')}
            />
            <div className={cn(DETAIL_SECTION_CONTENT_CLASS, 'space-y-3')}>
              {detail.hasMainView ? (
                <div
                  className={cn(
                    DETAIL_SURFACE_CLASS,
                    'flex min-h-20 items-center gap-3 rounded-xl px-5 py-4',
                  )}
                >
                  <AppWindow
                    size={18}
                    className="shrink-0 text-[var(--text-tertiary)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                      {t('settings.ghosts.detail.sidebarEntryTitle')}
                    </p>
                    <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
                      {t('settings.ghosts.detail.sidebarEntryDescription', {
                        title: detail.mainViewTitle ?? detail.name,
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={mainViewSidebarVisible}
                    onCheckedChange={onMainViewSidebarVisibleChange}
                    aria-label={t('settings.ghosts.detail.showInSidebar')}
                  />
                </div>
              ) : null}
              {detail.hasSettingsUi ? (
                ghost ? (
                  <>
                    {ghost.oauthScopeStale ? <OauthScopeStaleBadge /> : null}
                    <GhostSettingsWebview
                      ghost={ghost}
                      title={t('settings.ghosts.detail.settingsTitle', { name: detail.name })}
                      appearance="plugin"
                    />
                  </>
                ) : (
                  <div
                    className={cn(
                      DETAIL_SURFACE_CLASS,
                      'flex min-h-20 items-center gap-3 rounded-xl px-5 py-4',
                    )}
                  >
                    <LayoutTemplate
                      size={18}
                      className="shrink-0 text-[var(--text-tertiary)]"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                        {t('settings.ghosts.detail.settingsTitle', { name: detail.name })}
                      </p>
                      <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
                        {t('settings.ghosts.detail.settingsUnavailableUntilRestore')}
                      </p>
                    </div>
                  </div>
                )
              ) : null}
              {cindyCapabilities.length > 0 ? (
                <CindyCapabilityPrefs
                  ghostId={detail.id}
                  capabilities={cindyCapabilities}
                  appearance="plugin"
                />
              ) : null}
              {detail.hasErrand ? (
                <GhostErrandPrefs ghostId={detail.id} appearance="plugin" />
              ) : null}
            </div>
          </section>
        ) : null}

        {detail.tools.length > 0 ? <ToolsSection tools={detail.tools} /> : null}

        {detail.permissions.length > 0 ? <PermissionSummary items={detail.permissions} /> : null}

        <GhostLibrarySection ghostId={detail.id} enabled={ghost?.manifest.library === true} />

        <DetailsSection detail={detail} panelStatus={panelStatus} />
      </article>
    </main>
  );
}

/** 宿主侧非阻塞角标；重新连接动作继续复用插件设置区已有入口。 */
export function OauthScopeStaleBadge() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full bg-[var(--warning-bg-soft)] px-3 py-1.5 text-12 leading-5 text-[var(--text-secondary)]"
    >
      <AlertTriangle size={13} className="shrink-0 text-[var(--warning-fg)]" aria-hidden="true" />
      <span>{t('settings.ghosts.detail.oauthScopeStale')}</span>
    </div>
  );
}

/** Compact factual metadata with one shared color and stable product order. */
export function GhostPluginMetadata({
  author,
  version,
}: {
  author?: string | null;
  version: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="plugin-detail-metadata mt-2 flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden whitespace-nowrap text-13 leading-5 text-[var(--text-tertiary)]">
      {author ? (
        <>
          <span className="min-w-0 truncate">
            {t('settings.ghosts.detail.byAuthor', { author })}
          </span>
          <MetadataDivider />
        </>
      ) : null}
      <span className="shrink-0">v{version}</span>
    </div>
  );
}

function MetadataDivider() {
  return (
    <span className="shrink-0" aria-hidden="true">
      ·
    </span>
  );
}

function DetailSectionHeader({
  id,
  title,
  action,
}: {
  id: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[26px] items-center justify-between gap-4">
      <h2 id={id} className={DETAIL_SECTION_HEADING_CLASS}>
        {title}
      </h2>
      {action}
    </div>
  );
}

function SectionTextAction({
  expanded,
  onClick,
  children,
}: {
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className="shrink-0 rounded-md px-1 py-0.5 text-13 text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      {children}
    </button>
  );
}

export function ToolsSection({ tools }: { tools: readonly GhostToolDecl[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const canExpand = tools.length > 6;
  return (
    <section className={DETAIL_SECTION_CLASS} aria-labelledby="ghost-tools-title">
      <DetailSectionHeader
        id="ghost-tools-title"
        title={t('settings.ghosts.detail.toolsTitle')}
        action={
          canExpand ? (
            <SectionTextAction expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {t(
                expanded
                  ? 'settings.ghosts.detail.collapseTools'
                  : 'settings.ghosts.detail.viewAllTools',
              )}
            </SectionTextAction>
          ) : undefined
        }
      />
      <div
        className={cn(
          DETAIL_SECTION_CONTENT_CLASS,
          'flex flex-wrap gap-2',
          !expanded && canExpand && 'max-h-8 overflow-hidden',
        )}
      >
        {tools.map((tool) => (
          <ToolDescriptionChip key={tool.name} tool={tool} />
        ))}
      </div>
    </section>
  );
}

/** A Tool exposes only its author-provided description after explicit activation. */
export function ToolDescriptionChip({ tool }: { tool: GhostToolDecl }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('settings.ghosts.detail.openTool', { name: tool.name })}
          className={cn(
            DETAIL_SURFACE_CLASS,
            DETAIL_SURFACE_INTERACTIVE_CLASS,
            'inline-flex h-8 max-w-full items-center rounded-full px-3 text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          <code className="truncate font-mono text-13 leading-[1.385]">{tool.name}</code>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className={cn(
          DETAIL_SURFACE_CLASS,
          'z-[10000] w-[320px] rounded-xl p-4 text-[var(--text-primary)] shadow-[var(--shadow-menu)] data-[state=open]:animate-none data-[state=closed]:animate-none',
        )}
      >
        <p className="text-13 leading-5 text-[var(--text-secondary)]">
          {tool.description || t('settings.ghosts.detail.noToolDescription')}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function PermissionSummary({ items }: { items: readonly GhostPermissionItem[] }) {
  const { t } = useTranslation();
  const permissionItems = items.filter((item) => item.kind !== 'tool');
  const [dialogOpen, setDialogOpen] = useState(false);
  if (permissionItems.length === 0) return null;
  const permissionCardLabel = `${t('settings.ghosts.detail.permissionsTitle')}: ${permissionItems
    .map((item) => t(`settings.ghosts.perm.${item.labelKey}`, item.labelArgs))
    .join(', ')}`;
  return (
    <section className={DETAIL_SECTION_CLASS} aria-labelledby="ghost-permissions-title">
      <DetailSectionHeader
        id="ghost-permissions-title"
        title={t('settings.ghosts.detail.permissionsTitle')}
        action={
          <SectionTextAction onClick={() => setDialogOpen(true)}>
            {t('settings.ghosts.detail.viewAllPermissions')}
          </SectionTextAction>
        }
      />
      <button
        type="button"
        aria-label={permissionCardLabel}
        onClick={() => setDialogOpen(true)}
        className={cn(
          DETAIL_SURFACE_CLASS,
          DETAIL_SURFACE_INTERACTIVE_CLASS,
          DETAIL_SECTION_CONTENT_CLASS,
          'grid w-full grid-cols-2 gap-x-8 gap-y-0 rounded-xl p-4 text-left',
        )}
      >
        {permissionItems.map((item) => {
          const Icon = permissionItemIcon(item);
          return (
            <span
              key={item.key}
              className="flex min-h-9 min-w-0 items-center gap-2.5 text-[var(--text-primary)]"
            >
              <Icon
                size={20}
                strokeWidth={1.8}
                className="shrink-0 text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words text-13 font-normal leading-5">
                {t(`settings.ghosts.perm.${item.labelKey}`, item.labelArgs)}
              </span>
            </span>
          );
        })}
      </button>
      <PermissionDetailDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        items={permissionItems}
      />
    </section>
  );
}

function PermissionDetailRow({ item }: { item: GhostPermissionItem }) {
  const { t } = useTranslation();
  const Icon = permissionItemIcon(item);
  const hostDescription = item.detailKey
    ? t(`settings.ghosts.perm.${item.detailKey}`, item.detailArgs)
    : null;
  return (
    <div className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
      <Icon
        size={18}
        strokeWidth={1.8}
        className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="break-words text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
          {t(`settings.ghosts.perm.${item.labelKey}`, item.labelArgs)}
        </p>
        {hostDescription ? (
          <p className="mt-1 whitespace-pre-line break-words text-13 leading-5 text-[var(--text-secondary)]">
            {hostDescription}
          </p>
        ) : null}
        {item.detail ? (
          <p className="mt-1 whitespace-pre-line break-words text-13 leading-5 text-[var(--text-secondary)]">
            {item.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function DetailsSection({
  detail,
  panelStatus,
}: {
  detail: GhostPluginDetail;
  panelStatus: string | null;
}) {
  const { t } = useTranslation();
  const trustLabelKey =
    detail.trust.level === 'cindy-official'
      ? 'official'
      : detail.trust.level === 'reviewed'
        ? 'reviewed'
        : detail.trust.level === 'verified-publisher'
          ? 'verifiedPublisher'
          : detail.trust.publisherSigned
            ? 'signedUnverified'
            : 'unsigned';
  const facts: Array<{
    key: string;
    label: string;
    value: string;
    monospace?: boolean;
    action?: ReactNode;
    fullWidth?: boolean;
  }> = [
    {
      key: 'version',
      label: t('settings.ghosts.detail.infoVersion'),
      value: `v${detail.version}`,
    },
    ...(detail.author
      ? [
          {
            key: 'author',
            label: t('settings.ghosts.detail.infoAuthor'),
            value: detail.author,
          },
        ]
      : []),
    {
      key: 'trust',
      label: t('settings.ghosts.detail.infoTrust'),
      value: t(`settings.ghosts.trust.${trustLabelKey}`, {
        publisher: detail.trust.publisherName ?? t('settings.ghosts.trust.unknownPublisher'),
      }),
    },
    {
      key: 'identifier',
      label: t('settings.ghosts.detail.infoId'),
      value: detail.id,
      monospace: true,
    },
    ...(detail.contents.length > 0
      ? [
          {
            key: 'contents',
            label: t('settings.ghosts.detail.infoContents'),
            value: detail.contents
              .map((content) => t(`settings.ghosts.contents.${content}`))
              .join(' · '),
          },
        ]
      : []),
    {
      key: 'panel',
      label: t('settings.ghosts.detail.infoPanel'),
      value:
        detail.panelMinWidth === null
          ? t('settings.ghosts.detail.panelNone')
          : panelStatus || t('settings.ghosts.detail.panelNotDocked'),
    },
    ...(detail.installDir
      ? [
          {
            key: 'location',
            label: t('settings.ghosts.detail.infoLocation'),
            value: detail.installDir,
            fullWidth: true,
            action: (
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(detail.installDir ?? '').then(
                      () => toast.success(t('settings.ghosts.detail.locationCopied')),
                      () => toast.error(t('settings.ghosts.detail.locationCopyFailed')),
                    );
                  }}
                  title={t('settings.ghosts.detail.copyLocation')}
                  aria-label={t('settings.ghosts.detail.copyLocation')}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const installDir = detail.installDir;
                    if (!installDir) return;
                    void window.electronAPI.openPath(installDir).then(
                      (result) => {
                        if (!result.success) toast.error(t('settings.ghosts.errors.generic'));
                      },
                      () => toast.error(t('settings.ghosts.errors.generic')),
                    );
                  }}
                  title={t('settings.ghosts.detail.openLocation')}
                  aria-label={t('settings.ghosts.detail.openLocation')}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <FolderOpen size={14} aria-hidden="true" />
                </button>
              </div>
            ),
          },
        ]
      : []),
  ];
  return (
    <section className={DETAIL_SECTION_CLASS} aria-labelledby="ghost-details-title">
      <DetailSectionHeader id="ghost-details-title" title={t('settings.ghosts.detail.infoTitle')} />
      <div className={cn(DETAIL_SECTION_CONTENT_CLASS, 'grid grid-cols-3 gap-x-10 gap-y-7')}>
        {facts.map((fact) => (
          <div key={fact.key} className={cn('min-w-0', fact.fullWidth && 'col-span-full')}>
            <p className="truncate text-13 leading-5 text-[var(--text-secondary)]">{fact.label}</p>
            <ExpandableDetailValue
              label={fact.label}
              value={fact.value}
              monospace={fact.monospace}
              action={fact.action}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** One-line fact value that reveals its complete text in place only when it overflows. */
function ExpandableDetailValue({
  label,
  value,
  monospace,
  action,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const valueRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    if (expanded) return;
    const valueElement = valueRef.current;
    if (!valueElement) return;
    const measure = () => {
      setOverflows(valueElement.scrollWidth > valueElement.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(valueElement);
    return () => observer.disconnect();
  }, [expanded, value]);

  const toggleLabel = t(
    expanded
      ? 'settings.ghosts.detail.collapseInfoValue'
      : 'settings.ghosts.detail.expandInfoValue',
    { label },
  );

  return (
    <div className="mt-0.5 flex min-w-0 items-start gap-1">
      <div
        ref={valueRef}
        className={cn(
          'min-w-0 flex-1 text-14 leading-[1.571] text-[var(--text-primary)]',
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-nowrap',
          monospace && 'font-mono text-13',
        )}
        title={!expanded ? value : undefined}
      >
        {value}
      </div>
      {action}
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ChevronDown
            size={15}
            strokeWidth={1.7}
            className={cn('transition-transform duration-150', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
}

function DialogFrame({ children }: { children: ReactNode }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay
        className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
        style={WINDOW_NO_DRAG_STYLE}
      />
      <Dialog.Content
        className="fixed left-1/2 top-1/2 z-[10000] flex max-h-[70vh] w-[calc(100vw-48px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none"
        style={WINDOW_NO_DRAG_STYLE}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function DialogCloseButton() {
  const { t } = useTranslation();
  return (
    <Dialog.Close
      aria-label={t('settings.ghosts.detail.closeDialog')}
      className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <X size={17} aria-hidden="true" />
    </Dialog.Close>
  );
}

/** Complete non-Tool permission inventory with host- and manifest-provided descriptions. */
function PermissionDetailDialog({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly GhostPermissionItem[];
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <DialogFrame>
        <div className="flex items-start gap-4 border-b-[0.5px] border-[var(--border-default)] px-6 py-5">
          <div className="min-w-0 flex-1">
            <Dialog.Title className="text-18 font-medium">
              {t('settings.ghosts.detail.permissionsTitle')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-13 leading-5 text-[var(--text-tertiary)]">
              {t('settings.ghosts.detail.permissionsDialogDescription', {
                count: items.length,
              })}
            </Dialog.Description>
          </div>
          <DialogCloseButton />
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <div className="divide-y-[0.5px] divide-[var(--border-default)]">
            {items.map((item) => (
              <PermissionDetailRow key={item.key} item={item} />
            ))}
          </div>
        </div>
      </DialogFrame>
    </Dialog.Root>
  );
}
