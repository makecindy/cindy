/**
 * 后台任务启动失败的裁决：什么时候还值得重试，什么时候必须明确失败。
 *
 * 为什么需要它：创建 Session 后还必须把第一条指令送进去，任务才算真正开始。
 * 这一步可能因为**永远不会自愈**的原因失败——最典型的是没登录（拿不到账号的模型
 * 来源），其次是子任务已归档 / 已删除。原先的实现对任何失败都一律标 `waiting` 并
 * 无限指数退避重试：数据行永远停在进行中，任务卡永远转圈，发起方永远等不到结果，
 * 日志之外没有任何地方说过一句「它起不来」。这是**静默坏死**，比直接失败更糟。
 *
 * 这里把裁决收成一个纯函数，供 `botDelegationService` 在每次投递失败后调用：
 *  - `fatal` → 任务立刻收口成 `failed`，错误文案通过任务卡和发起方时间线显示。
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
      message: '需要登录后才能执行：当前没有可用的账号与模型来源，请先登录 Cindy 再重新启动任务。',
    };
  }
  if (STRUCTURAL_FATAL_CODES.has(input.errorCode)) {
    return {
      kind: 'fatal',
      errorCode: input.errorCode,
      message: `后台任务没能启动：${input.message}`,
    };
  }
  if (input.attempt + 1 >= maxAttempts) {
    return {
      kind: 'fatal',
      errorCode: 'DISPATCH_UNAVAILABLE',
      message: `后台任务连续 ${maxAttempts} 次没能开始，已经停止重试：${input.message}`,
    };
  }
  return { kind: 'retry' };
}
