import { randomUUID } from 'node:crypto';

/**
 * oneShotTickets —— Host 侧一次性票据(inspect → confirm 两段式 IPC 的绑定载体)。
 *
 * 存在的原因(P0-2):「inspect 读事实 → 用户确认 → confirm 落盘」跨两次 IPC,
 * 只回传事实指纹(如 manifestSha256)绑不住**读事实那一刻的 owner**。多账号下
 * A 在确认卡停留期间切到 B,若两边同 id/同指纹/同批准态 token,A 看的确认可以
 * 给 B 的当前目录铸出批准。票据由 Host 进程内持有(opaque,renderer 只透传),
 * 值里钉 inspect 时点的全部事实,confirm **原子消费**(取即删):重放、跨票、
 * 过期一律拿不到值,fail closed。
 *
 * 进程内 Map 即可:票据只服务同进程内的一次 UI 往返,不落盘、不跨进程。
 */
export interface OneShotTicketStore<T> {
  /** 发一张票,返回 opaque token。超容量时先驱逐最早签发的票。 */
  issue(value: T): string;
  /** 原子消费:取出即删除。不存在/已消费/已过期一律返回 null。 */
  consume(token: string): T | null;
}

export function createOneShotTicketStore<T>(options: {
  ttlMs: number;
  maxEntries: number;
  /** 时钟注入(仅测试)。 */
  now?: () => number;
}): OneShotTicketStore<T> {
  const now = options.now ?? Date.now;
  // Map 迭代序 = 插入序,驱逐最旧即删第一个键。
  const tickets = new Map<string, { value: T; expiresAt: number }>();
  return {
    issue(value: T): string {
      const current = now();
      for (const [token, entry] of tickets) {
        if (entry.expiresAt <= current) tickets.delete(token);
      }
      while (tickets.size >= options.maxEntries) {
        const oldest = tickets.keys().next().value;
        if (oldest === undefined) break;
        tickets.delete(oldest);
      }
      const token = randomUUID();
      tickets.set(token, { value, expiresAt: current + options.ttlMs });
      return token;
    },
    consume(token: string): T | null {
      const entry = tickets.get(token);
      tickets.delete(token);
      if (!entry || entry.expiresAt <= now()) return null;
      return entry.value;
    },
  };
}
