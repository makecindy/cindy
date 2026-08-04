/**
 * sessionMenu —— 会话右上角「…」菜单的纯展示模型(SessionMenuSheet 消费)。
 *
 * 形态:一级 = 详情头部(标题 chip / 元信息 / 用量摘要)+ 操作列表(重命名 / 复制链接 /
 * 置顶 / 归档 / 删除)+「会话信息」二级入口;二级 = 用量 / 工作目录 / 附加引用目录 / 标识。
 * 全部为纯函数,不碰 IO;交互副作用(clipboard / Alert / 远端写)由组件层承担。
 */
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { i18n } from '@/i18n';
import { sessionCollaborationLabel } from '@/session/collaboration';
import { normalizeExtraDirs } from '@/session/newSession';
import { buildMobileSessionDeepLink } from '@/session/sessionLinks';
import { sessionWorktreeInfo } from '@/session/sessionWorktree';
import type { RemoteSession } from '@/session/types';
import {
  normalizeRemoteMoney,
  remoteMoneySymbol,
  type RemoteMoney,
} from '@/session/remoteMoney';

/** 菜单 sheet 的两级视图:一级操作菜单 / 二级会话信息。 */
export type SessionMenuView = 'menu' | 'info';

export interface SessionMenuChip {
  id: 'pinned' | 'archived' | 'readonly' | 'collab';
  label: string;
}

export interface SessionMenuHeaderModel {
  title: string;
  chips: SessionMenuChip[];
  /** agent 名 + 工作目录 / worktree 名,如「Claude · xdt-maker」。 */
  metaLine: string;
  /** 「¥2.31 · 上下文 45%」;两项都缺时为 null(隐藏用量行)。 */
  usageSummary: string | null;
}

export type SessionMenuActionId = 'rename' | 'copyLink' | 'pin' | 'archive' | 'delete';

export interface SessionMenuAction {
  id: SessionMenuActionId;
  label: string;
  tone: 'default' | 'danger';
  disabled: boolean;
  testID: string;
}

export function buildSessionMenuHeader(
  session: RemoteSession,
  input: { readOnlyReason?: string | null },
): SessionMenuHeaderModel {
  const chips: SessionMenuChip[] = [];
  if (session.pinnedAt) chips.push({ id: 'pinned', label: i18n.t('session.menu.chipPinned') });
  if (session.status === 'archived') chips.push({ id: 'archived', label: i18n.t('session.menu.chipArchived') });
  if (input.readOnlyReason) chips.push({ id: 'readonly', label: i18n.t('session.menu.chipReadOnly') });
  const collabLabel = sessionCollaborationLabel(session);
  if (collabLabel) chips.push({ id: 'collab', label: collabLabel });

  return {
    // 哨兵(尚未起名)直接给本地化兜底,**不回落 workspaceName** —— 回落会把目录名当标题,
    // 与 desktop 的「未命名对话」不一致(PR #1031 review P1)。文案走 i18n:本模块四语言
    // 都在用 i18n.t,不能塞硬编码中文(mobile 支持 en / ja / ko)。
    title: isDefaultDraftSessionTitle(session.title)
      ? i18n.t('session.menu.unnamedTitle')
      : session.title || workspaceName(session) || i18n.t('session.menu.titleFallback'),
    chips,
    metaLine: buildSessionMenuMetaLine(session),
    usageSummary: buildSessionMenuUsageSummary(session),
  };
}

export function buildSessionMenuActions(input: {
  archived: boolean;
  pinned: boolean;
  busy: boolean;
  writeDisabled: boolean;
}): SessionMenuAction[] {
  return [
    {
      id: 'rename',
      label: i18n.t('session.menu.renameAction'),
      tone: 'default',
      disabled: input.writeDisabled,
      testID: 'session.renameAction',
    },
    {
      id: 'copyLink',
      label: i18n.t('session.menu.copyLinkAction'),
      tone: 'default',
      disabled: input.busy,
      testID: 'session.copyLinkAction',
    },
    {
      id: 'pin',
      label: input.pinned ? i18n.t('session.menu.unpin') : i18n.t('session.menu.pin'),
      tone: 'default',
      disabled: input.writeDisabled,
      testID: 'session.pinButton',
    },
    {
      id: 'archive',
      label: input.archived ? i18n.t('session.menu.restore') : i18n.t('session.menu.archive'),
      tone: 'default',
      disabled: input.writeDisabled,
      testID: input.archived ? 'session.restoreButton' : 'session.archiveButton',
    },
    {
      id: 'delete',
      label: i18n.t('session.menu.deleteAction'),
      tone: 'danger',
      disabled: input.writeDisabled,
      testID: 'session.deleteButton',
    },
  ];
}

export interface SessionInfoWorkspaceModel {
  /** worktree 会话显示「Worktree」,普通会话显示「工作目录」。 */
  label: string;
  name: string;
  path: string;
}

export function buildSessionInfoWorkspace(
  session: Pick<RemoteSession, 'workingDir' | 'worktreePath'>,
): SessionInfoWorkspaceModel | null {
  const worktree = sessionWorktreeInfo(session);
  if (worktree) return { label: 'Worktree', name: worktree.name, path: worktree.path };
  const workingDir = session.workingDir?.trim();
  if (!workingDir) return null;
  return { label: i18n.t('session.menu.workingDir'), name: lastPathPart(workingDir), path: workingDir };
}

/** 附加引用目录入口条件(与旧设置面板一致):cc + project 会话且有工作目录。 */
export function sessionInfoShowsExtraDirs(
  session: Pick<RemoteSession, 'agentKind' | 'workspaceKind' | 'workingDir'>,
): boolean {
  return session.agentKind === 'cc' && session.workspaceKind === 'project' && !!session.workingDir;
}

/** 追加附加目录(normalize 去重);changed=false 表示目录已在列表里。 */
export function addSessionExtraDir(
  current: readonly string[] | null | undefined,
  path: string,
): { dirs: string[]; changed: boolean } {
  const base = normalizeExtraDirs(current ?? undefined);
  const dirs = normalizeExtraDirs([...base, path]);
  return { dirs, changed: dirs.length !== base.length };
}

/** 移除附加目录(按 normalize 后的展示值精确匹配)。 */
export function removeSessionExtraDir(
  current: readonly string[] | null | undefined,
  path: string,
): string[] {
  return normalizeExtraDirs(current ?? undefined).filter((dir) => dir !== path);
}

/** 会话深链(一级「复制链接」的复制值)。 */
export function sessionMenuCopyLink(session: Pick<RemoteSession, 'id'>): string {
  return buildMobileSessionDeepLink(session.id);
}

/** Android 返回键 / 关闭手势的两段式收敛:info 先回 menu,menu 才关 sheet。 */
export function settleSessionMenuBack(view: SessionMenuView): { close: boolean } {
  return { close: view === 'menu' };
}

/**
 * 自动起名失败的「链路不通」错误码:对齐 device-link 的 DeviceLinkErrorCode 实际枚举
 * (packages/device-link/src/protocol.ts)——精确匹配真实错误码,不用宽泛的 OFFLINE /
 * TIMEOUT 子串,避免误吞其它全大写超时类错误码(review P2)。NOT_CONNECTED(手机本端
 * 尚未连上 relay,网络抖动 / 后台回收后最常见)同属离线分档;它也是
 * DEVICE_LINK_NOT_CONNECTED 的子串,顺带覆盖桌面侧同义码。
 */
const AI_RENAME_OFFLINE_ERROR_CODES = [
  'DEVICE_OFFLINE',
  'LINK_NOT_OPEN',
  'NOT_CONNECTED',
  'INVOKE_TIMEOUT',
] as const;

/**
 * 自动起名失败的场景化提示(对齐桌面 SessionRenameInput 的错误码分档):
 * 老被控端没有该 channel / 版本不匹配 → 提示升级;链路不通 → 提示离线;其余通用失败。
 */
export function aiRenameFailureText(error: unknown): string {
  const text = error instanceof Error ? `${readErrorCode(error)} ${error.message}` : String(error);
  if (text.includes('CHANNEL_NOT_ALLOWED') || text.includes('VERSION_MISMATCH')) {
    return i18n.t('session.menu.aiRenameUnsupported');
  }
  if (AI_RENAME_OFFLINE_ERROR_CODES.some((code) => text.includes(code))) {
    return i18n.t('session.menu.aiRenameOffline');
  }
  return i18n.t('session.menu.aiRenameFailed');
}

function readErrorCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function buildSessionMenuMetaLine(session: RemoteSession): string {
  const agentLabel = session.agentKind === 'codex' ? 'Codex' : 'Claude';
  const parts = [agentLabel];
  const worktree = sessionWorktreeInfo(session);
  const workspace = workspaceName(session);
  if (worktree) {
    parts.push(`worktree ${worktree.name}`);
  } else if (workspace) {
    parts.push(workspace);
  }
  return parts.join(' · ');
}

function buildSessionMenuUsageSummary(session: RemoteSession): string | null {
  const parts: string[] = [];
  const totalMoney = normalizeRemoteMoney(session.totalMoney);
  const legacyCostUsd = readPositiveNumber(session.totalCostUsd);
  const displayMoney =
    totalMoney && totalMoney.amount > 0
      ? totalMoney
      : legacyCostUsd === null
        ? null
        : {
            amount: legacyCostUsd,
            currency: 'USD' as const,
            approximate: false,
            kind: 'actual-cost' as const,
          };
  if (displayMoney) parts.push(formatMoney(displayMoney));
  const contextTokens = readPositiveNumber(session.contextTokens);
  const contextWindow = readPositiveNumber(session.contextWindow);
  if (contextTokens !== null && contextWindow !== null) {
    const percent = Math.min(100, Math.max(0, (contextTokens / contextWindow) * 100));
    parts.push(i18n.t('session.menu.contextUsageSummary', { percent: Math.round(percent) }));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function workspaceName(session: Pick<RemoteSession, 'workingDir'>): string | null {
  const workingDir = session.workingDir?.trim();
  return workingDir ? lastPathPart(workingDir) : null;
}

function lastPathPart(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatMoney(money: RemoteMoney): string {
  const symbol = remoteMoneySymbol(money.currency);
  if (money.amount >= 10) return `${symbol}${Math.round(money.amount)}`;
  if (money.amount >= 0.01) return `${symbol}${money.amount.toFixed(2)}`;
  return `<${symbol}0.01`;
}
