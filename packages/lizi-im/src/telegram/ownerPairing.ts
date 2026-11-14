/**
 * Telegram 主人配对: 没填主人 id 的伙伴 bot 用「私聊发一条消息 → 拿配对码 → 在 Cindy 里输入同一个码」
 * 认定主人(参照 Hermes gateway/pairing.py 的口径, 去掉落盘与 CLI)。
 *
 * 安全边界:
 *   - 配对码只在 Telegram 私聊里出现; Cindy 界面只列出「谁在请求」, 主人要把 bot 回复的码
 *     输进 Cindy 才能确认(按 userId + 码匹配)。码不进界面投影、广播、远程结果与日志。
 *   - 只在内存里: 重启即失效(重新发一条消息就会拿到新码), 不落盘。
 *   - 一次性、有过期时间; 同一人冷却期内不重复回复; 待确认上限防止被陌生人刷满;
 *     对还在有效期内的请求连续输错码会锁定一段时间, 防止穷举。
 */
import { randomInt } from 'node:crypto';

/** 去掉 0/O、1/I/L 等易混字符。 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const OWNER_PAIRING_CODE_LENGTH = 6;
export const OWNER_PAIRING_TTL_MS = 15 * 60_000;
/** 同一人两次回复(码或「稍后再试」)的最小间隔, 期间的消息静默。 */
export const OWNER_PAIRING_REPLY_COOLDOWN_MS = 60_000;
/** 被忽略的人这段时间内不再拿到新码。 */
export const OWNER_PAIRING_DISMISS_BLOCK_MS = 10 * 60_000;
export const OWNER_PAIRING_MAX_PENDING = 3;
export const OWNER_PAIRING_MAX_FAILED_ATTEMPTS = 5;
export const OWNER_PAIRING_LOCKOUT_MS = 15 * 60_000;
/** 「稍后再试」冷却表的上限(陌生人很多时淘汰最旧的)。 */
const BUSY_REPLY_TRACK_MAX = 500;

export interface OwnerPairingUser {
  /** Telegram 数字用户 id。 */
  userId: string;
  displayName: string;
  username?: string;
}

/** 待确认的配对请求(给 Cindy 界面展示; 不含配对码)。 */
export interface PendingOwnerPairing extends OwnerPairingUser {
  requestedAt: number;
  expiresAt: number;
}

export type OwnerPairingRequestResult =
  | { kind: 'issued'; code: string; expiresAt: number }
  | { kind: 'repeat'; code: string; expiresAt: number }
  /** 名额已满或刚被忽略: 回一句「稍后再试」(冷却内只回一次)。 */
  | { kind: 'busy' }
  /** 冷却期内: 不回复。 */
  | { kind: 'cooldown' };

export type OwnerPairingVerifyResult =
  | { kind: 'match'; user: OwnerPairingUser }
  /** 这个人没有还在有效期内的请求(过期、被忽略或从没请求过): 不计入失败次数。 */
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'locked'; retryAfterMs: number };

interface Entry extends PendingOwnerPairing {
  code: string;
  lastReplyAt: number;
}

/** 输入里的空白(聊天界面常把码拆开显示)去掉、转大写后比较。 */
export function normalizeOwnerPairingCode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export class TelegramOwnerPairing {
  private readonly entries = new Map<string, Entry>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly busyRepliedAt = new Map<string, number>();
  private failedAttempts = 0;
  private lockedUntil = 0;
  private readonly now: () => number;
  private readonly pick: (max: number) => number;

  constructor(opts: { now?: () => number; randomIndex?: (max: number) => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.pick = opts.randomIndex ?? ((max) => randomInt(max));
  }

  /** 私聊来消息: 发码、重复回同一个码、回「稍后再试」, 或静默(冷却)。 */
  request(user: OwnerPairingUser): OwnerPairingRequestResult {
    const now = this.now();
    this.prune(now);
    const existing = this.entries.get(user.userId);
    if (existing) {
      if (now - existing.lastReplyAt < OWNER_PAIRING_REPLY_COOLDOWN_MS) return { kind: 'cooldown' };
      existing.lastReplyAt = now;
      return { kind: 'repeat', code: existing.code, expiresAt: existing.expiresAt };
    }
    if ((this.blockedUntil.get(user.userId) ?? 0) > now || this.entries.size >= OWNER_PAIRING_MAX_PENDING) {
      const last = this.busyRepliedAt.get(user.userId);
      if (last !== undefined && now - last < OWNER_PAIRING_REPLY_COOLDOWN_MS) return { kind: 'cooldown' };
      this.busyRepliedAt.delete(user.userId);
      this.busyRepliedAt.set(user.userId, now);
      if (this.busyRepliedAt.size > BUSY_REPLY_TRACK_MAX) {
        const oldest = this.busyRepliedAt.keys().next().value;
        if (oldest !== undefined) this.busyRepliedAt.delete(oldest);
      }
      return { kind: 'busy' };
    }
    const code = this.generateUniqueCode();
    const expiresAt = now + OWNER_PAIRING_TTL_MS;
    this.entries.set(user.userId, {
      userId: user.userId,
      displayName: user.displayName,
      ...(user.username ? { username: user.username } : {}),
      code,
      requestedAt: now,
      expiresAt,
      lastReplyAt: now,
    });
    return { kind: 'issued', code, expiresAt };
  }

  /**
   * 核对某人的请求与主人输入的码。只核对, 不移除: 调用方把主人落盘成功后再 clearPending(),
   * 落盘失败时请求原样保留可重试。只有对还在有效期内的请求输错才计入失败次数。
   */
  verify(userId: string, rawCode: string): OwnerPairingVerifyResult {
    const now = this.now();
    this.prune(now);
    if (this.lockedUntil > now) return { kind: 'locked', retryAfterMs: this.lockedUntil - now };
    const entry = this.entries.get(userId);
    if (!entry) return { kind: 'expired' };
    if (normalizeOwnerPairingCode(rawCode) !== entry.code) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= OWNER_PAIRING_MAX_FAILED_ATTEMPTS) {
        this.failedAttempts = 0;
        this.lockedUntil = now + OWNER_PAIRING_LOCKOUT_MS;
      }
      return { kind: 'invalid' };
    }
    this.failedAttempts = 0;
    return {
      kind: 'match',
      user: {
        userId: entry.userId,
        displayName: entry.displayName,
        ...(entry.username ? { username: entry.username } : {}),
      },
    };
  }

  /** 回复没送达(发送失败): 退还这次冷却, 下一条私聊照常回复。 */
  releaseReplyCooldown(userId: string): void {
    const entry = this.entries.get(userId);
    if (entry) entry.lastReplyAt = Number.NEGATIVE_INFINITY;
    this.busyRepliedAt.delete(userId);
  }

  /** 忽略某人的请求; 一段时间内不再给他发码。 */
  dismiss(userId: string): boolean {
    const removed = this.entries.delete(userId);
    if (removed) this.blockedUntil.set(userId, this.now() + OWNER_PAIRING_DISMISS_BLOCK_MS);
    return removed;
  }

  /** 还在有效期内的请求(不含配对码)。 */
  list(): PendingOwnerPairing[] {
    this.prune(this.now());
    return [...this.entries.values()]
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map(({ userId, displayName, username, requestedAt, expiresAt }) => ({
        userId,
        displayName,
        ...(username ? { username } : {}),
        requestedAt,
        expiresAt,
      }));
  }

  /** 清掉全部待确认请求(确认成功、换 token、下线); 保留忽略名单与锁定状态。 */
  clearPending(): boolean {
    const had = this.entries.size > 0;
    this.entries.clear();
    return had;
  }

  /** 全部状态归零(解绑 / 释放实例)。 */
  reset(): void {
    this.entries.clear();
    this.blockedUntil.clear();
    this.busyRepliedAt.clear();
    this.failedAttempts = 0;
    this.lockedUntil = 0;
  }

  private prune(now: number): void {
    for (const [userId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(userId);
    }
    for (const [userId, until] of this.blockedUntil) {
      if (until <= now) this.blockedUntil.delete(userId);
    }
  }

  /** 与仍有效的码撞了就重抽(31^6 空间里几乎不会发生, 但两人拿到同一个码不可接受)。 */
  private generateUniqueCode(): string {
    const live = new Set([...this.entries.values()].map((entry) => entry.code));
    for (;;) {
      let code = '';
      for (let i = 0; i < OWNER_PAIRING_CODE_LENGTH; i += 1) code += ALPHABET[this.pick(ALPHABET.length)];
      if (!live.has(code)) return code;
    }
  }
}
