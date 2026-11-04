/**
 * Process-local composer actions shared by distant message and input views.
 * The target session id keeps concurrent chat panes from consuming each
 * other's insert requests.
 */

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const INSERT_SESSION_LINK_EVENT = 'cindy-composer-insert-session-link';

/** A request to insert one conversation/message deep link into a composer. */
export interface InsertSessionLinkDetail {
  targetSessionId: string;
  href: string;
}

export function insertSessionLinkIntoComposer(detail: InsertSessionLinkDetail): void {
  window.dispatchEvent(
    new CustomEvent<InsertSessionLinkDetail>(INSERT_SESSION_LINK_EVENT, { detail }),
  );
}

export function subscribeSessionLinkInsert(
  handler: (detail: InsertSessionLinkDetail) => void,
): () => void {
  const wrapped = (event: Event) => {
    handler((event as CustomEvent<InsertSessionLinkDetail>).detail);
  };
  window.addEventListener(INSERT_SESSION_LINK_EVENT, wrapped);
  return () => window.removeEventListener(INSERT_SESSION_LINK_EVENT, wrapped);
}

const INSERT_TODO_REFERENCE_EVENT = 'cindy-composer-insert-todo-reference';

/** A request to insert one teammate Todo reference chip; the user still writes and sends. */
export interface InsertTodoReferenceDetail {
  targetSessionId: string;
  href: string;
  title: string;
}

export function insertTodoReferenceIntoComposer(detail: InsertTodoReferenceDetail): void {
  window.dispatchEvent(
    new CustomEvent<InsertTodoReferenceDetail>(INSERT_TODO_REFERENCE_EVENT, { detail }),
  );
}

export function subscribeTodoReferenceInsert(
  handler: (detail: InsertTodoReferenceDetail) => void,
): () => void {
  const wrapped = (event: Event) => {
    handler((event as CustomEvent<InsertTodoReferenceDetail>).detail);
  };
  window.addEventListener(INSERT_TODO_REFERENCE_EVENT, wrapped);
  return () => window.removeEventListener(INSERT_TODO_REFERENCE_EVENT, wrapped);
}

/**
 * A request to prefill plain prompt text into a composer. The composer only
 * inserts and focuses; the user still decides whether to send.
 */
export interface InsertPromptDetail {
  targetSessionId: string;
  text: string;
}

type PromptInsertHandler = (detail: InsertPromptDetail) => boolean;

const promptInsertHandlersBySession = new Map<string, Set<PromptInsertHandler>>();

/**
 * 预填提示词。返回 true = 有订阅方实际写入了输入框。
 * Chip 点击:写入成功则结束;有订阅但拒绝(发送中/语音占用)则不改动作;
 * 完全没人接住才退回打开 PR。
 */
export function insertPromptIntoComposer(detail: InsertPromptDetail): boolean {
  const handlers = promptInsertHandlersBySession.get(detail.targetSessionId);
  if (!handlers) return false;
  let accepted = false;
  for (const handler of handlers) {
    if (handler(detail)) accepted = true;
  }
  return accepted;
}

export function hasPromptInsertSubscriber(sessionId: string): boolean {
  return (promptInsertHandlersBySession.get(sessionId)?.size ?? 0) > 0;
}

export function subscribePromptInsert(
  sessionId: string,
  handler: PromptInsertHandler,
): () => void {
  let handlers = promptInsertHandlersBySession.get(sessionId);
  if (!handlers) {
    handlers = new Set();
    promptInsertHandlersBySession.set(sessionId, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) promptInsertHandlersBySession.delete(sessionId);
  };
}

/** TipTap chain 里预填提示词需要的最小表面,避免 composerActionsBus 依赖 Editor 类型。 */
export interface PromptInsertChain {
  focus: (pos: 'end') => PromptInsertChain;
  splitBlock: () => PromptInsertChain;
  insertContent: (text: string) => PromptInsertChain;
  run: () => void;
}

/**
 * 把引导提示词写成独立一段。输入框已有草稿时先 splitBlock,绝不拼到最后一个字符后面。
 */
export function insertPromptIntoEditor(
  chain: PromptInsertChain,
  opts: { isEmpty: boolean; text: string },
): void {
  chain.focus('end');
  if (!opts.isEmpty) chain.splitBlock();
  chain.insertContent(opts.text).run();
}

/**
 * 一次性「发送这份草稿」请求。用户在别处点了一个明确的一键动作 (如截图工具条的
 * 「翻译」), 入口先把草稿写进 composerDraftStore, 再请求该草稿所在的输入框按
 * 普通发送键同一条路径发出 —— 不绕过模型、权限、建任务等任何发送逻辑。
 *
 * 请求带上期望出现的附件, 输入框等草稿与附件都同步到位才发, 每条请求只发一次;
 * 暂时没有输入框接住 (还在路由切换) 时保留到过期, 之后挂载的输入框再取。
 */
export interface ComposerSubmitRequest {
  storageKey: string;
  /** 草稿里必须已有这张附件 (按 url 比对) 才发送。 */
  attachmentUrl: string;
  expiresAt: number;
}

const DEFAULT_SUBMIT_TTL_MS = 15_000;
const pendingSubmitRequests = new Map<string, ComposerSubmitRequest & { owner: DataOwnerGeneration }>();
const submitRequestHandlers = new Map<string, Set<() => void>>();

export function requestComposerSubmit(
  request: Omit<ComposerSubmitRequest, 'expiresAt'>,
  ttlMs = DEFAULT_SUBMIT_TTL_MS,
): void {
  pendingSubmitRequests.set(request.storageKey, { ...request, expiresAt: Date.now() + ttlMs, owner: getDataOwnerGeneration() });
  for (const handler of submitRequestHandlers.get(request.storageKey) ?? []) handler();
}

/** 当前仍有效的请求 (不取走)。 */
export function peekComposerSubmitRequest(storageKey: string): ComposerSubmitRequest | null {
  const request = pendingSubmitRequests.get(storageKey);
  if (!request) return null;
  if (request.expiresAt <= Date.now() || !isDataOwnerGenerationCurrent(request.owner)) {
    pendingSubmitRequests.delete(storageKey);
    return null;
  }
  return request;
}

/** 取走请求; 之后同一请求不会再触发发送。 */
export function takeComposerSubmitRequest(storageKey: string): ComposerSubmitRequest | null {
  const request = peekComposerSubmitRequest(storageKey);
  pendingSubmitRequests.delete(storageKey);
  return request;
}

/** 订阅某个草稿的发送请求; 订阅时已有待处理请求会立即通知一次。 */
export function subscribeComposerSubmitRequest(
  storageKey: string,
  handler: () => void,
): () => void {
  let handlers = submitRequestHandlers.get(storageKey);
  if (!handlers) {
    handlers = new Set();
    submitRequestHandlers.set(storageKey, handlers);
  }
  handlers.add(handler);
  if (peekComposerSubmitRequest(storageKey)) queueMicrotask(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) submitRequestHandlers.delete(storageKey);
  };
}
