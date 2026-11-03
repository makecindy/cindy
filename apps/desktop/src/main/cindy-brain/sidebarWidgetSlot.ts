/**
 * sidebarWidgetSlot.ts — 侧栏状态条(sidebarWidget 能力)。
 * ---------------------------------------------------------------------------
 * 意识经管子上行 `{type:'sidebar-widget', groups}`,主机在「全部任务」标题下画一行状态胶囊,
 * 点开后列出对应任务。信任模型与 badge 相同:意识只供纯文本标签和枚举色,界面全由主机画。
 *
 * 状态只存内存:意识退出后没人更新,留着就是过期数字,所以不落盘,重启后由意识重新上报。
 * 处理结果永不 reject,失败折叠成 { ok:false, message }。
 */

import {
  GHOST_SIDEBAR_WIDGET_LABEL_MAX_CHARS,
  GHOST_SIDEBAR_WIDGET_MAX_GROUPS,
  GHOST_SIDEBAR_WIDGET_MAX_TASKS_PER_GROUP,
  GHOST_SIDEBAR_WIDGET_MIN_INTERVAL_MS,
  GHOST_SIDEBAR_WIDGET_TONES,
  type GhostPipeSidebarWidgetResult,
  type GhostSidebarWidgetEntry,
  type GhostSidebarWidgetGroup,
  type GhostSidebarWidgetTone,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

export interface SidebarWidgetSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 任务 id 只能来自 cindy.observe,所以要求这项批准仍然有效。 */
  isObserveApproved(id: string): boolean;
  broadcast(entries: GhostSidebarWidgetEntry[]): void;
  now?(): number;
}

const GROUP_KEY_RE = /^[a-z0-9-]{1,32}$/;
const MAX_TASK_ID_LENGTH = 4096;

function parseGroups(raw: unknown): GhostSidebarWidgetGroup[] | string {
  if (!Array.isArray(raw)) return 'groups 必须是数组';
  if (raw.length > GHOST_SIDEBAR_WIDGET_MAX_GROUPS) {
    return `groups 过多(上限 ${GHOST_SIDEBAR_WIDGET_MAX_GROUPS} 组)`;
  }
  const keys = new Set<string>();
  const groups: GhostSidebarWidgetGroup[] = [];
  for (const item of raw) {
    const { key, label, tone, taskIds } = (item ?? {}) as Record<string, unknown>;
    if (typeof key !== 'string' || !GROUP_KEY_RE.test(key)) return 'key 只能是 1-32 位小写字母、数字或连字符';
    if (keys.has(key)) return `key 重复:${key}`;
    keys.add(key);
    if (typeof label !== 'string') return 'label 必须是字符串';
    const cleaned = sanitizeGhostNoticeText(label).replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'label 不能为空';
    if (cleaned.length > GHOST_SIDEBAR_WIDGET_LABEL_MAX_CHARS) {
      return `label 过长(上限 ${GHOST_SIDEBAR_WIDGET_LABEL_MAX_CHARS} 字符)`;
    }
    if (!GHOST_SIDEBAR_WIDGET_TONES.includes(tone as GhostSidebarWidgetTone)) {
      return `tone 只能是 ${GHOST_SIDEBAR_WIDGET_TONES.join(' / ')}`;
    }
    if (!Array.isArray(taskIds) || taskIds.length > GHOST_SIDEBAR_WIDGET_MAX_TASKS_PER_GROUP) {
      return `taskIds 必须是数组,每组不超过 ${GHOST_SIDEBAR_WIDGET_MAX_TASKS_PER_GROUP} 个`;
    }
    if (taskIds.some((id) => typeof id !== 'string' || !id || id.length > MAX_TASK_ID_LENGTH)) {
      return 'taskIds 只能包含任务 id 字符串';
    }
    if (new Set(taskIds).size !== taskIds.length) return 'taskIds 不能重复';
    groups.push({ key, label: cleaned, tone: tone as GhostSidebarWidgetTone, taskIds: taskIds as string[] });
  }
  return groups;
}

export class GhostSidebarWidgetSlot {
  private readonly entries = new Map<string, GhostSidebarWidgetGroup[]>();
  private readonly lastChangedAt = new Map<string, number>();

  constructor(private readonly deps: SidebarWidgetSlotDeps) {}

  handle(ghostId: string, payload: unknown): GhostPipeSidebarWidgetResult {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) return { ok: false, message: '意识不在可用状态' };
    if (ghost.manifest.sidebarWidget !== true) {
      return { ok: false, message: '本意识未声明 sidebarWidget 能力(需在 ghost.json 中声明 "sidebarWidget": true)' };
    }
    if (ghost.manifest.agent?.observe !== true || !this.deps.isObserveApproved(ghostId)) {
      return { ok: false, message: 'sidebarWidget 需要已批准的 agent.observe 能力' };
    }

    const groups = parseGroups((payload as { groups?: unknown } | null)?.groups);
    if (typeof groups === 'string') return { ok: false, message: groups };

    if (groups.length === 0) {
      this.clear(ghostId);
      return { ok: true };
    }
    if (JSON.stringify(this.entries.get(ghostId)) === JSON.stringify(groups)) return { ok: true };

    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastChangedAt.get(ghostId);
    if (last !== undefined && now - last < GHOST_SIDEBAR_WIDGET_MIN_INTERVAL_MS) {
      return { ok: false, message: `状态条上报过于频繁(最小间隔 ${GHOST_SIDEBAR_WIDGET_MIN_INTERVAL_MS} 毫秒),本条已丢弃` };
    }
    this.lastChangedAt.set(ghostId, now);
    this.entries.set(ghostId, groups);
    this.deps.broadcast(this.snapshot());
    return { ok: true };
  }

  snapshot(): GhostSidebarWidgetEntry[] {
    return [...this.entries].map(([ghostId, groups]) => ({ ghostId, groups }));
  }

  /** 主动收起:保留限速时间,否则交替上报和收起就能绕过限速。 */
  private clear(ghostId: string): void {
    if (this.entries.delete(ghostId)) this.deps.broadcast(this.snapshot());
  }

  /** 意识退出、停用或卸载:撤掉状态条,下一世的第一条不受上一世限速影响。 */
  forget(ghostId: string): void {
    this.lastChangedAt.delete(ghostId);
    this.clear(ghostId);
  }

  /** 换账号:任务 id 属于旧账号,整表作废。 */
  reset(): void {
    this.lastChangedAt.clear();
    this.entries.clear();
    this.deps.broadcast([]);
  }
}
