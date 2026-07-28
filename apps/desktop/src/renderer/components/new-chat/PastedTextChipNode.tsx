/**
 * Atomic long-paste chip for the composer. The full text remains the payload
 * sent to the Agent; the NodeView only collapses its editable presentation.
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { FileText } from 'lucide-react';

import { InlineReferenceChip } from '@/components/chat/InlineReferenceChip';

export interface PastedTextChipAttrs {
  /** Full original text, inlined unchanged when the message is sent. */
  text: string;
  /** Localized compact label, including line count. */
  display: string;
}

/** Update or delete one captured long-paste atom without touching neighbours. */
export function applyPastedTextChipEdit(
  editor: Editor,
  nodePos: number,
  expectedText: string,
  nextAttrs: PastedTextChipAttrs | null,
): boolean {
  const { doc } = editor.state;
  if (!Number.isInteger(nodePos) || nodePos < 0 || nodePos >= doc.content.size) return false;
  const current = doc.nodeAt(nodePos);
  if (
    !current ||
    current.type.name !== 'pastedTextChip' ||
    (current.attrs as PastedTextChipAttrs).text !== expectedText
  ) {
    return false;
  }

  const tr = nextAttrs
    ? editor.state.tr.setNodeMarkup(nodePos, undefined, { ...current.attrs, ...nextAttrs })
    : editor.state.tr.delete(nodePos, nodePos + current.nodeSize);
  editor.view.dispatch(closeHistory(tr));
  return true;
}

/** Replace an oversized edited chip with ordinary text while preserving line breaks. */
export function replacePastedTextChipWithPlainText(
  editor: Editor,
  nodePos: number,
  expectedText: string,
  nextText: string,
): boolean {
  const { doc } = editor.state;
  if (!Number.isInteger(nodePos) || nodePos < 0 || nodePos >= doc.content.size) return false;
  const current = doc.nodeAt(nodePos);
  if (
    !current ||
    current.type.name !== 'pastedTextChip' ||
    (current.attrs as PastedTextChipAttrs).text !== expectedText
  ) {
    return false;
  }

  const hardBreak = editor.state.schema.nodes.hardBreak;
  if (!hardBreak) return false;
  const nodes: ProseMirrorNode[] = [];
  nextText.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(hardBreak.create());
    if (line) nodes.push(editor.state.schema.text(line));
  });
  const tr = editor.state.tr.replaceWith(
    nodePos,
    nodePos + current.nodeSize,
    Fragment.from(nodes),
  );
  editor.view.dispatch(closeHistory(tr));
  return true;
}

function PastedTextChipNodeView({ node, selected }: NodeViewProps) {
  const attrs = node.attrs as PastedTextChipAttrs;

  return (
    <NodeViewWrapper
      as="span"
      data-pasted-text-chip=""
      data-pasted-text={attrs.text}
      data-display={attrs.display}
      data-drag-handle=""
      draggable={true}
      contentEditable={false}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      className="inline-flex max-w-[min(240px,55vw)] cursor-grab select-none align-middle active:cursor-grabbing"
    >
      <InlineReferenceChip
        label={attrs.display}
        icon={<FileText aria-hidden />}
        tooltip={attrs.text}
        tooltipMono
        tooltipContentClassName="max-h-64 w-80 max-w-[70vw] overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]"
        ariaLabel={attrs.display}
        selected={selected}
        // 同 MentionChipNode:composer 的原子节点不参与文字级 selection。
        textSelectable={false}
        className="cursor-pointer"
      />
    </NodeViewWrapper>
  );
}

export const PastedTextChipNode = Node.create<Record<string, never>, Record<string, never>>({
  name: 'pastedTextChip',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        // Clipboard serialization must carry the full bounded payload so
        // copying and pasting this atom does not silently drop text.
        parseHTML: (element) => element.getAttribute('data-pasted-text') ?? '',
        renderHTML: (attrs) => ({ 'data-pasted-text': attrs.text }),
      },
      display: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-display') ?? '',
        renderHTML: (attrs) => ({ 'data-display': attrs.display }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-pasted-text-chip]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as PastedTextChipAttrs;
    const chipAttrs = mergeAttributes(HTMLAttributes, {
      'data-pasted-text-chip': '',
      'aria-label': attrs.display,
      class:
        'inline-flex min-w-0 max-w-[min(240px,55vw)] select-none items-center align-middle ' +
        'gap-1.5 rounded-full border border-[var(--border-default)] px-2 py-0.5 ' +
        'bg-[var(--surface-chip)] text-[var(--text-primary)] text-[12px] font-normal leading-5',
      style: 'color: var(--text-primary); user-select: none; -webkit-user-select: none; -webkit-user-drag: element;',
      draggable: 'true',
      contenteditable: 'false',
    });
    return [
      'span',
      chipAttrs,
      [
        'http://www.w3.org/2000/svg svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: '14',
          height: '14',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          style: 'color: var(--text-primary); flex-shrink: 0;',
        },
        ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
        ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
        ['path', { d: 'M10 9H8' }],
        ['path', { d: 'M16 13H8' }],
        ['path', { d: 'M16 17H8' }],
      ],
      ['span', { class: 'min-w-0 truncate' }, attrs.display],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PastedTextChipNodeView);
  },
});
