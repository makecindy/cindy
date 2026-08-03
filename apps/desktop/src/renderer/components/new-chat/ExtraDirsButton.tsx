/**
 * ExtraDirsButton —— composer 的「+」操作菜单(左置于权限选择器之前)。
 *
 * 合并了五类入口(参考 Codex 的 + 菜单):
 *   - 添加文件、图片或视频→ 复用 composer 既有附件管线。
 *   - 新建目标(`onNewGoal` 提供时显示;仅会话中,父组件按 sessionId 决定)→ 打开 NewGoalDialog。
 *   - 计划模式 / 协同模式→ 与新建目标同级的模式入口。
 *   - 已安装 Plugin:选择后由 ChatInput 把 command 放到消息开头,保留正文并聚焦末尾。
 *   - 附加只读引用目录(Claude vendor;`onChange` 提供时显示)→ 列表 / 添加。
 *
 * 创建时和 session 中途共用同一组件:父组件传 onChange 决定目录持久化路径:
 *   - 创建时(NewMakerDraftRoute):写 newMakerDraft store
 *   - 中途(CCAgentSessionView):同步调 sessionService.update + window.electronAPI.maker.setExtraDirs
 *
 * 视觉:trigger 是一个「+」(rounded-full / 14px 图标),有引用目录时带 ×N 角标。
 * Popover 列出新建目标项 + 引用目录段(可单条删除)+ "添加目录"。
 *
 * 校验:选中路径与 workingDir 重叠时:子目录静默去重;父目录弹 confirm。
 * main 端 extraDirsValidator.ts 兜底 — 这里只做 UX 预判。
 */

import { useRef, useState } from 'react';
import {
  Check,
  ClipboardList,
  FolderPlus,
  Paperclip,
  Plus,
  Target,
  UsersRound,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { MorphPopover } from '@/components/ui/morph-popover';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { createLogger } from '@/lib/logger';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import { stripTrailingPathSeparators } from '../../../shared/pathText';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import type { InstalledGhost } from '../../../shared/ghost';

const log = createLogger('ExtraDirsButton');

/** 与 main 端 EXTRA_DIRS_MAX 保持一致;UI 满了 disable 添加按钮。 */
const MAX_EXTRA_DIRS = 10;

export type CollabWorkerKind = 'cc' | 'codex' | 'pi';

export interface CollaborationMenuConfig {
  enabled: boolean;
  worker: CollabWorkerKind;
  onChange: (next: { enabled: boolean; worker: CollabWorkerKind }) => void;
  /** 关闭态优先打开完整 Worker 配置;未提供时直接沿用当前 worker 开启。 */
  onOpenDetails?: () => void;
  /** 策略暂不可用时允许从菜单项触发刷新。 */
  onDisabledActivate?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export interface ExtraDirsButtonProps {
  extraDirs: string[];
  workingDir?: string | null;
  /** 选择本机文件后交给 composer 的既有附件校验、缓存与发送管线。 */
  onAddFiles?: (files: readonly File[]) => void | Promise<void>;
  /**
   * 父组件实现增删持久化(创建时写 draft store / 中途双 IPC 协调)。
   * 未提供时只显示目标、计划模式或 Plugin 入口，不显示引用目录段。
   */
  onChange?: (next: string[]) => void | Promise<void>;
  /** 提供时在菜单顶部显示「新建目标」项(仅会话中;点击 → 父组件打开 NewGoalDialog)。 */
  onNewGoal?: () => void;
  /**
   * 计划模式 toggle(与「新建目标」同级的一级入口)。提供时显示菜单项;
   * 父组件负责能力门控(capabilities.planMode)与持久化,这里只做 UI。
   */
  planMode?: { enabled: boolean; onToggle: (next: boolean) => void };
  /** 协同模式入口;与新建目标、计划模式同级显示在「+」菜单。 */
  collaboration?: CollaborationMenuConfig;
  /** 已安装 Plugin 清单;无指令或未生效项仍展示,但不可选。 */
  plugins?: readonly InstalledGhost[];
  /** 当前会话范围内可直接使用的 Plugin id;未命中项保留展示但置灰。 */
  pluginAvailableIds?: ReadonlySet<string>;
  /** 选择后由 ChatInput 把 Plugin command 放到正文开头并把光标落到全文末尾。 */
  onPluginSelect?: (ghost: InstalledGhost) => void;
  disabled?: boolean;
  /** 窄容器下把 trigger 字号/图标各压一档,默认 false。 */
  dense?: boolean;
  /** CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。 */
  visualVariant?: 'default' | 'create-agent';
}

function normalizedPathForComparison(raw: string | null | undefined): string | null {
  const normalized = normalizeWorkingDirForStorage(raw);
  return normalized ? stripTrailingPathSeparators(normalized) : null;
}

/**
 * 判断 candidate 是否是 base 自身或子目录(简单字符串前缀,跨平台够用 —— main 端
 * extraDirsValidator 用 path.relative 做权威判定)。
 */
function isSelfOrSubdir(candidate: string, base: string): boolean {
  const c = normalizedPathForComparison(candidate);
  const b = normalizedPathForComparison(base);
  if (!c || !b) return false;
  if (c === b) return true;
  return c.startsWith(b + '/');
}

function isSameStoragePath(a: string, b: string): boolean {
  const normalizedA = normalizedPathForComparison(a);
  const normalizedB = normalizedPathForComparison(b);
  return !!normalizedA && !!normalizedB && normalizedA === normalizedB;
}

function hasExtraDir(extraDirs: string[], candidate: string): boolean {
  return extraDirs.some((existing) => isSameStoragePath(existing, candidate));
}

/** candidate 是 base 父目录或祖先(反过来:base 是 candidate 的子目录)。 */
function isParentOrAncestor(candidate: string, base: string): boolean {
  const c = normalizedPathForComparison(candidate);
  const b = normalizedPathForComparison(base);
  if (!c || !b || c === b) return false;
  return isSelfOrSubdir(b, c);
}

export const __extraDirsPathOverlapForTesting = {
  hasExtraDir,
  isParentOrAncestor,
  isSelfOrSubdir,
};

/** 取目录名做 chip 显示;空回 '/' 。 */
function basename(p: string): string {
  const stripped = stripTrailingPathSeparators(p);
  const parts = stripped.split(/[\\/]/);
  return parts[parts.length - 1] || stripped || '/';
}

export function ExtraDirsButton({
  extraDirs,
  workingDir,
  onAddFiles,
  onChange,
  onNewGoal,
  planMode,
  collaboration,
  plugins = [],
  pluginAvailableIds,
  onPluginSelect,
  disabled,
  dense = false,
  visualVariant = 'default',
}: ExtraDirsButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm } = useConfirmDialog();

  const hasReferenceDirs = onChange !== undefined;
  const count = extraDirs.length;
  const isCreateAgentVariant = visualVariant === 'create-agent';

  // hover 展开「添加」文案已移除(2026-07-22 用户定稿:展开必须承载信息,
  // 图标自明的 + 不需要;裸态→hover 外框→点击直接长出菜单)。

  // 能力感知:附件、新建目标、计划/协同模式、Plugin 与引用目录都由父组件是否接线决定。
  if (
    !onAddFiles &&
    !onNewGoal &&
    !planMode &&
    !collaboration &&
    !hasReferenceDirs &&
    plugins.length === 0
  ) {
    return null;
  }

  const atLimit = count >= MAX_EXTRA_DIRS;
  const collaborationPolicyDisabled = collaboration?.disabled === true;
  const collaborationRetryable =
    !disabled && collaborationPolicyDisabled && !!collaboration?.onDisabledActivate;
  const collaborationAriaLabel = collaboration?.disabledReason
    ? `${t('newChat.collaboration.modeLabel')}: ${collaboration.disabledReason}`
    : t('newChat.collaboration.modeLabel');

  const handleCollaborationActivate = () => {
    if (!collaboration || disabled) return;
    setOpen(false);
    if (collaborationPolicyDisabled) {
      collaboration.onDisabledActivate?.();
      return;
    }
    if (collaboration.enabled) {
      collaboration.onChange({ enabled: false, worker: collaboration.worker });
      return;
    }
    if (collaboration.onOpenDetails) {
      collaboration.onOpenDetails();
      return;
    }
    collaboration.onChange({ enabled: true, worker: collaboration.worker });
  };

  const handleAdd = async () => {
    if (atLimit || !onChange) return;
    let picked: string | null = null;
    try {
      const r = await window.electronAPI.dialog.showOpenDirectory({});
      picked = r?.success ? r.path : null;
    } catch (e) {
      log.warn('showOpenDirectory failed', { error: String(e) });
      return;
    }
    const normalizedPicked = normalizeWorkingDirForStorage(picked);
    if (!normalizedPicked) return;

    // UX 预判: 完全重复 / 是 workingDir 子目录 → 静默忽略(main validator 也会兜)。
    if (hasExtraDir(extraDirs, normalizedPicked)) return;
    if (workingDir && isSelfOrSubdir(normalizedPicked, workingDir)) {
      log.debug('add: silently skipped (subdir of workingDir)', {
        picked: normalizedPicked,
        workingDir,
      });
      return;
    }

    // 父目录 / 祖先警告 — 通过则继续。
    if (workingDir && isParentOrAncestor(normalizedPicked, workingDir)) {
      const ok = await confirm({
        title: '添加父目录?',
        description: `选中的目录是当前工作目录的父级或祖先。这会扩大 agent 的可见范围 —— 它能看到工作目录之外的内容。\n\n要添加吗?\n\n${normalizedPicked}`,
        confirmText: '仍然添加',
        cancelText: '取消',
      });
      if (!ok) return;
    }

    await onChange([...extraDirs, normalizedPicked]);
  };

  const handleRemove = async (path: string) => {
    if (!onChange) return;
    await onChange(extraDirs.filter((p) => p !== path));
  };

  return (
    <MorphPopover
      open={open}
      onOpenChange={setOpen}
      panelWidth={360}
      panelClassName="p-2"
      panelAriaLabel={t('extraDirs.menuAria')}
      startBg="var(--composer-pill-bg)"
      startBorderColor="var(--border-default)"
      wrapperClassName="shrink-0"
      trigger={
        <>
          {/* input 始终挂载:系统文件选择器打开期间菜单收合也不会卸载它。 */}
          {onAddFiles && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={disabled}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                // 允许用户连续两次选择同一个文件。
                event.currentTarget.value = '';
                if (files.length > 0) void onAddFiles(files);
              }}
            />
          )}
          <Tip
            text={count === 0 ? t('extraDirs.tooltipEmpty') : t('extraDirs.tooltipCount', { count })}
            side="top"
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => setOpen((prev) => !prev)}
              aria-expanded={open}
              className={cn(
                'flex shrink-0 items-center rounded-full transition-colors',
                // 裸态工具条(2026-07-22 用户定稿):默认无框,hover 才浮现胶囊外框。
                // create-agent(新建对话框)与会话内共用同一套裸态,不再分叉 —— 静息/hover 逐字一致。
                // 透明 border 常驻占位,避免 hover 时 1px 布局跳动。
                'h-[30px]',
                // count>0 加宽显示 ×N —— 会话内与新建草稿(create-agent)一致:引用目录
                // 扩大 agent 可见范围,必须在收起态外显,不允许静默(2026-07-25 用户定稿,
                // 取代此前 create-agent icon-only 紧凑态的决定)。
                count > 0 && hasReferenceDirs
                  ? 'min-w-max justify-center gap-1 px-2.5'
                  : 'w-[30px] justify-center p-0',
                'border border-transparent bg-transparent text-[var(--composer-pill-icon,#3C3F43)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
                'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              aria-label={t('extraDirs.menuAria')}
            >
              <Plus
                size={isCreateAgentVariant ? 11 : dense ? 14 : 14}
                className="shrink-0"
              />
              {count > 0 && hasReferenceDirs && (
                <span
                  className={cn(
                    'font-normal tabular-nums',
                    dense ? 'text-[12.5px]' : 'text-[13px]',
                  )}
                >
                  ×{count}
                </span>
              )}
            </button>
          </Tip>
        </>
      }
    >
      {onAddFiles && (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              fileInputRef.current?.click();
              setOpen(false);
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-3 py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Paperclip size={14} className="shrink-0 text-[var(--model-item-text)]" />
            <span className="text-[13px] text-[var(--model-item-text)]">
              {t('extraDirs.addFiles')}
            </span>
          </button>
          {(onNewGoal || planMode || collaboration || plugins.length > 0 || hasReferenceDirs) && (
            <div className="my-1 h-px bg-[var(--model-dropdown-border)]" />
          )}
        </>
      )}

        {/* 新建目标(仅会话中;点击关菜单并由父组件打开 NewGoalDialog) */}
        {onNewGoal && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewGoal();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-3 py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
            )}
          >
            <Target size={14} className="shrink-0 text-[var(--model-item-text)]" />
            <span className="text-[13px] text-[var(--model-item-text)]">
              {t('goal.newGoalMenuItem')}
            </span>
          </button>
        )}

        {/* 计划模式 toggle(与「新建目标」同级):勾选态右侧打勾;点击切换并关菜单。 */}
        {planMode && (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={planMode.enabled}
            onClick={() => {
              setOpen(false);
              planMode.onToggle(!planMode.enabled);
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-3 py-2',
              'transition-colors hover:bg-[var(--model-item-hover)]',
            )}
          >
            <ClipboardList size={14} className="shrink-0 text-[var(--model-item-text)]" />
            <span className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--model-item-text)]">
              {t('planMode.menuItem')}
            </span>
            {planMode.enabled && (
              <Check size={13} className="shrink-0 text-[var(--model-item-check)]" />
            )}
          </button>
        )}

        {/* 协同模式与目标/计划同级。开启态保留 Thinking Orange,右侧对勾表示当前状态。 */}
        {collaboration && (
          <Tip
            text={collaborationPolicyDisabled ? collaboration.disabledReason : null}
            side="right"
          >
            <span className="block">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={collaboration.enabled}
                aria-label={collaborationAriaLabel}
                aria-disabled={
                  collaborationPolicyDisabled && !collaborationRetryable ? true : undefined
                }
                disabled={disabled || (collaborationPolicyDisabled && !collaborationRetryable)}
                onClick={handleCollaborationActivate}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[8px] px-3 py-2',
                  'transition-colors hover:bg-[var(--model-item-hover)]',
                  collaboration.enabled && 'bg-[var(--model-item-hover)]',
                  (disabled || collaborationPolicyDisabled) && 'opacity-50',
                  (disabled || (collaborationPolicyDisabled && !collaborationRetryable)) &&
                    'cursor-not-allowed',
                )}
              >
                <UsersRound
                  size={14}
                  className={cn(
                    'shrink-0',
                    collaboration.enabled
                      ? 'text-[var(--warning-accent)]'
                      : 'text-[var(--model-item-text)]',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[13px]',
                    collaboration.enabled
                      ? 'font-medium text-[var(--warning-accent)]'
                      : 'text-[var(--model-item-text)]',
                  )}
                >
                  {t('newChat.collaboration.modeLabel')}
                </span>
                {collaboration.enabled && (
                  <Check size={13} className="shrink-0 text-[var(--model-item-check)]" />
                )}
              </button>
            </span>
          </Tip>
        )}

        {plugins.length > 0 && (
          <>
            {(onNewGoal || planMode || collaboration) && (
              <div className="my-1 h-px bg-[var(--model-dropdown-border)]" />
            )}
            <div className="px-2 pb-1 pt-1 text-[12px] text-[var(--model-trigger-text)] opacity-70">
              {t('extraDirs.pluginsTitle')}
            </div>
            <div
              role="list"
              aria-label={t('extraDirs.pluginsTitle')}
              className="morph-panel-list-scroll plugin-motion-root -mr-2 max-h-[200px] overflow-y-auto [scrollbar-gutter:stable]"
            >
              {plugins.map((ghost) => {
                const availableInScope = pluginAvailableIds
                  ? pluginAvailableIds.has(ghost.manifest.id)
                  : ghost.enabled;
                const selectable = Boolean(
                  availableInScope && ghost.manifest.command && onPluginSelect,
                );
                return (
                  <button
                    key={ghost.manifest.id}
                    type="button"
                    disabled={!selectable}
                    onClick={() => {
                      setOpen(false);
                      onPluginSelect?.(ghost);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-left',
                      'transition-colors hover:bg-[var(--model-item-hover)]',
                      'disabled:cursor-not-allowed disabled:opacity-45',
                    )}
                  >
                    <GhostPluginIcon
                      iconDataUrl={ghost.iconDataUrl}
                      iconId={ghost.manifest.id}
                      iconName={ghost.manifest.name}
                      size="menu"
                    />
                    <span className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--model-item-text)]">
                      {ghost.manifest.name}
                    </span>
                    {!selectable ? (
                      <span className="shrink-0 text-[12px] text-[var(--model-trigger-text)] opacity-70">
                        {t(
                          ghost.manifest.command
                            ? 'extraDirs.pluginDisabled'
                            : 'extraDirs.pluginNoCommand',
                        )}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* 引用目录段:Claude 与 Codex 共用；未接 onChange 时不暴露空操作入口。 */}
        {hasReferenceDirs && (
          <>
            {(onNewGoal || planMode || collaboration || plugins.length > 0) && (
              <div className="my-1 h-px bg-[var(--model-dropdown-border)]" />
            )}

            <div className="px-2 pb-1 pt-1 text-[12px] text-[var(--model-trigger-text)] opacity-70">
              {t('extraDirs.sectionTitle')}
            </div>

            {count > 0 ? (
              <div role="list" aria-label="Extra reference directories" className="mb-1">
                {extraDirs.map((p) => (
                  <div
                    key={p}
                    className={cn(
                      'group flex items-center gap-2 rounded-[8px] px-3 py-2',
                      'hover:bg-[var(--model-item-hover)]',
                    )}
                  >
                    <FolderPlus
                      size={14}
                      className="shrink-0 text-[var(--model-item-text)] opacity-60"
                    />
                    <Tip text={p} mono side="top">
                      <span className="min-w-0 flex-1 truncate text-left text-[13px] text-[var(--model-item-text)]">
                        {basename(p)}
                      </span>
                    </Tip>
                    <button
                      type="button"
                      onClick={() => void handleRemove(p)}
                      className={cn(
                        'rounded-full p-1 opacity-0 transition-opacity',
                        'hover:bg-[var(--model-item-hover)]',
                        'group-hover:opacity-70 hover:!opacity-100',
                      )}
                      aria-label={t('extraDirs.remove', { name: basename(p) })}
                    >
                      <X size={12} className="text-[var(--model-item-text)]" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 text-[12px] text-[var(--model-item-text)] opacity-50">
                {t('extraDirs.empty')}
              </div>
            )}

            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={atLimit}
              className={cn(
                'flex w-full items-center gap-2 rounded-[8px] px-3 py-2',
                'transition-colors',
                'hover:bg-[var(--model-item-hover)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <FolderPlus size={14} className="shrink-0 text-[var(--model-item-text)]" />
              <span className="text-[13px] text-[var(--model-item-text)]">
                {atLimit ? t('extraDirs.atLimit', { max: MAX_EXTRA_DIRS }) : t('extraDirs.add')}
              </span>
            </button>
          </>
        )}
    </MorphPopover>
  );
}
