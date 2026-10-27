/**
 * 协同 tab 的宿主入口。
 *
 * ensure 只保证 singleton tab 存在,不改变侧栏展开状态,也不覆盖用户当前 tab；
 * reveal 在 ensure 之后显式展开右侧栏,用于用户主动开启协同和 deep link 入口。
 */

import {
  addTab,
  closeTab,
  ensureHydrated,
  getBucket,
  patchTabState,
  setActiveTab,
} from '../../store';
import { requestRightSidebarVisibility } from '../../lib/sidebarCommands';
import { routeSidebarCommand } from '../../lib/detachedSidebarRouting';
import {
  parseConversationSearchJump,
  type ConversationSearchJump,
} from '../../../../../shared/conversationSearchJump';
import type {
  RsbWindowCommand,
  RsbWindowCommandRouteResult,
} from '../../../../../shared/rightSidebarWindow';

export interface OrcaWorkersState {
  focusWorkerSessionId?: string | null;
  /** 显式 string/null intent 的单调版本；消费清 state 时不递增。 */
  focusWorkerHintRevision?: number;
  searchJump?: ConversationSearchJump | null;
}

export function hydrateOrcaWorkersState(raw: unknown): OrcaWorkersState {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const state: OrcaWorkersState = {};
  if (Object.prototype.hasOwnProperty.call(source, 'focusWorkerSessionId')) {
    state.focusWorkerSessionId =
      typeof source.focusWorkerSessionId === 'string' && source.focusWorkerSessionId
        ? source.focusWorkerSessionId
        : null;
  }
  if (
    typeof source.focusWorkerHintRevision === 'number' &&
    Number.isSafeInteger(source.focusWorkerHintRevision) &&
    source.focusWorkerHintRevision >= 0
  ) {
    state.focusWorkerHintRevision = source.focusWorkerHintRevision;
  } else if (typeof state.focusWorkerSessionId === 'string') {
    // 兼容 revision 引入前持久化的 string hint；赋 1 后首次消费即可正常 CAS 清理。
    state.focusWorkerHintRevision = 1;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'searchJump')) {
    state.searchJump = parseConversationSearchJump(source.searchJump);
  }
  return state;
}

export interface OrcaWorkersTabOptions {
  focusWorkerSessionId?: string | null;
  searchJump?: ConversationSearchJump | null;
  focusTab?: boolean;
  animate?: boolean;
}

function withWorkerOpenIntent(
  current: unknown,
  opts: Pick<OrcaWorkersTabOptions, 'focusWorkerSessionId' | 'searchJump'>,
): OrcaWorkersState {
  const state = hydrateOrcaWorkersState(current);
  const hasFocusIntent = opts.focusWorkerSessionId !== undefined;
  const hasSearchJump = opts.searchJump !== undefined;
  if (!hasFocusIntent && !hasSearchJump) return state;

  const next: OrcaWorkersState = { ...state };
  // focus / search 都是同一个 worker-open intent；同次 patch 只递增一次。
  next.focusWorkerHintRevision = (state.focusWorkerHintRevision ?? 0) + 1;
  if (hasFocusIntent) {
    next.focusWorkerSessionId = opts.focusWorkerSessionId ?? null;
    // 显式 null 是“清 worker open intent”，不能遗留上一条消息定位意图。
    if (opts.focusWorkerSessionId === null && !hasSearchJump) next.searchJump = null;
  }
  if (hasSearchJump) {
    next.searchJump = parseConversationSearchJump(opts.searchJump);
    // searchJump 自带 worker session 身份；调用方只传消息定位时也必须形成完整选择意图。
    if (!hasFocusIntent && next.searchJump) {
      next.focusWorkerSessionId = next.searchJump.sessionId;
    }
  }
  return next;
}

async function routeDetachedOrcaWorkersCommand(
  leadSessionId: string,
  opts: OrcaWorkersTabOptions,
  allowOpen: boolean,
): Promise<RsbWindowCommandRouteResult> {
  const command: RsbWindowCommand = {
    type: 'ensure-orca-workers-tab',
    sessionId: leadSessionId,
    focusTab: opts.focusTab === true,
  };
  if (opts.focusWorkerSessionId !== undefined) {
    command.focusWorkerSessionId = opts.focusWorkerSessionId;
  }
  if (opts.searchJump !== undefined) command.searchJump = opts.searchJump;
  return routeSidebarCommand(command, { allowOpen });
}

async function ensureOrcaWorkersTabLocal(
  leadSessionId: string,
  opts: OrcaWorkersTabOptions,
): Promise<void> {
  await ensureHydrated(leadSessionId);
  const bucket = getBucket(leadSessionId);
  const existing = bucket.tabs.find((candidate) => candidate.kind === 'orca-workers');
  if (existing) {
    if (opts.focusWorkerSessionId !== undefined || opts.searchJump !== undefined) {
      await patchTabState(leadSessionId, existing.id, (state) => withWorkerOpenIntent(state, opts));
    }
    if (opts.focusTab && bucket.activeTabId !== existing.id) {
      await setActiveTab(leadSessionId, existing.id);
    }
    return;
  }

  await addTab(leadSessionId, 'orca-workers', withWorkerOpenIntent({}, opts));
}

export async function ensureOrcaWorkersTab(
  leadSessionId: string,
  opts: OrcaWorkersTabOptions = {},
): Promise<void> {
  const routeResult = await routeDetachedOrcaWorkersCommand(
    leadSessionId,
    opts,
    opts.focusTab === true,
  );
  if (routeResult !== 'attached') return;
  await ensureOrcaWorkersTabLocal(leadSessionId, opts);
}

export async function revealOrcaWorkersTab(
  leadSessionId: string,
  opts: OrcaWorkersTabOptions = {},
): Promise<RsbWindowCommandRouteResult> {
  const revealOpts = { ...opts, focusTab: true };
  const routeResult = await routeDetachedOrcaWorkersCommand(leadSessionId, revealOpts, true);
  if (routeResult === 'attached') {
    await ensureOrcaWorkersTabLocal(leadSessionId, revealOpts);
  } else if (routeResult !== 'routed') {
    return routeResult;
  }
  requestRightSidebarVisibility('open', {
    sessionId: leadSessionId,
    ...(opts.animate === false ? { animate: false } : {}),
  });
  return routeResult;
}

export async function closeOrcaWorkersTabAfterTeamEnd(leadSessionId: string): Promise<void> {
  const routeResult = await routeSidebarCommand(
    {
      type: 'close-orca-workers-tab',
      sessionId: leadSessionId,
    },
    { allowOpen: false },
  );
  if (routeResult !== 'attached') return;

  await ensureHydrated(leadSessionId);
  const tab = getBucket(leadSessionId).tabs.find((candidate) => candidate.kind === 'orca-workers');
  if (!tab) return;
  await closeTab(leadSessionId, tab.id, { skipBeforeClose: true });
}

/**
 * 在本 renderer 已有的协同 tab 上写入「打开这个 Worker」意图。
 * 分离窗合并回主窗前使用：意图随 tab 状态(SQLite 或交接快照)到主窗，由主窗协同 tab
 * 消费并选中该 Worker；不改 Team 级 focused worker。返回写入的意图 revision。
 */
export async function writeOrcaWorkersFocusIntent(
  leadSessionId: string,
  tabId: string,
  workerSessionId: string,
): Promise<number | null> {
  let revision: number | null = null;
  await patchTabState(leadSessionId, tabId, (state) => {
    const next = withWorkerOpenIntent(state, { focusWorkerSessionId: workerSessionId });
    revision = next.focusWorkerHintRevision ?? null;
    return next;
  });
  return revision;
}

async function consumeOrcaWorkersIntent(
  leadSessionId: string,
  tabId: string,
  revision: number,
  consume: (state: OrcaWorkersState) => OrcaWorkersState,
): Promise<void> {
  await patchTabState(leadSessionId, tabId, (raw) => {
    const state = hydrateOrcaWorkersState(raw);
    if ((state.focusWorkerHintRevision ?? 0) !== revision) return raw;
    return consume(state);
  });
}

/** 消费 hint 采用 revision CAS，旧视图的延迟清理不能覆盖更新的 external intent。 */
export async function consumeOrcaWorkersFocusHint(
  leadSessionId: string,
  tabId: string,
  revision: number,
): Promise<void> {
  await consumeOrcaWorkersIntent(leadSessionId, tabId, revision, (state) => ({
    ...state,
    focusWorkerSessionId: null,
    focusWorkerHintRevision: revision,
  }));
}

/** 消息定位也跟随同一 revision 消费，避免旧 worker 完成定位后清掉新跳转。 */
export async function consumeOrcaWorkersSearchJump(
  leadSessionId: string,
  tabId: string,
  revision: number,
): Promise<void> {
  await consumeOrcaWorkersIntent(leadSessionId, tabId, revision, (state) => ({
    ...state,
    searchJump: null,
  }));
}

/** 用户主动切 Worker 时，同 revision 原子清掉 focus 与消息定位意图。 */
export async function clearOrcaWorkersSelectionIntent(
  leadSessionId: string,
  tabId: string,
  revision: number,
): Promise<void> {
  await consumeOrcaWorkersIntent(leadSessionId, tabId, revision, (state) => ({
    ...state,
    focusWorkerSessionId: null,
    focusWorkerHintRevision: revision,
    searchJump: null,
  }));
}
