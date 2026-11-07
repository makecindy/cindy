/**
 * 卡片 PR 状态位 —— 插件在 div 上标 `data-ghost-pr-status="owner/repo#123"`,宿主用标题栏
 * 同一份 PR 状态(PrRefsContext,随标题栏一起定时刷新)替换其内容。
 *
 * 插件卡片在调用结束后是静态快照,PR 的检查状态却随时在变;交给宿主填写后,卡片和标题栏
 * 永远一致,也不必等 Agent 下一轮回写。插件写在里面的内容是兜底:旧版宿主、手机,或这条
 * PR 不在本任务的 PR 列表里(宿主查不到)时原样显示。
 *
 * `data-ghost-pr-open-only="owner/repo#123"` 标的是只在 PR 开着时成立的部分(跟进中、操作按钮):
 * 同一份状态显示已合并或关闭时宿主把它们藏起来,查不到状态时照原样显示。
 *
 * `button[data-ghost-task-archive="owner/repo#123"]` 是归档任务按钮,插件写成 display:none:
 * 整个任务关联的 PR 都确认已合并时才露出；快照、未知状态和关闭未合并均不算完成。
 */
import { Check, CircleMinus, CircleX, Clock, type LucideIcon } from 'lucide-react';
import { prStatusItemKeys, type PrStatusItemKey, type PrStatusItemTone } from '@cindy/maker-shared';
import type { PrStatusResult } from '@/lib/gitContext.types';
import type { GhostCardTaskAutoArchiveState } from './ghostCardTaskArchive';
import { appIconMarkup, preloadAppIconMarkup } from './ghostCardIcons';

const SLOT_SELECTOR = 'div[data-ghost-pr-status]';
const SLOT_ATTR_RE = / data-ghost-(?:pr-status|pr-open-only|task-archive)="([^"]+)"/;
const OPEN_ONLY_SELECTOR = '[data-ghost-pr-open-only]';
const TASK_ARCHIVE_SELECTOR = 'button[data-ghost-task-archive]';
const SLOT_VALUE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;

type Tone = PrStatusItemTone;
type Label = (key: string, options?: Record<string, unknown>) => string;

/** 状态位的值 → prStatusKey 形式(owner/repo 小写)。不合格返回 null。 */
export function prStatusSlotKey(value: string): string | null {
  const m = SLOT_VALUE_RE.exec(value.trim());
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}#${Number(m[3])}` : null;
}

/** 从净化后的卡片 html 里取第一个状态位或 open-only 标记的 key(订阅用;都没有返回 null)。 */
export function readPrStatusSlotKey(html: string): string | null {
  const m = SLOT_ATTR_RE.exec(html);
  return m ? prStatusSlotKey(m[1]) : null;
}

/**
 * 检查数量用标题栏 PR 汇总的同一套文案、图标与颜色(失败 / 进行中 / 通过 / 跳过或中立),
 * 未解决评论数用汇总里的同一句话;合并状态仍是卡片自己的一项。
 */
const CHECK_ITEMS = {
  checksFailed: { label: 'ccAgent.gitContext.pr.failed', icon: CircleX, color: 'var(--error-fg)' },
  checksPending: { label: 'ccAgent.gitContext.pr.pending', icon: Clock, color: undefined },
  checksPassed: { label: 'ccAgent.gitContext.pr.passed', icon: Check, color: 'var(--status-success)' },
  checksSkipped: { label: 'ccAgent.gitContext.pr.skippedLabel', icon: CircleMinus, color: undefined },
} as const satisfies Partial<Record<PrStatusItemKey, { label: string; icon: LucideIcon; color?: string }>>;

// 状态位多在 effect 里随状态刷新重填,那时同步渲染不会完成,所以图标在模块加载时备好。
preloadAppIconMarkup(Object.values(CHECK_ITEMS).map((item) => item.icon));

type Item =
  | { kind: 'check'; key: keyof typeof CHECK_ITEMS; count: number; label: string }
  | { kind: 'text'; tone: Tone; key: PrStatusItemKey; label: string };

/** 状态条目的取舍与手机端共用(maker-shared prStatusItemKeys),这里只负责翻译。 */
export function prStatusItems(status: Extract<PrStatusResult, { ok: true }>, t: Label): Item[] {
  return prStatusItemKeys(status).map(({ tone, key, count }): Item => {
    if (key in CHECK_ITEMS) {
      const check = key as keyof typeof CHECK_ITEMS;
      return { kind: 'check', key: check, count: count ?? 0, label: t(CHECK_ITEMS[check].label) };
    }
    const label = key === 'threadsOpen'
      ? t('ccAgent.gitContext.pr.unresolved', { count })
      : t(`chat.ghostCall.prStatus.${key}`);
    return { kind: 'text', tone, key, label };
  });
}

/** 状态位被宿主内容替换前的原始子节点:之后查不到状态时据此恢复插件的兜底内容。 */
const slotFallbacks = new WeakMap<HTMLElement, Node[]>();
/** 被藏起来的 open-only 元素原本的内联 display,恢复时还原。 */
const hiddenDisplays = new WeakMap<HTMLElement, { value: string; priority: string }>();

/** PR 已合并或关闭时藏起 open-only 部分;状态回到开着或查不到时还原。可反复调用。 */
function applyOpenOnly(doc: Document, lookup: (key: string) => PrStatusResult | undefined): void {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(OPEN_ONLY_SELECTOR))) {
    const key = prStatusSlotKey(el.getAttribute('data-ghost-pr-open-only') ?? '');
    const status = key ? lookup(key) : undefined;
    const ended = status?.ok === true && (status.status === 'merged' || status.status === 'closed');
    const saved = hiddenDisplays.get(el);
    if (ended && !saved) {
      hiddenDisplays.set(el, { value: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') });
      el.style.setProperty('display', 'none', 'important');
    } else if (!ended && saved) {
      hiddenDisplays.delete(el);
      if (saved.value) el.style.setProperty('display', saved.value, saved.priority);
      else el.style.removeProperty('display');
    }
  }
}

/** Task-wide eligibility is required even when this card's own PR is merged. */
function applyTaskArchive(doc: Document, lookup: (key: string) => PrStatusResult | undefined, taskEligible: boolean, t: Label): boolean {
  let autoArchive = false;
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(TASK_ARCHIVE_SELECTOR))) {
    const key = prStatusSlotKey(el.getAttribute('data-ghost-task-archive') ?? '');
    const status = key ? lookup(key) : undefined;
    const live = status?.ok === true ? status.status : undefined;
    const ended = taskEligible && !!key && live === 'merged';
    el.setAttribute('aria-label', t('chat.ghostCall.taskArchiveNow'));
    if (ended) el.style.setProperty('display', 'inline-flex', 'important');
    else el.style.setProperty('display', 'none', 'important');
    if (ended && live === 'merged' && el.hasAttribute('data-ghost-task-archive-auto')) autoArchive = true;
  }
  return autoArchive;
}

const AUTO_ARCHIVE_HINT_ATTR = 'data-x-auto-archive-hint';

/** 在归档按钮旁分别呈现自动归档状态与取消操作；取消后保留结果提示。 */
export function fillGhostCardTaskAutoArchiveHint(
  doc: Document,
  state: GhostCardTaskAutoArchiveState,
  labels: { pending: string; cancel: string; cancelled: string },
  onCancel: () => void,
): void {
  for (const el of Array.from(doc.querySelectorAll(`[${AUTO_ARCHIVE_HINT_ATTR}]`))) el.remove();
  if (state === 'inactive') return;
  const button = Array.from(doc.querySelectorAll<HTMLElement>(TASK_ARCHIVE_SELECTOR))
    .find((el) => el.hasAttribute('data-ghost-task-archive-auto') && el.style.display !== 'none');
  if (!button?.parentElement) return;
  const hint = doc.createElement('span');
  hint.setAttribute(AUTO_ARCHIVE_HINT_ATTR, '');
  hint.style.cssText = 'display:inline-flex;align-items:center;gap:10px;margin-right:12px;font-size:12px;color:var(--text-secondary);min-width:0';
  const label = doc.createElement('span');
  label.textContent = state === 'cancelled' ? labels.cancelled : labels.pending;
  hint.append(label);
  if (state === 'pending') {
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = labels.cancel;
    cancel.style.cssText = 'display:inline-flex;align-items:center;flex:none;height:32px;padding:0 12px;' +
      'border:1px solid var(--border-default);border-radius:9999px;font:inherit;font-size:13px;font-weight:500;' +
      'color:var(--text-primary);cursor:pointer;--bg:var(--surface-elevated);background:var(--bg);' +
      '--hover:color-mix(in srgb,var(--surface-elevated),var(--text-primary) 8%)';
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      onCancel();
    });
    hint.append(cancel);
  }
  button.parentElement.insertBefore(hint, button);
}

/**
 * 用宿主的 PR 状态替换卡片文档里的状态位。查不到状态(或状态失败、一项都没有)时保留插件的
 * 兜底内容——已经换成宿主内容的状态位会恢复成它;同一份文档可反复调用(状态刷新时重填)。
 * 返回卡片上是否有可在看过后自动归档的已合并 PR(见 applyTaskArchive)。
 */
export function fillGhostCardPrStatus(
  doc: Document,
  lookup: (key: string) => PrStatusResult | undefined,
  t: Label,
  taskEligible = false,
): boolean {
  applyOpenOnly(doc, lookup);
  const autoArchive = applyTaskArchive(doc, lookup, taskEligible, t);
  for (const slot of Array.from(doc.querySelectorAll<HTMLElement>(SLOT_SELECTOR))) {
    const key = prStatusSlotKey(slot.getAttribute('data-ghost-pr-status') ?? '');
    const status = key ? lookup(key) : undefined;
    const items = status?.ok ? prStatusItems(status, t) : [];
    if (!items.length) {
      const original = slotFallbacks.get(slot);
      if (original) {
        slot.replaceChildren(...original);
        slotFallbacks.delete(slot);
      }
      continue;
    }
    if (!slotFallbacks.has(slot)) slotFallbacks.set(slot, Array.from(slot.childNodes));
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;color:var(--text-secondary)';
    for (const item of items) {
      const el = doc.createElement('span');
      el.style.cssText = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap';
      if (item.kind === 'check') {
        const spec = CHECK_ITEMS[item.key];
        if (item.key === 'checksFailed') el.style.color = spec.color!;
        const icon = doc.createElement('span');
        icon.style.cssText = `display:inline-flex;flex:none;width:12px;height:12px${spec.color && item.key !== 'checksFailed' ? `;color:${spec.color}` : ''}`;
        icon.innerHTML = appIconMarkup(spec.icon);
        const count = doc.createElement('span');
        count.style.cssText = 'font-weight:500;font-variant-numeric:tabular-nums';
        count.textContent = String(item.count);
        el.append(icon, count, doc.createTextNode(item.label));
      } else {
        // 未解决评论用标题栏的强调色;可以合并 / 已合并用成功色;冲突用错误色;其余次要文字色。
        const color = item.key === 'threadsOpen' ? 'var(--status-bar-accent)'
          : item.tone === 'bad' ? 'var(--error-fg)'
            : item.key === 'mergeReady' || item.key === 'merged' ? 'var(--status-success)' : '';
        if (color) el.style.color = color;
        el.textContent = item.label;
      }
      row.append(el);
    }
    slot.replaceChildren(row);
  }
  return autoArchive;
}
