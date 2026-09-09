/**
 * badgeSlot.ts — 未读角标槽(badge 槽,2026-08-03)。
 * ---------------------------------------------------------------------------
 * 意识经管子上行 `{type:'badge', unread, summary?}`,请主机点亮/熄灭它在插件
 * 入口与插件卡上的**未读绿点**。设计边界(与 notify 同一信任模型):
 *
 *   - 资格审只看 `badge` 卡槽——它与 `notify` 卡槽**并列**,不要求也不捆绑
 *     notify(绿点比 toast 克制,只想点绿点的意识不该被迫连"能弹全屏顶部提示"
 *     一起申请)。装入时 validateGhostManifest 已强制 badge 必须同时声明 panel,
 *     这里不重复判；`badge` 引入前的旧版校验会拒绝未知 slot，所以更早安装的
 *     老包不可能带这个槽；当前运行时仍以 Manifest 声明作为强制边界；
 *   - 意识只供**纯文本** summary:与 notify 共用 sanitizeGhostNoticeText 剥控制
 *     字符,换行坍缩成空格(摘要占卡片一行,换行没有正当用途),超限拒收——
 *     不静默截断,作者需要知道自己超了;
 *   - 点的颜色/位置/身份头全由主机画,意识改不了别人的角标(ghostId 由沙箱
 *     绑定,不看载荷自报);
 *   - 限速只挡**点亮**方向:GHOST_BADGE_MIN_INTERVAL_MS。熄灭是降级动作,
 *     被限速会留下一颗清不掉的死点,反而更糟。
 *
 * 处理结果永不 reject——一切失败折叠成 { ok:false, message }(同 notify 纪律)。
 * 依赖注入(规则 14):取意识/落盘/广播/时钟全部经 deps,单测直测。
 */

import {
  GHOST_BADGE_MIN_INTERVAL_MS,
  GHOST_BADGE_SUMMARY_MAX_CHARS,
  type GhostPipeBadgeResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

/** 推给 renderer 的角标载荷(身份由主机按已装清单认,不信意识自报)。 */
export interface GhostBadgePush {
  ghostId: string;
  unread: boolean;
  /** 未读摘要(已净化限长;unread:false 或意识没给时缺省)。 */
  summary?: string;
  /** 点亮时刻(epoch ms;unread:false 时缺省)。 */
  at?: number;
}

export interface BadgeSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /**
   * 落盘点亮(账本按 owner 隔离,见 ghostUnreadStore)。
   * 返回 false = **没写进去**(只读磁盘 / 磁盘满 / 配置损坏)。此时不得广播
   * 点亮:renderer 会留下一颗账本里根本不存在的点,而后续的熄灭路径查不到
   * 记录 → 不广播 → 那颗点再也清不掉(codex review)。
   */
  mark(ghostId: string, summary: string | undefined, at: number): boolean;
  /** 落盘熄灭;返回 false = 本来就没亮(调用方据此免掉一次无意义广播)。 */
  clear(ghostId: string): boolean;
  /** 把角标变化推给全部宿主窗口。 */
  broadcast(payload: GhostBadgePush): void;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class GhostBadgeSlot {
  /** 每意识最近一次成功**点亮**的时刻(限速账本;熄灭不记账、不受限)。 */
  private readonly lastMarkedAt = new Map<string, number>();

  constructor(private readonly deps: BadgeSlotDeps) {}

  /** 处理一条 badge(ghost-pipe:send 的 invoke 返回值即本结果)。 */
  handleBadge(ghostId: string, payload: unknown): GhostPipeBadgeResult {
    const p = payload as { unread?: unknown; summary?: unknown };

    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (ghost.manifest.badge !== true) {
      return {
        ok: false,
        message: '本意识未声明 badge 能力,无权点亮未读角标(需在 ghost.json 中声明 "badge": true 并重新装入)',
      };
    }

    if (typeof p?.unread !== 'boolean') {
      return { ok: false, message: 'unread 必须是布尔值' };
    }

    // 熄灭:不限速、不校验 summary(按协议忽略),没亮着就静默幂等成功。
    if (!p.unread) {
      const changed = this.deps.clear(ghostId);
      if (changed) {
        this.deps.broadcast({ ghostId, unread: false });
        this.deps.log?.info('ghost badge cleared by plugin', { ghostId });
      }
      return { ok: true };
    }

    let summary: string | undefined;
    if (p.summary !== undefined) {
      if (typeof p.summary !== 'string') {
        return { ok: false, message: 'summary 必须是字符串' };
      }
      // 先净化再验超限(防用控制字符注水绕过上限);换行坍缩成空格。
      const cleaned = sanitizeGhostNoticeText(p.summary).replace(/\n+/g, ' ').trim();
      if (cleaned.length > GHOST_BADGE_SUMMARY_MAX_CHARS) {
        return { ok: false, message: `summary 过长(上限 ${GHOST_BADGE_SUMMARY_MAX_CHARS} 字符)` };
      }
      // 净化后为空 = 作者给的全是空白/控制字符,按"没给摘要"处理,不因此拒点。
      if (cleaned.length > 0) summary = cleaned;
    }

    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastMarkedAt.get(ghostId);
    if (last !== undefined && now - last < GHOST_BADGE_MIN_INTERVAL_MS) {
      return {
        ok: false,
        message: `角标上报过于频繁(同一意识最小间隔 ${GHOST_BADGE_MIN_INTERVAL_MS} 毫秒),本条已丢弃`,
      };
    }
    if (!this.deps.mark(ghostId, summary, now)) {
      // 落盘失败:不广播、不记限速账(否则作者重试还会被自己上一条挡住),
      // 如实回结构化失败让意识知道这条没生效。
      this.deps.log?.warn('ghost badge dropped: ledger write failed', { ghostId });
      return { ok: false, message: '未读角标写入失败(主机侧存储不可用),本条未生效' };
    }
    this.lastMarkedAt.set(ghostId, now);

    this.deps.broadcast({ ghostId, unread: true, ...(summary ? { summary } : {}), at: now });
    this.deps.log?.info('ghost badge marked', { ghostId, hasSummary: summary !== undefined });
    return { ok: true };
  }

  /** 卸载/停用时抹掉限速记账(重装后第一条不该被上一世的时刻挡住)。 */
  forget(ghostId: string): void {
    this.lastMarkedAt.delete(ghostId);
  }
}
