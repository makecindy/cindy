/**
 * 委派投递失败的裁决：什么时候还值得重试，什么时候必须让用户看见「这活没派出去」。
 *
 * 为什么需要它：委派的去程是「把第一句话送进目标伙伴的子任务并让它真的跑起来」。
 * 这一步可能因为**永远不会自愈**的原因失败——最典型的是没登录（拿不到账号的模型
 * 来源），其次是子任务已归档 / 已删除。原先的实现对任何失败都一律标 `waiting` 并
 * 无限指数退避重试：委派行永远停在进行中，协作卡永远转圈，发起方永远等不到结果，
 * 日志之外没有任何地方说过一句「它起不来」。这是**静默坏死**，比直接失败更糟。
 *
 * 这里把裁决收成一个纯函数，供 `botDelegationService` 在每次投递失败后调用：
 *  - `fatal` → 委派立刻收口成 `failed`，错误文案是给人看的中文，走既有的结果回传
 *    通路（协作卡终态 + 回到发起方对话），用户当场知道发生了什么、该做什么。
 *  - `retry` → 保持 `waiting` 并继续退避重试，但**次数有上限**；用完仍不成即 fatal。
 *
 * 判据只用 DispatchResult 的 `errorCode` / `message`，因为主机通路只把失败压成这两
 * 个字符串。账号未就绪那条另加了一个稳定标记（见 `ACCOUNT_PROVIDER_NOT_READY_CODE`），
 * 由 maker-host 的会话启动门抛出时写进 message，避免靠自然语言猜。
 */

import { ACCOUNT_PROVIDER_NOT_READY_CODE } from '../../shared/accountProviderReadiness.js';

export { ACCOUNT_PROVIDER_NOT_READY_CODE };

/**
 * 一次委派最多尝试几次去程投递。
 *
 * 退避是 1s/2s/4s/8s/16s/32s，6 次约一分钟。够覆盖「Agent 进程正在重启」「远端刚断线」
 * 这类真瞬时故障；再长就不是瞬时故障，而是需要用户介入的状况，应该停下来说话。
 */
export const BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS = 6;

/**
 * 结构性失败：目标子任务本身不在了 / 调用形状不合法。重试只是把同一个错误再犯一遍。
 */
const STRUCTURAL_FATAL_CODES = new Set([
  'ARCHIVED',
  'DELETED',
  'NOT_FOUND',
  'INVALID_ARGS',
  'UNSUPPORTED_CAPABILITY',
  'LEAD_NOT_SUPPORTED',
  'WORKTREE_UNAVAILABLE',
]);

export type BotDelegationDispatchVerdict =
  | { kind: 'retry' }
  | { kind: 'fatal'; errorCode: string; message: string };

export interface BotDelegationDispatchFailure {
  errorCode: string;
  message: string;
  /** 刚失败的这次是第几次（0 基）。 */
  attempt: number;
  maxAttempts?: number;
}

function isAccountProviderNotReady(input: { errorCode: string; message: string }): boolean {
  return (
    input.errorCode === ACCOUNT_PROVIDER_NOT_READY_CODE
    || input.message.includes(ACCOUNT_PROVIDER_NOT_READY_CODE)
  );
}

/**
 * 裁决一次去程投递失败。fatal 时给出的 message 会直接进协作卡与发起方对话，
 * 所以必须是人话，并且要说清下一步该做什么。
 */
export function classifyBotDelegationDispatchFailure(
  input: BotDelegationDispatchFailure,
): BotDelegationDispatchVerdict {
  const maxAttempts = Math.max(1, input.maxAttempts ?? BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS);
  if (isAccountProviderNotReady(input)) {
    return {
      kind: 'fatal',
      errorCode: 'ACCOUNT_NOT_READY',
      message: '需要登录后才能执行：当前没有可用的账号与模型来源，请先登录 Cindy 再重新委派。',
    };
  }
  if (STRUCTURAL_FATAL_CODES.has(input.errorCode)) {
    return {
      kind: 'fatal',
      errorCode: input.errorCode,
      message: `委派没能送到对方的任务：${input.message}`,
    };
  }
  if (input.attempt + 1 >= maxAttempts) {
    return {
      kind: 'fatal',
      errorCode: 'DISPATCH_UNAVAILABLE',
      message: `对方的任务连续 ${maxAttempts} 次没能开始，已经停止重试：${input.message}`,
    };
  }
  return { kind: 'retry' };
}
