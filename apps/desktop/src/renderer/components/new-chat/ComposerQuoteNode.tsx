/**
 * Read-only inline atom used for selected-text quotes inside ChatInput.
 *
 * The quote stays compact and immutable while prose remains editable directly
 * before/after it. The chip truncates long text and exposes the full quote on
 * hover; users can select the atom and delete it with Backspace/Delete.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import {
  COMPOSER_QUOTE_NODE_TYPE,
  composerQuoteAttrsToChatQuote,
  type ComposerQuoteAttrs,
} from '@/lib/composerQuoteDocument';
import { QuoteChip } from '@/components/chat/QuoteChip';

function parsePositiveLineAttribute(element: HTMLElement, name: string): number | null {
  const raw = element.getAttribute(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function ComposerQuoteNodeView({ node, selected }: NodeViewProps) {
  const quote = composerQuoteAttrsToChatQuote(node.attrs as ComposerQuoteAttrs);

  return (
    <NodeViewWrapper
      as="span"
      data-composer-quote=""
      data-drag-handle=""
      draggable={true}
      contentEditable={false}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      className="inline-flex max-w-[min(240px,55vw)] cursor-grab select-none align-middle active:cursor-grabbing"
    >
      <QuoteChip quote={quote} selected={selected} />
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
      comment: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-quote-comment') || null,
        renderHTML: (attrs) =>
          attrs.comment == null ? {} : { 'data-quote-comment': attrs.comment },
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
