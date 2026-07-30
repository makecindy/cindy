/**
 * PlanReviewBubble
 * ---------------------------------------------------------------------------
 * FP-8: Renders a plan_review message in the chat flow. Four states:
 *
 *   pending  — simple "Agent is waiting for plan approval" hint (the real UI
 *              is the Plan Viewer Card + Action Card in the bottom region).
 *   approved — rendered plan Markdown (collapsed preview + expand toggle)
 *              + "Approved" badge.
 *   revised  — user's feedback text, styled as a quoted assistant-side note.
 *   expired  — the session was closed before the user decided; read-only.
 *   cancelled— the user dismissed the review (agent stays in plan mode).
 *
 * 计划正文走 MarkdownRenderer(与底部 Plan Viewer Card 同一个渲染器),不再直出
 * Markdown 源码 —— 历史里回看计划时标题层级、列表、表格、代码块都应该是排版好
 * 的样子,和 agent 当时给出的 Plan Viewer 观感一致。
 *
 * Styling mirrors AskUserQuestionBubble for visual cohesion: same 12px radius,
 * 1px Board border, 20px padding, ask-card tokens (the bubble is a neutral
 * info surface, not a primary action). All colors are grayscale per docs/design-rules/cindy-design-system.md.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { KnownLocalFileRef } from '@/lib/localPathResolver';
import { MarkdownRenderer } from './MarkdownRenderer';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PlanReviewBubbleProps {
  message: ChatMessage;
  /** Session cwd — forwarded to MarkdownRenderer so local-path links inside the
   *  plan (e.g. `apps/desktop/src/...`) resolve to the right file. */
  workingDir: string;
  /**
   * 计划正文是**会话消息内容**,所以要拿到和 AssistantMessage 同一套解析上下文,
   * 而不是 TextLightbox 那种"渲染文件内容"的裸调用:
   *   - currentSessionId 是 MarkdownRenderer 里远程媒体改写的门控 —— 缺了它
   *     remoteMediaOrigin 恒 undefined,device / ssh 会话里计划内的图片/音频会
   *     去加载本机 URL 而不是走 cindy-remote-media:// 管道,直接坏图。
   *   - localFileRefs 把计划里 `[spec.docx](spec.docx)` 这类写法解析回用户上传
   *     的原附件路径。
   *   - currentSessionTitle 供计划里可能出现的会话交接卡片构建返回链接。
   */
  currentSessionId?: string;
  currentSessionTitle?: string | null;
  localFileRefs?: readonly KnownLocalFileRef[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 折叠态高度上限(px)。渲染后的 Markdown 没法按"源码行数"截断 —— 截在围栏
 * 代码块或表格中间会让语法失效,所以整段照常解析,只在容器上限高 + 底部渐隐。
 *
 *   approved  ≈ 一个标题 + 两三行正文,足够认出"这是哪份计划"。
 *   expired / cancelled 是失效痕迹,只给更浅的一瞥(展开入口三态都有,见
 *   PlanMarkdownBody —— 被裁的内容必须给得出揭示途径)。
 */
const APPROVED_COLLAPSED_MAX_HEIGHT = 120;
const INACTIVE_COLLAPSED_MAX_HEIGHT = 56;

/**
 * 折叠态底部的淡出遮罩(见 PlanMarkdownBody 里的说明)。与 TabBar 的溢出 fade
 * 同一写法:`black` / `transparent` 在这里是 mask 的 alpha 载体,不是主题色值,
 * 所以不走 token(也不受"组件内禁止硬编码颜色"约束)。
 */
const COLLAPSED_FADE_MASK =
  'linear-gradient(to bottom, black calc(100% - 28px), transparent 100%)';

/** 折叠时要从 tab 序里摘掉的元素(MarkdownRenderer 会产出链接、文件 chip、
 *  代码块复制按钮、媒体控件,其中 chip 靠 tabIndex={0} 参与键盘导航)。 */
const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, summary, audio[controls], video[controls], [tabindex], [contenteditable="true"]';

/** 暂存被改动前的 tabindex 原值,空串表示"原本没有这个属性"。属性跟着节点走,
 *  React 重渲染换了节点也不会把还原值串到别的元素上。 */
const SAVED_TABINDEX_ATTR = 'data-plan-collapse-tabindex';

/**
 * 把 root 内"底边超过 cutoff"的可聚焦元素移出 tab 序;cutoff 为 null(未折叠)
 * 时全部还原。
 *
 * 判据用底边而不是顶边:跨在裁剪线上的控件只露出一半,聚焦它同样会把
 * overflow-hidden 容器滚起来,所以按"不完全可见"处理。只改 tabindex、不加
 * aria-hidden —— 读屏用户没有"折叠"这个视觉概念,把内容从 a11y 树里摘掉是净
 * 损失;避免"激活看不见的控件"只需要它进不了 tab 序。
 */
function syncClippedFocusability(root: HTMLElement, cutoff: number | null): void {
  const rootTop = root.getBoundingClientRect().top;
  root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR).forEach((el) => {
    const saved = el.getAttribute(SAVED_TABINDEX_ATTR);
    const clipped =
      cutoff != null && el.getBoundingClientRect().bottom - rootTop > cutoff;

    if (clipped) {
      if (saved == null) {
        el.setAttribute(SAVED_TABINDEX_ATTR, el.getAttribute('tabindex') ?? '');
      }
      el.setAttribute('tabindex', '-1');
      return;
    }

    if (saved == null) return;
    if (saved === '') el.removeAttribute('tabindex');
    else el.setAttribute('tabindex', saved);
    el.removeAttribute(SAVED_TABINDEX_ATTR);
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlanReviewBubble({
  message,
  workingDir,
  currentSessionId,
  currentSessionTitle,
  localFileRefs,
}: PlanReviewBubbleProps) {
  const { t } = useTranslation();
  const status = message.planReviewStatus ?? 'pending';
  // Important #4: planReviewPlan is the single source of truth. No fallback
  // to message.content — that field is intentionally left empty for
  // plan_review messages.
  const plan = message.planReviewPlan ?? '';
  const feedback = message.planReviewFeedback ?? '';

  const showApprovedBadge = status === 'approved';

  return (
    <div
      className={cn(
        'w-full rounded-[12px] border p-[20px]',
        'border-[var(--ask-card-border)] bg-[var(--ask-card-bg)]',
        'flex flex-col gap-[12px]',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-[8px]">
        <span className="text-13 font-semibold text-[var(--ask-header-text)]">
          {t('chat.planReviewBubble.title')}
        </span>
        {/* badge / 状态短语是 UI chrome,禁选;标题与正文保持可选 */}
        {showApprovedBadge && (
          <span
            className={cn(
              'select-none rounded-[6px] px-[8px] py-[2px] text-12 font-medium',
              'bg-[var(--plan-bubble-badge-bg)] text-[var(--plan-bubble-badge-text)]',
            )}
          >
            {t('chat.planReviewBubble.approved')}
          </span>
        )}
        {status === 'revised' && (
          <span
            className={cn(
              'select-none rounded-[6px] px-[8px] py-[2px] text-12 font-medium',
              'bg-[var(--plan-bubble-badge-bg)] text-[var(--plan-bubble-badge-text)]',
            )}
          >
            {t('chat.planReviewBubble.revisionRequested')}
          </span>
        )}
        {status === 'expired' && (
          <span className="select-none text-13 italic text-[var(--ask-expired-text)]">
            {t('chat.planReviewBubble.expired')}
          </span>
        )}
        {status === 'cancelled' && (
          <span className="select-none text-13 italic text-[var(--ask-expired-text)]">
            {t('chat.planReviewBubble.cancelled')}
          </span>
        )}
      </div>

      {/* Body per status */}
      {status === 'pending' && (
        <p className="text-14 text-[var(--ask-option-desc)]">
          {t('chat.planReviewBubble.pendingHint')}
        </p>
      )}

      {status === 'approved' && (
        <PlanMarkdownBody
          workingDir={workingDir}
          currentSessionId={currentSessionId}
          currentSessionTitle={currentSessionTitle}
          localFileRefs={localFileRefs}
          plan={plan}
          collapsedMaxHeight={APPROVED_COLLAPSED_MAX_HEIGHT}
        />
      )}

      {status === 'revised' && (
        <div className="flex flex-col gap-[4px]">
          <span className="text-13 text-[var(--ask-answered-text)]">
            {t('chat.planReviewBubble.feedbackLabel')}
          </span>
          {/* 反馈是用户自己敲的原话,保持纯文本(不当 Markdown 解析)。 */}
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-14 leading-[1.6]',
              'text-[var(--plan-bubble-body-text)]',
            )}
          >
            {feedback || t('chat.planReviewBubble.noFeedback')}
          </p>
        </div>
      )}

      {(status === 'expired' || status === 'cancelled') && plan && (
        <PlanMarkdownBody
          workingDir={workingDir}
          currentSessionId={currentSessionId}
          currentSessionTitle={currentSessionTitle}
          localFileRefs={localFileRefs}
          plan={plan}
          collapsedMaxHeight={INACTIVE_COLLAPSED_MAX_HEIGHT}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * 渲染后的计划正文 + 折叠。
 *
 * 折叠不按源码行数,而是按渲染结果的实际高度:标题、列表、表格、代码块各自的
 * 行高与外边距差得很远,行数和视觉高度没有稳定关系,而"能否展开"必须和用户
 * 真正看到的有没有被切掉一致 —— 否则会出现按钮点了没变化(或该给按钮时没给)。
 *
 * 折叠只裁"看得见",所以被裁掉的链接 / 文件 chip / 代码块按钮仍留在 tab 序里:
 * 键盘能聚焦并激活一个看不见的控件,而且焦点一进去浏览器就会滚动这个
 * overflow-hidden 容器,把折叠预览顶掉。修法是**只**把不完全可见的可聚焦元素
 * 移出 tab 序(syncClippedFocusability),不整块 inert —— inert 会连带禁掉预览
 * 文字的选中,而 DESIGN.md §14.1 要求消息正文默认可选。可见控件因此照常能点,
 * 被裁内容对读屏仍可读(只是 tab 不到),任何会被裁的状态都给得出展开入口 ——
 * 三态共用同一个折叠 + 展开机制,只有折叠高度不同。
 */
function PlanMarkdownBody({
  workingDir,
  currentSessionId,
  currentSessionTitle,
  localFileRefs,
  plan,
  collapsedMaxHeight,
}: {
  workingDir: string;
  currentSessionId?: string;
  currentSessionTitle?: string | null;
  localFileRefs?: readonly KnownLocalFileRef[];
  plan: string;
  collapsedMaxHeight: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // 测高元素刻意放在限高容器**内层**:外层被 max-height 夹住后尺寸恒定,
  // ResizeObserver 观察它拿不到内容变化(图片/字体/窗口宽度导致的回流)。
  const bodyRef = useRef<HTMLDivElement>(null);

  // useLayoutEffect:首帧就在 paint 前定下折叠与否,否则长计划会先整段铺开
  // 再收起,滚动位置和卡片高度跳一下。tab 序同步也放这里 —— 它依赖布局,必须
  // 在同一时机跟着高度一起算,并由 ResizeObserver 在图片加载 / 字体就位 /
  // 窗口改宽导致回流后重算。
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const sync = () => {
      const tooTall = el.offsetHeight > collapsedMaxHeight + 1;
      setOverflowing(tooTall);
      syncClippedFocusability(el, tooTall && !expanded ? collapsedMaxHeight : null);
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsedMaxHeight, plan, expanded]);

  const collapsed = !expanded && overflowing;

  return (
    <div className="flex flex-col gap-[8px]">
      <div
        className={cn('min-w-0', collapsed && 'overflow-hidden')}
        style={
          collapsed
            ? ({
                maxHeight: collapsedMaxHeight,
                // 截断处淡出,提示"下面还有"。用 mask-image(按 alpha 吃掉内容)而
                // 不是叠一层卡片色渐变:透出的是卡片自己的底色,Light / Dark /
                // 任意扩展主题天然正确,也没有 from-transparent 那种插值灰边。
                WebkitMaskImage: COLLAPSED_FADE_MASK,
                maskImage: COLLAPSED_FADE_MASK,
              } as React.CSSProperties)
            : undefined
        }
      >
        <div
          ref={bodyRef}
          className={cn(
            'min-w-0 text-14 leading-[1.6]',
            'text-[var(--plan-bubble-body-text)]',
            // 首尾块元素的外边距归零,避免卡片内出现比 20px padding 更大的留白。
            '[&_.msg-markdown>*:first-child]:mt-0',
            '[&_.msg-markdown>*:last-child]:mb-0',
          )}
        >
          <MarkdownRenderer
            workingDir={workingDir}
            content={plan}
            currentSessionId={currentSessionId}
            currentSessionTitle={currentSessionTitle}
            localFileRefs={localFileRefs}
          />
        </div>
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'inline-flex w-fit items-center gap-[4px] text-12',
            'text-[var(--ask-option-desc)] hover:text-[var(--ask-header-text)]',
            'transition-colors',
          )}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>
            {expanded
              ? t('chat.planReviewBubble.collapse')
              : t('chat.planReviewBubble.showFull')}
          </span>
        </button>
      )}
    </div>
  );
}
