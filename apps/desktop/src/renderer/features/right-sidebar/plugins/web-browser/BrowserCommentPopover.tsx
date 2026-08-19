/**
 * BrowserCommentPopover —— 页面评论的宿主侧输入气泡。
 *
 * 渲染在 webview slot(relative 容器)内、绝对定位锚在 guest 上报的点选坐标
 * (guest viewport 坐标 = webview 元素内坐标 = slot 内坐标,webview 100% 填充
 * slot,可直接复用)。评论编辑器放宿主侧而非注入页面 —— 避免在任意第三方页面
 * 里塞输入组件(CSP / 样式污染 / 焦点战争),与 Codex 的 host-side editor
 * 结构一致。
 *
 * 交互:
 *  - Enter 提交,Shift+Enter 换行(与聊天输入一致的心智)。
 *  - Esc / 取消按钮 → onCancel(回到点选态,marker 清除)。
 *  - submitting 时按钮禁用,防重复提交。
 *  - **样式反馈(Phase 3,对齐 Codex styling feedback)**:元素点选且 guest
 *    采到 designBaseline 时,输入框旁出现调节图标 → 展开样式编辑区(文本 /
 *    颜色 / 背景 / 字号 / 字重 / 内边距 / 圆角)。任何改动实时经
 *    onPreviewDesign 应用到页面元素上预览;重置还原;提交时把 old → new
 *    diff 作为 styleChanges 交给 onSubmit(有样式改动时允许空评论)。
 *
 * 定位:优先显示在锚点下方 12px;越界时上翻 / 水平 clamp 进 slot。测量在
 * useLayoutEffect(paint 前),不会闪一帧再跳位(规则 7)。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { parseCssColor } from '@/lib/browserComments';
import { cn } from '@/lib/utils';

import {
  BROWSER_COMMENT_DESIGN_PROPS,
  type BrowserCommentDesignBaseline,
  type BrowserCommentDesignPreviewPayload,
  type BrowserCommentStyleChange,
} from '../../../../../shared/browserComment';
import type { BrowserCommentEditorDraft } from './browserCommentEditorDraft';

interface BrowserCommentPopoverProps {
  /** 锚点(slot 内坐标,px)。 */
  anchor: { x: number; y: number };
  submitting: boolean;
  /** 样式编辑基线(元素点选才有;null = 不显示样式编辑入口)。 */
  designBaseline: BrowserCommentDesignBaseline | null;
  /** 由稳定的 Host 控制器持有，避免 WebView LRU 换代卸载气泡时丢失输入。 */
  editorDraft: BrowserCommentEditorDraft;
  onEditorDraftChange: (draft: BrowserCommentEditorDraft) => void;
  onSubmit: (text: string, styleChanges?: BrowserCommentStyleChange[]) => void;
  onCancel: () => void;
  /** 样式编辑实时预览(全量当前编辑状态)。 */
  onPreviewDesign: (payload: BrowserCommentDesignPreviewPayload) => void;
  /** 样式编辑重置(guest 还原全部预览)。 */
  onResetDesign: () => void;
}

const POPOVER_WIDTH = 300;
const ANCHOR_GAP = 12;
const SLOT_PADDING = 8;

// parseCssColor 收口到 @/lib/browserComments(草稿基线链修复也要用同一套
// 颜色等价语义,alpha 保留的理由见该函数注释),此处仅消费。

/**
 * `rgb(a)` → `#rrggbb`(alpha 丢弃);解析失败返回 null(该属性退回文本框)。
 * 仅供 `<input type="color">` 的 value 使用 —— 它本就无法表达 alpha,故此处丢弃
 * 合理;等价判定另走 `isSameStyleValue`(保留 alpha),不要用本函数比较颜色。
 */
function cssColorToHex(raw: string): string | null {
  const c = parseCssColor(raw);
  if (!c) return null;
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/**
 * 基线可用取色器编辑时返回其 hex 初值;**非不透明基线(alpha < 1,含
 * transparent)返回 null,该属性退回文本框** —— 比较器保留 alpha 只解决了
 * diff 判定,取色器初始化仍会把透明基线折叠成 `#000000` / `#ffffff`,用户再选
 * 同 RGB 的不透明色时 `<input type="color">` 值不变、onChange 根本不触发,
 * 「透明 → 不透明同色」永远发不出去(Codex review P2 二次发现)。文本框路径
 * 可直接手输 `#000000` 等任意合法 CSS 颜色,经 RGBA 比较器正确判为变更。
 */
function pickerHexForBaseline(raw: string): string | null {
  const c = parseCssColor(raw);
  if (!c || c.a < 1) return null;
  return cssColorToHex(raw);
}

const COLOR_PROPS = new Set(['color', 'background-color']);

/**
 * 判断某属性当前值与基线是否等价(diff 判定用)。颜色属性两侧格式常不一致
 * ——baseline 来自 `getComputedStyle`(`rgb(38, 38, 38)`),颜色选择器回填 `#262626`
 * ——直接字符串比较会把"还原到同一视觉值"误判为改动,产生虚假的样式变更块。
 * 故颜色属性先各自解析成 RGBA 再逐通道(含 alpha)比较;归一失败(异常格式)退回
 * 原始字符串比较。保留 alpha 是为了让 `rgba(0, 0, 0, 0)` 这类透明基线不会与不透明
 * hex 误判等价 —— 否则把透明改成不透明黑/白会被过滤掉。
 */
function isSameStyleValue(property: string, a: string, b: string): boolean {
  if (COLOR_PROPS.has(property)) {
    const ca = parseCssColor(a);
    const cb = parseCssColor(b);
    if (ca && cb) return ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && ca.a === cb.a;
  }
  return a === b;
}

export function BrowserCommentPopover({
  anchor,
  submitting,
  designBaseline,
  editorDraft,
  onEditorDraftChange,
  onSubmit,
  onCancel,
  onPreviewDesign,
  onResetDesign,
}: BrowserCommentPopoverProps) {
  const { t } = useTranslation();
  // 展开 / 收起只影响本次挂载的布局；真正的文本与样式草稿由 Host 控制器持有。
  const [showStyles, setShowStyles] = useState(false);
  const { text, styleEdits, textEdit } = editorDraft;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 初始按锚点下方摆;useLayoutEffect 量完实际尺寸后 clamp,一次到位。
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y + ANCHOR_GAP,
  });

  useLayoutEffect(() => {
    const el = rootRef.current;
    const slot = el?.parentElement;
    if (!el || !slot) return;
    const slotW = slot.clientWidth;
    const slotH = slot.clientHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.x - w / 2;
    let top = anchor.y + ANCHOR_GAP;
    // 下方放不下 → 上翻。
    if (top + h > slotH - SLOT_PADDING) {
      top = anchor.y - ANCHOR_GAP - h;
    }
    left = Math.max(SLOT_PADDING, Math.min(left, slotW - w - SLOT_PADDING));
    top = Math.max(SLOT_PADDING, Math.min(top, slotH - h - SLOT_PADDING));
    setPos({ left, top });
    // 打开即聚焦输入框(用户点完元素下一步就是打字)。展开样式区时不抢焦点。
    if (!showStyles) textareaRef.current?.focus();
    // 展开 / 收起样式区会改高度,重新 clamp。
  }, [anchor.x, anchor.y, showStyles]);

  /** 组装 styleChanges(提交用)与预览 payload(实时用)的共同数据源。 */
  const buildChanges = useCallback((): BrowserCommentStyleChange[] => {
    if (!designBaseline) return [];
    const changes: BrowserCommentStyleChange[] = [];
    if (
      designBaseline.editableText !== null &&
      textEdit !== null &&
      textEdit !== designBaseline.editableText
    ) {
      changes.push({
        property: 'text content',
        previousValue: designBaseline.editableText,
        value: textEdit,
      });
    }
    for (const [property, value] of Object.entries(styleEdits)) {
      const baseline = designBaseline.styles[property] ?? '';
      const trimmed = value.trim();
      if (trimmed && !isSameStyleValue(property, trimmed, baseline)) {
        changes.push({ property, previousValue: baseline, value: trimmed });
      }
    }
    return changes;
  }, [designBaseline, styleEdits, textEdit]);

  /** 任一控件变更后推全量预览(diff 语义由 guest 侧 apply/revert 实现)。 */
  const pushPreview = useCallback(
    (nextEdits: Record<string, string>, nextText: string | null) => {
      if (!designBaseline) return;
      const styles: Record<string, string> = {};
      for (const [property, value] of Object.entries(nextEdits)) {
        const trimmed = value.trim();
        if (
          trimmed &&
          !isSameStyleValue(property, trimmed, designBaseline.styles[property] ?? '')
        ) {
          styles[property] = trimmed;
        }
      }
      const textChanged =
        designBaseline.editableText !== null &&
        nextText !== null &&
        nextText !== designBaseline.editableText;
      onPreviewDesign({ styles, text: textChanged ? nextText : null });
    },
    [designBaseline, onPreviewDesign],
  );

  /**
   * LRU 恢复草稿可能绑定到一个包含子元素、不能安全改写 textContent 的新
   * target。此时旧 textEdit 与新 baseline 不兼容：预览必须发 null，并从
   * Host 草稿中删除该字段，避免稍后提交虚假的文本变更或破坏子 DOM。
   */
  useEffect(() => {
    if (!designBaseline || designBaseline.editableText !== null || textEdit === null) return;
    onEditorDraftChange({ ...editorDraft, textEdit: null });
  }, [designBaseline, editorDraft, onEditorDraftChange, textEdit]);

  /**
   * 预览由受控草稿派生，而不是只在 input handler 内发送。这样 WebView LRU
   * 换代后，Popover 绑定新 target 的首次挂载也会自动重放恢复的文本 / CSS
   * 编辑，保证页面截图与最终提交的 styleChanges 始终一致。
   */
  useEffect(() => {
    pushPreview(styleEdits, textEdit);
  }, [pushPreview, styleEdits, textEdit]);

  const setStyleEdit = useCallback(
    (property: string, value: string) => {
      const next = { ...styleEdits, [property]: value };
      onEditorDraftChange({
        ...editorDraft,
        styleEdits: next,
      });
    },
    [editorDraft, onEditorDraftChange, styleEdits],
  );

  const handleTextEdit = useCallback(
    (value: string) => {
      onEditorDraftChange({ ...editorDraft, textEdit: value });
    },
    [editorDraft, onEditorDraftChange],
  );

  const handleResetStyles = useCallback(() => {
    onEditorDraftChange({
      ...editorDraft,
      styleEdits: {},
      textEdit: null,
    });
    onResetDesign();
  }, [editorDraft, onEditorDraftChange, onResetDesign]);

  const changes = buildChanges();
  const canSubmit = (text.trim().length > 0 || changes.length > 0) && !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(text, changes.length > 0 ? changes : undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      // isComposing 守卫与 Enter 分支同款:CJK 输入法里 Esc 是"取消当前候选词",
      // 不加守卫会连气泡一起关掉,丢已输入文本与 marker(Greptile P1)。
      e.preventDefault();
      onCancel();
    }
  };

  const inputCls = cn(
    'w-full rounded-md border border-[var(--border-default)] bg-transparent',
    'px-2 py-1 text-12 leading-[1.4] text-[var(--text-primary)]',
    'placeholder:text-[var(--text-tertiary)] outline-none',
    'focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
  );
  const styleTweaksLabel = submitting
    ? t('rightSidebar.browser.styleTweaksSubmitting')
    : showStyles
      ? t('rightSidebar.browser.styleTweaksCollapse')
      : t('rightSidebar.browser.styleTweaksExpand');
  const styleTweaksButton = (
    <button
      type="button"
      aria-label={styleTweaksLabel}
      aria-hidden={submitting ? true : undefined}
      onClick={() => setShowStyles((v) => !v)}
      disabled={submitting}
      className={cn(
        'flex size-6 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        showStyles || changes.length > 0
          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
          : 'text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
      )}
    >
      <SlidersHorizontal size={13} strokeWidth={2} />
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={cn(
        'absolute z-20 flex flex-col gap-2 rounded-lg border border-[var(--border-default)]',
        'bg-[var(--surface-elevated)] p-2.5 shadow-[var(--shadow-menu)]',
      )}
      style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => onEditorDraftChange({ ...editorDraft, text: e.target.value })}
        onKeyDown={handleKeyDown}
        rows={3}
        disabled={submitting}
        placeholder={t('rightSidebar.browser.commentPlaceholder')}
        className={cn(
          'w-full resize-none rounded-md border border-[var(--border-default)] bg-transparent',
          'px-2 py-1.5 text-12 leading-[1.5] text-[var(--text-primary)]',
          'placeholder:text-[var(--text-tertiary)] outline-none',
          'focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
        )}
      />

      {/* 样式编辑区(Codex styling feedback):仅元素点选且基线可用时提供。 */}
      {designBaseline && showStyles && (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-default)] p-2">
          {designBaseline.editableText !== null && (
            <label className="flex items-center gap-2 text-11 text-[var(--text-secondary)]">
              <span className="w-[88px] shrink-0 truncate">
                {t('rightSidebar.browser.styleTextLabel')}
              </span>
              <input
                type="text"
                value={textEdit ?? designBaseline.editableText}
                onChange={(e) => handleTextEdit(e.target.value)}
                disabled={submitting}
                className={inputCls}
              />
            </label>
          )}
          {BROWSER_COMMENT_DESIGN_PROPS.map((property) => {
            const baseline = designBaseline.styles[property] ?? '';
            const value = styleEdits[property] ?? baseline;
            const hexBaseline = COLOR_PROPS.has(property) ? pickerHexForBaseline(baseline) : null;
            return (
              <label
                key={property}
                className="flex items-center gap-2 text-11 text-[var(--text-secondary)]"
              >
                {/* CSS 属性名是技术标识,保持原文不 i18n。 */}
                <span className="w-[88px] shrink-0 truncate font-mono">{property}</span>
                {COLOR_PROPS.has(property) && hexBaseline ? (
                  <input
                    type="color"
                    value={cssColorToHex(value) ?? hexBaseline}
                    onChange={(e) => setStyleEdit(property, e.target.value)}
                    disabled={submitting}
                    className="h-6 w-10 shrink-0 cursor-pointer rounded border border-[var(--border-default)] bg-transparent p-0.5"
                  />
                ) : (
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setStyleEdit(property, e.target.value)}
                    disabled={submitting}
                    className={inputCls}
                  />
                )}
              </label>
            );
          })}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleResetStyles}
              disabled={submitting}
              className={cn(
                'flex h-5 items-center rounded px-1.5 text-11',
                'text-[var(--text-tertiary)] hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
              )}
            >
              {t('rightSidebar.browser.styleReset')}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-1.5">
        {/* 左:样式编辑开关(Codex "config icon next to the text input")。 */}
        {designBaseline ? (
          <Tip text={styleTweaksLabel} side="bottom">
            {submitting ? (
              <span
                role="button"
                aria-disabled="true"
                aria-label={styleTweaksLabel}
                tabIndex={0}
                className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {styleTweaksButton}
              </span>
            ) : (
              styleTweaksButton
            )}
          </Tip>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={cn(
              'flex h-6 items-center rounded-md px-2 text-12',
              'text-[var(--text-secondary)] hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
              submitting && 'opacity-40',
            )}
          >
            {t('rightSidebar.browser.commentCancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              'flex h-6 items-center rounded-md px-2.5 text-12 font-medium',
              'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
              'hover:bg-[var(--accent-hover)]',
              !canSubmit && 'cursor-not-allowed opacity-40',
            )}
          >
            {t('rightSidebar.browser.commentSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}
