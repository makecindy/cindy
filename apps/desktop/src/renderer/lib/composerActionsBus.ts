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

const promptInsertHandlers = new Set<PromptInsertHandler>();

/**
 * 预填提示词。返回 true = 有订阅方实际写入了输入框。
 * Chip 点击用这个回执决定要不要退回打开 PR:没人接住就绝不能空点。
 */
export function insertPromptIntoComposer(detail: InsertPromptDetail): boolean {
  let accepted = false;
  for (const handler of promptInsertHandlers) {
    if (handler(detail)) accepted = true;
  }
  return accepted;
}

export function subscribePromptInsert(handler: PromptInsertHandler): () => void {
  promptInsertHandlers.add(handler);
  return () => {
    promptInsertHandlers.delete(handler);
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
