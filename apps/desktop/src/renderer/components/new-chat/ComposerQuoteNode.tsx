/**
 * Read-only inline atom used for selected-text quotes inside ChatInput.
 *
 * The quote stays compact and immutable while prose remains editable directly
 * before/after it. The chip truncates long text and exposes the full quote on
 * hover; users can select the atom and delete it with Backspace/Delete.
 *
 * The remove button lives here (outside the atomic chip) so that
 * InlineReferenceChip remains a pure visual shell with no close button,
 * preserving the composer chip presentation invariant.
 */
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerQuoteAttrsToChatQuote,
  type ComposerQuoteAttrs,
} from '@/lib/composerQuoteDocument';
import { QuoteChip } from '@/components/chat/QuoteChip';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

function parsePositiveLineAttribute(element: HTMLElement, name: string): number | null {
  const raw = element.getAttribute(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function ComposerQuoteNodeView({ node, selected, editor, getPos }: NodeViewProps) {
  const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);
  // 用 useTranslation 的 t 而不是直接 i18n.t:NodeView 会随运行时语言切换
  // 重新渲染,删除按钮的 aria-label 与可见 Tip 文案同步刷新(不订阅 languageChanged
  // 只读一次当前值的话,切换语言后文案会留在旧语言直到节点因其他原因更新)。
  const { t } = useTranslation();
  const removeLabel = t('chat.quote.remove');

  const handleRemove = () => {
    // 编辑器被锁定（发送预检 / 语音处理 / 远程只读等 editor.setEditable(false)）
    // 时不允许改动草稿：deleteRange 不受 DOM editable 状态限制，必须在此拦截。
    if (!editor.isEditable) return;
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos === undefined) return;
    // Delete the atom node (nodeSize = 1 for inline atoms).
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + 1 })
      .run();
  };

  return (
    <NodeViewWrapper
      as="span"
      data-composer-quote=""
      data-drag-handle=""
      draggable={true}
      contentEditable={false}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      className={cn(
        'group/quote relative inline-flex max-w-[min(240px,55vw)] cursor-grab select-none align-middle active:cursor-grabbing',
      )}
    >
      <QuoteChip quote={quote} selected={selected} />
      {/* Remove button — sibling of the chip, not inside it.
          opacity-0 by default; visible on group hover and keyboard focus.
          真实 <button> + 共享 Tip（DESIGN.md §14.6）：icon-only 控件必须同时有
          本地化 accessible name 与可见 Tip，且不用 native title。 */}
      <Tip text={removeLabel} side="top">
        <button
          type="button"
          aria-label={removeLabel}
          className={cn(
            'absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center',
            'rounded-full bg-[var(--surface-chip-alt)] text-[var(--text-tertiary)]',
            'opacity-0 transition-opacity group-hover/quote:opacity-100',
            'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
            // 点击目标 ≥24×24(DESIGN.md §5:hit-testing 与可见几何是独立职责,
            // 命中区可扩大但不得改变可见几何)。透明 ::after 把命中框扩展到
            // 14px 可见圆四周各 5px,视觉保持 10px 图标 + 14px 圆不变。
            'after:absolute after:inset-[-5px] after:rounded-full after:content-[""]',
          )}
          onClick={(e) => {
            e.stopPropagation();
            handleRemove();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // 真实 button 的原生键盘激活会再触发一次 click，这里显式处理并
            // preventDefault 防止重复删除；stopPropagation 阻止 Enter/Space
            // 冒泡到 ProseMirror / ChatInput.handleKeyDown 触发发送。
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              handleRemove();
            }
          }}
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      </Tip>
    </NodeViewWrapper>
  );
}

export const ComposerQuoteNode = Node.create<Record<string, never>, Record<string, never>>({
  name: COMPOSER_QUOTE_NODE_TYPE,
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-quote-text') ?? element.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-quote-text': attrs.text }),
      },
      sourcePath: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-source-path') || null,
        renderHTML: (attrs) =>
          attrs.sourcePath == null ? {} : { 'data-source-path': attrs.sourcePath },
      },
      startLine: {
        default: null,
        parseHTML: (element) => parsePositiveLineAttribute(element, 'data-start-line'),
        renderHTML: (attrs) =>
          attrs.startLine == null ? {} : { 'data-start-line': attrs.startLine },
      },
      endLine: {
        default: null,
        parseHTML: (element) => parsePositiveLineAttribute(element, 'data-end-line'),
        renderHTML: (attrs) =>
          attrs.endLine == null ? {} : { 'data-end-line': attrs.endLine },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-composer-quote]' },
      // Compatibility with drafts / clipboard HTML from the first block-card preview.
      { tag: 'div[data-composer-quote]' },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-quote': '',
        contenteditable: 'false',
      }),
      quote.text,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ComposerQuoteNodeView);
  },
});
