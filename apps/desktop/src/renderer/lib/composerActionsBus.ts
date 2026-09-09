/**
 * Process-local composer actions shared by distant message and input views.
 * The target session id keeps concurrent chat panes from consuming each
 * other's insert requests.
 */

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
