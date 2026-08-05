/**
 * sessionsBus — Sidebar Projects 列表的统一事件通道
 * ---------------------------------------------------------------------------
 * 取代散落各处的 window.dispatchEvent('cc-sessions-refresh' | 'cc-session-patch')。
 * 所有写动作只走两个语义清晰的入口：
 *
 *   emitRefresh()              全量重拉。仅用于"列表成员变化"场景：
 *                              delete / archive / 切 includeArchived 过滤。
 *
 *   emitPatch(id, patch)       局部合并某条 session 的字段。所有"字段变化"
 *                              都走这条：rename / pin / title 生成 / updatedAt
 *                              更新 / workingDir / model / effort / clearSession 等。
 *
 *   emitAutoTitlePreview(id, title)
 *                              自动起名的即时标题预览。与 emitPatch 的区别是它**带
 *                              条件**：只有标题仍是「尚未起名」哨兵时才生效,由持有
 *                              缓存的 sessionsStore 自己裁决(见其订阅处)。
 *
 *   emitAutoTitlePreviewCleared(id)
 *                              起名彻底失败、权威标题不会再回流时撤回上面那次预览。
 *                              预览是「马上会有权威值」的赌注,赌输了必须还原。
 *
 * sessionsStore 通过 onRefresh / onPatch / onAutoTitlePreview /
 * onAutoTitlePreviewCleared 订阅，是列表数据的权威
 * 消费者；个别 UI 另有自己的局部订阅（如 CCAgentSidebarUpper 用 onPatch 做项目自动
 * 展开），所以 emit 的副作用不止于 store 缓存。
 */

import type { Session } from '@/lib/ccAgent.types';

const REFRESH_EVENT = 'cc-sessions-refresh';
const PATCH_EVENT = 'cc-session-patch';
const AUTO_TITLE_PREVIEW_EVENT = 'cc-session-auto-title-preview';
const AUTO_TITLE_PREVIEW_CLEARED_EVENT = 'cc-session-auto-title-preview-cleared';

interface PatchDetail {
  sessionId: string;
  patch: Partial<Session>;
}

interface AutoTitlePreviewDetail {
  sessionId: string;
  title: string;
}

export function emitRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function emitPatch(sessionId: string, patch: Partial<Session>): void {
  if (!sessionId || !patch) return;
  window.dispatchEvent(
    new CustomEvent<PatchDetail>(PATCH_EVENT, { detail: { sessionId, patch } }),
  );
}

/**
 * 自动起名的即时标题预览:让侧边栏 / 会话头立刻显示用户刚写下的话,不等
 * `maker:auto-title` 的 IPC 往返 + DB 广播回流。
 *
 * 刻意与 `emitPatch` 分开:这是**条件**更新 —— 只有标题仍是「尚未起名」的哨兵时才
 * 该生效,否则会把用户手动改过的名在 UI 上顶掉。判定交给持有列表缓存的
 * sessionsStore,发起方(makerChatStore)不必也不该去读会话行。
 *
 * 不写 DB:权威标题仍由 main 落库并经 sessions:patched 广播回来。
 */
export function emitAutoTitlePreview(sessionId: string, title: string): void {
  if (!sessionId || !title) return;
  window.dispatchEvent(
    new CustomEvent<AutoTitlePreviewDetail>(AUTO_TITLE_PREVIEW_EVENT, {
      detail: { sessionId, title },
    }),
  );
}

/**
 * 撤回上一次的即时标题预览 —— 起名 IPC 失败、权威标题不会再回流时调用。
 *
 * 为什么必须有这条:预览是叠加层,它的失效条件是「权威标题落地」。起名彻底失败时那个
 * 条件永远不成立,叠加层会在每次全量刷新后继续顶着 DB 里的哨兵,会话就永久显示一个
 * **库里并不存在**的标题(重启后又变回「未命名对话」)。宁可退回可解释的兜底文案:
 * 下一条带文字的消息会重试起名(`autoNameSettled` 未登记)。
 */
export function emitAutoTitlePreviewCleared(sessionId: string): void {
  if (!sessionId) return;
  window.dispatchEvent(
    new CustomEvent<{ sessionId: string }>(AUTO_TITLE_PREVIEW_CLEARED_EVENT, {
      detail: { sessionId },
    }),
  );
}

export function onRefresh(handler: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, handler);
  return () => window.removeEventListener(REFRESH_EVENT, handler);
}

export function onPatch(
  handler: (sessionId: string, patch: Partial<Session>) => void,
): () => void {
  const wrapped = (ev: Event) => {
    const detail = (ev as CustomEvent<PatchDetail>).detail;
    if (!detail || !detail.sessionId || !detail.patch) return;
    handler(detail.sessionId, detail.patch);
  };
  window.addEventListener(PATCH_EVENT, wrapped);
  return () => window.removeEventListener(PATCH_EVENT, wrapped);
}

export function onAutoTitlePreview(
  handler: (sessionId: string, title: string) => void,
): () => void {
  const wrapped = (ev: Event) => {
    const detail = (ev as CustomEvent<AutoTitlePreviewDetail>).detail;
    if (!detail || !detail.sessionId || !detail.title) return;
    handler(detail.sessionId, detail.title);
  };
  window.addEventListener(AUTO_TITLE_PREVIEW_EVENT, wrapped);
  return () => window.removeEventListener(AUTO_TITLE_PREVIEW_EVENT, wrapped);
}

export function onAutoTitlePreviewCleared(
  handler: (sessionId: string) => void,
): () => void {
  const wrapped = (ev: Event) => {
    const detail = (ev as CustomEvent<{ sessionId: string }>).detail;
    if (!detail || !detail.sessionId) return;
    handler(detail.sessionId);
  };
  window.addEventListener(AUTO_TITLE_PREVIEW_CLEARED_EVENT, wrapped);
  return () => window.removeEventListener(AUTO_TITLE_PREVIEW_CLEARED_EVENT, wrapped);
}
