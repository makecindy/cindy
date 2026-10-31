/**
 * 卡片 PR 状态位 —— 插件在 div 上标 `data-ghost-pr-status="owner/repo#123"`,宿主用标题栏
 * 同一份 PR 状态(PrRefsContext,随标题栏一起定时刷新)替换其内容。
 *
 * 插件卡片在调用结束后是静态快照,PR 的检查状态却随时在变;交给宿主填写后,卡片和标题栏
 * 永远一致,也不必等 Agent 下一轮回写。插件写在里面的内容是兜底:旧版宿主、手机,或这条
 * PR 不在本任务的 PR 列表里(宿主查不到)时原样显示。
 */
import type { PrStatusResult } from '@/lib/gitContext.types';

const SLOT_SELECTOR = 'div[data-ghost-pr-status]';
const SLOT_ATTR_RE = / data-ghost-pr-status="([^"]+)"/;
const SLOT_VALUE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const GREEN = 'light-dark(#2ea043,#3fb950)';

type Tone = 'good' | 'bad' | 'wait';
type Label = (key: string, options?: Record<string, unknown>) => string;

/** 状态位的值 → prStatusKey 形式(owner/repo 小写)。不合格返回 null。 */
export function prStatusSlotKey(value: string): string | null {
  const m = SLOT_VALUE_RE.exec(value.trim());
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}#${Number(m[3])}` : null;
}

/** 从净化后的卡片 html 里取第一个状态位的 key(订阅用;没有状态位返回 null)。 */
export function readPrStatusSlotKey(html: string): string | null {
  const m = SLOT_ATTR_RE.exec(html);
  return m ? prStatusSlotKey(m[1]) : null;
}

/** 与 GitHub 插件的状态行同一套措辞和取舍:CI、未解决意见、能否合并。 */
export function prStatusItems(status: Extract<PrStatusResult, { ok: true }>, t: Label): Array<[Tone, string]> {
  const items: Array<[Tone, string]> = [];
  const checks = status.checks;
  if (checks && checks.total > 0) {
    if (checks.failed > 0) items.push(['bad', t('chat.ghostCall.prStatus.ciFailed')]);
    else if (checks.pending > 0) items.push(['wait', t('chat.ghostCall.prStatus.ciRunning')]);
    else items.push(['good', t('chat.ghostCall.prStatus.ciPassed')]);
  }
  if (status.unresolvedCount !== null) {
    items.push(status.unresolvedCount > 0
      ? ['wait', t('chat.ghostCall.prStatus.threadsOpen', { count: status.unresolvedCount })]
      : ['good', t('chat.ghostCall.prStatus.threadsNone')]);
  }
  if (status.status === 'merged') items.push(['good', t('chat.ghostCall.prStatus.merged')]);
  else if (status.status === 'closed') items.push(['wait', t('chat.ghostCall.prStatus.closed')]);
  else if (status.status === 'draft') items.push(['wait', t('chat.ghostCall.prStatus.draft')]);
  // 旧版宿主(远程电脑)不带这两个字段:不猜,省掉这一项。
  else if (status.mergeState !== undefined || status.reviewDecision !== undefined) {
    if (status.mergeState === 'DIRTY') items.push(['bad', t('chat.ghostCall.prStatus.mergeConflict')]);
    else if (status.mergeState === 'BEHIND') items.push(['wait', t('chat.ghostCall.prStatus.mergeBehind')]);
    else if (status.mergeState === 'CLEAN') items.push(['good', t('chat.ghostCall.prStatus.mergeReady')]);
    else if (status.reviewDecision === 'CHANGES_REQUESTED') items.push(['wait', t('chat.ghostCall.prStatus.mergeChanges')]);
    else if (status.reviewDecision === 'REVIEW_REQUIRED') items.push(['wait', t('chat.ghostCall.prStatus.mergeApproval')]);
    else items.push(['wait', t('chat.ghostCall.prStatus.mergeWaiting')]);
  }
  return items;
}

/**
 * 用宿主的 PR 状态替换卡片文档里的状态位。查不到状态(或状态失败、一项都没有)时保留插件的
 * 兜底内容;同一份文档可反复调用(状态刷新时重填)。
 */
export function fillGhostCardPrStatus(
  doc: Document,
  lookup: (key: string) => PrStatusResult | undefined,
  t: Label,
): void {
  for (const slot of Array.from(doc.querySelectorAll<HTMLElement>(SLOT_SELECTOR))) {
    const key = prStatusSlotKey(slot.getAttribute('data-ghost-pr-status') ?? '');
    const status = key ? lookup(key) : undefined;
    if (!status?.ok) continue;
    const items = prStatusItems(status, t);
    if (!items.length) continue;
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 16px';
    for (const [tone, label] of items) {
      const item = doc.createElement('div');
      item.style.cssText = `display:inline-flex;align-items:center;gap:6px${tone === 'good' ? ';color:var(--text-primary)' : ''}`;
      const dot = doc.createElement('span');
      dot.style.cssText = `flex:none;width:7px;height:7px;border-radius:50%;${
        tone === 'good' ? `background:${GREEN}` : tone === 'bad' ? 'background:var(--error-fg,#d93025)' : 'border:1.5px solid var(--text-tertiary)'
      }`;
      item.append(dot, doc.createTextNode(label));
      row.append(item);
    }
    slot.replaceChildren(row);
  }
}
