/**
 * send_to_session 完成回执(handoff receipt)的幂等 clientId 约定。
 *
 * 发送方带 `request_receipt` 调用 send_to_session 时,投递到目标任务的输入用
 * `handoff-receipt:<dispatcherSessionId>:<nonce>` 作为 clientId;目标任务消费该输入的
 * turn 正常结束后,宿主向发起方回投一条隐藏回执,回执 clientId 为
 * `handoff-receipt-done:<nonce>`(确定性 id + messages 表 (sessionId, clientId) 唯一索引,
 * 重放/重试天然幂等)。前缀带冒号与 `-done` 变体互不为前缀,回执自身不会再触发回执。
 *
 * main 与测试共用同一份常量;解析只认宿主生成的 id,不信任模型正文。
 */

export const HANDOFF_RECEIPT_INPUT_PREFIX = "handoff-receipt:";
export const HANDOFF_RECEIPT_DONE_PREFIX = "handoff-receipt-done:";

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * 请求回执的输入 clientId。dispatcherSessionId 按send_to_session 既有约束是不含
 * `:` 的不透明 id;含 `:` 的历史 id 无法编码,调用方应在生成前拒绝。
 */
export function handoffReceiptInputClientId(
  dispatcherSessionId: string,
  nonce: string,
): string | null {
  if (
    !dispatcherSessionId ||
    dispatcherSessionId.includes(":") ||
    !UUID_RE_TEST.test(nonce)
  )
    return null;
  return `${HANDOFF_RECEIPT_INPUT_PREFIX}${dispatcherSessionId}:${nonce}`;
}

/** 解析请求回执的输入 clientId;非回执输入返回 null。 */
export function parseHandoffReceiptInputClientId(
  clientId: string,
): { dispatcherSessionId: string; nonce: string } | null {
  const match = new RegExp(
    `^${HANDOFF_RECEIPT_INPUT_PREFIX}([^:]+):(${UUID_RE})$`,
  ).exec(clientId);
  return match ? { dispatcherSessionId: match[1], nonce: match[2] } : null;
}

/** 回执唤醒的幂等 clientId:同一输入只回执一次。 */
export function handoffReceiptDoneClientId(nonce: string): string {
  return `${HANDOFF_RECEIPT_DONE_PREFIX}${nonce}`;
}

const UUID_RE_TEST = new RegExp(`^${UUID_RE}$`);
