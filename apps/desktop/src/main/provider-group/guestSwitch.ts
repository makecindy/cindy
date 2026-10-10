/**
 * 分享的人这边的「需要换一台」(docs/product-rules/provider-groups.md §6.1「谁来执行换电脑 · 分享的人」)。
 *
 * 分享者把分享出来的供应商建成了组时，本机的任务由组所在电脑中转到组内某台电脑运行；本机看不到是哪台。那台
 * 因电脑本身的原因失败时，组所在电脑在事件流里先发来一张一次性凭证(排在那次错误前面)。本机据此自动交接
 * (新建会话并带上交接上下文)后重新打开，打开时带回凭证，组所在电脑再为它换一台。
 *
 * 只有持有组所在电脑发来的凭证才换：分享被暂停、删除、撤权等是分享本身的问题，不会触发换电脑。
 */

/** 凭证到达后多久内的那次错误才算数(凭证紧挨在错误前面送达，这里只防陈旧凭证误用)。 */
export const PROVIDER_GROUP_SWITCH_OFFER_TTL_MS = 2 * 60_000;
/** 交接后等重新打开带走凭证的时限(与组所在电脑那边的有效期一致)。 */
export const PROVIDER_GROUP_SWITCH_ARMED_TTL_MS = 10 * 60_000;

export interface ProviderGroupGuestSwitch {
  /** 组所在电脑发来凭证(任务的事件流里)。 */
  offer(sessionId: string, token: string): void;
  /** 这次错误要不要换一台：有新鲜的凭证则取走，登记给下一次打开，返回 true。 */
  claim(sessionId: string): boolean;
  /** 打开任务时带上的凭证(取走即用掉)；没有返回 undefined。 */
  takeForOpen(sessionId: string): string | undefined;
  /** 交接没成：作废登记给下一次打开的凭证。 */
  release(sessionId: string): void;
  /** 用户亲自接手(发消息、重试、换模型)：作废还没用上的凭证。 */
  drop(sessionId: string): void;
}

let shared: ProviderGroupGuestSwitch | null = null;

/** 运行期共用的一份(远程 Agent 打开任务与供应商组服务共用)。按任务 id 存放，任务 id 全局唯一，不随账号区分。 */
export function getProviderGroupGuestSwitch(): ProviderGroupGuestSwitch {
  shared ??= createProviderGroupGuestSwitch();
  return shared;
}

export function createProviderGroupGuestSwitch(now: () => number = Date.now): ProviderGroupGuestSwitch {
  const offered = new Map<string, { token: string; at: number }>();
  const armed = new Map<string, { token: string; at: number }>();

  return {
    offer(sessionId, token) {
      offered.set(sessionId, { token, at: now() });
    },

    claim(sessionId) {
      const entry = offered.get(sessionId);
      offered.delete(sessionId);
      if (!entry || now() - entry.at > PROVIDER_GROUP_SWITCH_OFFER_TTL_MS) return false;
      armed.set(sessionId, { token: entry.token, at: now() });
      return true;
    },

    takeForOpen(sessionId) {
      const entry = armed.get(sessionId);
      armed.delete(sessionId);
      if (!entry || now() - entry.at > PROVIDER_GROUP_SWITCH_ARMED_TTL_MS) return undefined;
      return entry.token;
    },

    release(sessionId) {
      armed.delete(sessionId);
    },

    drop(sessionId) {
      offered.delete(sessionId);
    },
  };
}
