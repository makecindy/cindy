/**
 * Structured list nodes for the chat composer.
 *
 * The composer stores list structure in its ProseMirror document and only
 * turns it back into Markdown at send time. This keeps wrapping, nested
 * items, and inline atoms in one layout tree instead of estimating marker
 * widths with decorations.
 */
import { InputRule, Node, mergeAttributes, wrappingInputRule, type NodeConfig } from '@tiptap/core';
import { Fragment, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import { liftListItem, splitListItem } from '@tiptap/pm/schema-list';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

const BULLET_MARKER_RE = /^([-+*•])([ \t]+)$/;
const ORDERED_MARKER_RE = /^([1-9]\d{0,8})([.)])([ \t]+)$/;
const CJK_ORDERED_MARKER_RE = /^([1-9]\d{0,8})(、)$/;

type BulletMarker = '-' | '+' | '*' | '•';
type OrderedMarker = '.' | ')' | '、';

interface OrderedListAttrs {
  start: number;
  marker: OrderedMarker;
  separator: string;
}

interface SelectedTaskPrefix {
  from: number;
  to: number;
  bodyIsEmpty: boolean;
  caretAtOrAfterPrefix: boolean;
  caretAtParagraphEnd: boolean;
}

interface PlainListParagraphMarker {
  kind: 'bullet' | 'ordered';
  prefixLength: number;
  attrs: Record<string, unknown>;
}

interface FenceState {
  char: '`' | '~';
  length: number;
}

function fenceOpening(text: string): FenceState | null {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0] as FenceState['char'], length: match[1].length };
}

function isFenceClosing(text: string, state: FenceState): boolean {
  const pattern = new RegExp(`^ {0,3}${state.char}{${state.length},}[ \\t]*$`);
  return pattern.test(text);
}

function scanFenceState(text: string, initialFence: FenceState | null): FenceState | null {
  let fence = initialFence;
  for (const line of text.split('\n')) {
    if (fence) {
      if (isFenceClosing(line, fence)) fence = null;
      continue;
    }
    fence = fenceOpening(line);
  }
  return fence;
}

function paragraphOffsetIsInsideFence(paragraph: PMNode, offset: number): boolean {
  return scanFenceState(paragraph.textBetween(0, offset, '\n', '\n'), null) !== null;
}

function documentFenceStateBefore(doc: PMNode, position: number): FenceState | null {
  let fence: FenceState | null = null;
  doc.forEach((node, nodeOffset) => {
    if (nodeOffset >= position || node.type.name !== 'paragraph') return;
    fence = scanFenceState(node.textBetween(0, node.content.size, '\n', '\n'), fence);
  });
  return fence;
}

function plainListParagraphMarker(text: string): PlainListParagraphMarker | null {
  const bullet = text.match(/^([-+*•])([ \t]+)/);
  if (bullet) {
    return {
      kind: 'bullet',
      prefixLength: bullet[0].length,
      attrs: { marker: bullet[1], separator: bullet[2] },
    };
  }
  const ordered = text.match(/^([1-9]\d{0,8})([.)])([ \t]+)/);
  if (ordered) {
    return {
      kind: 'ordered',
      prefixLength: ordered[0].length,
      attrs: { start: Number(ordered[1]), marker: ordered[2], separator: ordered[3] },
    };
  }
  const cjkOrdered = text.match(/^([1-9]\d{0,8})(、)([ \t]*)/);
  if (cjkOrdered) {
    return {
      kind: 'ordered',
      // Keep optional spacing in the item body so direct transactions and
      // normalized documents serialize CJK markers identically.
      prefixLength: cjkOrdered[1].length + cjkOrdered[2].length,
      attrs: { start: Number(cjkOrdered[1]), marker: '、' },
    };
  }
  return null;
}

function hardBreakListInputRule(
  find: RegExp,
  type: NodeType,
  getAttributes: (match: RegExpMatchArray) => object = () => ({}),
): InputRule {
  return new InputRule({
    find: (text) => {
      const lineStart = text.lastIndexOf('\n');
      if (lineStart < 0) return null;
      const line = text.slice(lineStart + 1);
      const match = line.match(find);
      if (!match) return null;
      return {
        text: line,
        index: lineStart + 1,
        data: { attributes: getAttributes(match) },
      };
    },
    handler: ({ state, range, match }) => {
      const $markerStart = state.doc.resolve(range.from);
      if ($markerStart.depth !== 1 || $markerStart.parent.type.name !== 'paragraph') return null;

      const paragraph = $markerStart.parent;
      const paragraphStart = $markerStart.start();
      const markerOffset = range.from - paragraphStart;
      const hardBreak = paragraph.nodeAt(markerOffset - 1);
      if (hardBreak?.type.name !== 'hardBreak') return null;
      if (paragraphOffsetIsInsideFence(paragraph, markerOffset)) return null;
      if (documentFenceStateBefore(state.doc, $markerStart.before(1))) return null;

      const before = paragraph.content.cut(0, markerOffset - hardBreak.nodeSize);
      const after = paragraph.content.cut(range.to - paragraphStart);
      const paragraphType = state.schema.nodes.paragraph;
      const itemType = state.schema.nodes.listItem;
      if (!paragraphType || !itemType) return null;

      const leadingParagraph = paragraph.type.create(paragraph.attrs, before, paragraph.marks);
      const listParagraph = paragraph.type.create(paragraph.attrs, after, paragraph.marks);
      const list = type.create(
        (match.data?.attributes as Record<string, unknown> | undefined) ?? {},
        itemType.create(null, listParagraph),
      );
      const paragraphPosition = $markerStart.before(1);
      const replacement = Fragment.fromArray([leadingParagraph, list]);
      const tr = state.tr.replaceWith(
        paragraphPosition,
        paragraphPosition + paragraph.nodeSize,
        replacement,
      );
      const listPosition = paragraphPosition + leadingParagraph.nodeSize;
      tr.setSelection(TextSelection.create(tr.doc, listPosition + 3));
    },
  });
}

function fenceAwareWrappingInputRule(
  config: Parameters<typeof wrappingInputRule>[0],
): InputRule {
  const rule = wrappingInputRule(config);
  return new InputRule({
    find: rule.find,
    handler: (props) => {
      const $markerStart = props.state.doc.resolve(props.range.from);
      if (
        $markerStart.depth === 1 &&
        documentFenceStateBefore(props.state.doc, $markerStart.before(1))
      ) {
        return null;
      }
      return rule.handler(props);
    },
  });
}

const listItemConfig: NodeConfig = {
  name: 'listItem',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  parseHTML() {
    return [{ tag: 'li' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(HTMLAttributes), 0];
  },
};

export const ComposerListItem = Node.create(listItemConfig);

export const ComposerBulletList = Node.create({
  name: 'bulletList',
  group: 'block',
  content: 'listItem+',
  defining: true,
  addAttributes() {
    return {
      marker: {
        default: '-',
        parseHTML: (element) => {
          const value = element.getAttribute('data-marker');
          return value === '+' || value === '*' || value === '•' ? value : '-';
        },
        renderHTML: (attributes) =>
          attributes.marker === '-' ? {} : { 'data-marker': attributes.marker },
      },
      separator: {
        default: ' ',
        parseHTML: (element) => element.getAttribute('data-separator') || ' ',
        renderHTML: (attributes) =>
          attributes.separator === ' ' ? {} : { 'data-separator': attributes.separator },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'ul' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes), 0];
  },
  addInputRules() {
    return [
      fenceAwareWrappingInputRule({
        find: BULLET_MARKER_RE,
        type: this.type,
        joinPredicate: (match, before) =>
          before.attrs.marker === match[1] && before.attrs.separator === match[2],
        getAttributes: (match) => ({
          marker: match[1] as BulletMarker,
          separator: match[2],
        }),
      }),
      hardBreakListInputRule(BULLET_MARKER_RE, this.type, (match) => ({
        marker: match[1] as BulletMarker,
        separator: match[2],
      })),
    ];
  },
});

function orderedAttrs(match: RegExpMatchArray): OrderedListAttrs {
  const marker = (match[2] ?? '、') as OrderedMarker;
  return {
    start: Number(match[1] ?? 1),
    marker,
    ...(marker === '、' ? { separator: '' } : { separator: match[3] ?? ' ' }),
  };
}

function canJoinOrderedList(match: RegExpMatchArray, before: PMNode): boolean {
  const attrs = orderedAttrs(match);
  return (
    before.attrs.marker === attrs.marker &&
    (before.attrs.separator ?? (attrs.marker === '、' ? '' : ' ')) === attrs.separator &&
    before.attrs.start + before.childCount === attrs.start
  );
}

export const ComposerOrderedList = Node.create({
  name: 'orderedList',
  group: 'block',
  content: 'listItem+',
  defining: true,
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element) => {
          const value = Number(element.getAttribute('start'));
          return Number.isInteger(value) && value > 0 ? value : 1;
        },
        renderHTML: (attributes) => (attributes.start === 1 ? {} : { start: attributes.start }),
      },
      marker: {
        default: '.',
        parseHTML: (element) => {
          const value = element.getAttribute('data-marker');
          return value === ')' || value === '、' ? value : '.';
        },
        renderHTML: (attributes) =>
          attributes.marker === '.' ? {} : { 'data-marker': attributes.marker },
      },
      separator: {
        default: ' ',
        parseHTML: (element) => {
          const marker = element.getAttribute('data-marker');
          return marker === '、' ? '' : element.getAttribute('data-separator') || ' ';
        },
        renderHTML: (attributes) =>
          attributes.marker === '、' || attributes.separator === ' '
            ? {}
            : { 'data-separator': attributes.separator },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'ol' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const start = Number(node.attrs.start);
    const lastItem = start + Math.max(node.childCount - 1, 0);
    const markerDigits =
      Number.isInteger(start) && start > 0 && Number.isInteger(lastItem)
        ? String(lastItem).length
        : 1;
    return [
      'ol',
      mergeAttributes(HTMLAttributes, { 'data-marker-digits': String(markerDigits) }),
      0,
    ];
  },
  addInputRules() {
    return [
      fenceAwareWrappingInputRule({
        find: ORDERED_MARKER_RE,
        type: this.type,
        joinPredicate: canJoinOrderedList,
        getAttributes: orderedAttrs,
      }),
      fenceAwareWrappingInputRule({
        find: CJK_ORDERED_MARKER_RE,
        type: this.type,
        joinPredicate: canJoinOrderedList,
        getAttributes: orderedAttrs,
      }),
      hardBreakListInputRule(ORDERED_MARKER_RE, this.type, orderedAttrs),
      hardBreakListInputRule(CJK_ORDERED_MARKER_RE, this.type, orderedAttrs),
    ];
  },
});

function selectedListItemDepth(view: EditorView): number | null {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'listItem') return depth;
  }
  return null;
}

function selectedListItemIsEmpty(view: EditorView, depth: number): boolean {
  const item = view.state.selection.$from.node(depth);
  const paragraph = item.firstChild;
  return (
    item.childCount === 1 &&
    paragraph?.type.name === 'paragraph' &&
    paragraph.content.content.every((node) => node.isText && !(node.text ?? '').trim())
  );
}

function liftEmptyStructuredListItem(view: EditorView, itemType: NodeType): boolean {
  const { $from } = view.state.selection;
  const paragraph = $from.parent;
  if (paragraph.type.name === 'paragraph' && paragraph.content.size > 0) {
    view.dispatch(view.state.tr.delete($from.start(), $from.end()));
  }
  return liftListItem(itemType)(view.state, view.dispatch);
}

function selectedListItemIsOnlyTaskParagraph(view: EditorView, depth: number): boolean {
  const item = view.state.selection.$from.node(depth);
  return item.childCount === 1 && item.firstChild === view.state.selection.$from.parent;
}

function selectedTaskPrefix(view: EditorView): SelectedTaskPrefix | null {
  const { $from } = view.state.selection;
  const paragraph = $from.parent;
  if (paragraph.type.name !== 'paragraph') return null;
  const text = paragraph.textBetween(0, paragraph.content.size, '\uFFFC', '\uFFFC');
  const match = text.match(/^\[[ xX]\](?:[ \t]+|$)/);
  if (!match) return null;
  return {
    from: $from.start(),
    to: $from.start() + match[0].length,
    bodyIsEmpty: text.slice(match[0].length).trim().length === 0,
    caretAtOrAfterPrefix: $from.parentOffset >= match[0].length,
    caretAtParagraphEnd: $from.parentOffset === paragraph.content.size,
  };
}

function clearTaskPrefixAndLift(
  view: EditorView,
  itemDepth: number,
  taskPrefix: SelectedTaskPrefix,
): boolean {
  if (
    !taskPrefix.bodyIsEmpty ||
    !taskPrefix.caretAtParagraphEnd ||
    !selectedListItemIsOnlyTaskParagraph(view, itemDepth)
  ) {
    return false;
  }
  view.dispatch(view.state.tr.delete(taskPrefix.from, taskPrefix.to));
  const itemType = view.state.schema.nodes.listItem;
  if (itemType) liftListItem(itemType)(view.state, view.dispatch);
  return true;
}

function backspaceAfterStructuredList(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  if (
    !state.selection.empty ||
    $from.depth !== 1 ||
    $from.parent.type.name !== 'paragraph' ||
    $from.parent.content.size !== 0 ||
    $from.parentOffset !== 0
  ) {
    return false;
  }
  const paragraphPosition = $from.before(1);
  const previous = state.doc.resolve(paragraphPosition).nodeBefore;
  if (previous?.type.name !== 'bulletList' && previous?.type.name !== 'orderedList') return false;

  const tr = state.tr.delete(paragraphPosition, paragraphPosition + $from.parent.nodeSize);
  tr.setSelection(Selection.near(tr.doc.resolve(paragraphPosition), -1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Continue a structured list on the composer's explicit newline shortcuts.
 * An empty item exits the list; a non-empty item becomes two sibling items.
 * Markdown task prefixes remain editable text, with new items reset to
 * unchecked state.
 */
export function handleStructuredListBreak(view: EditorView): boolean {
  const { state } = view;
  const itemType = state.schema.nodes.listItem;
  const itemDepth = selectedListItemDepth(view);
  if (!itemType || !state.selection.empty || itemDepth === null) return false;
  const taskPrefix = selectedTaskPrefix(view);
  if (
    taskPrefix?.bodyIsEmpty &&
    taskPrefix.caretAtOrAfterPrefix &&
    taskPrefix.caretAtParagraphEnd
  ) {
    if (!selectedListItemIsOnlyTaskParagraph(view, itemDepth)) return false;
    return clearTaskPrefixAndLift(view, itemDepth, taskPrefix);
  }
  if (selectedListItemIsEmpty(view, itemDepth)) {
    return liftEmptyStructuredListItem(view, itemType);
  }
  const split = splitListItem(itemType)(state, view.dispatch);
  if (split && taskPrefix?.caretAtOrAfterPrefix) {
    view.dispatch(view.state.tr.insertText('[ ] ').scrollIntoView());
  }
  return split;
}

/** Exit an empty structured item with one Backspace, matching plain-list input. */
export function handleStructuredListBackspace(view: EditorView): boolean {
  const { state } = view;
  if (backspaceAfterStructuredList(view)) return true;
  const itemType = state.schema.nodes.listItem;
  const { $from } = state.selection;
  const itemDepth = selectedListItemDepth(view);
  const taskPrefix = selectedTaskPrefix(view);
  const emptyItem = itemDepth !== null && selectedListItemIsEmpty(view, itemDepth);
  const emptyItemCaret =
    emptyItem &&
    ($from.parentOffset === 0 || $from.parentOffset === $from.parent.content.size);
  if (
    !itemType ||
    !state.selection.empty ||
    itemDepth === null ||
    (taskPrefix
      ? !taskPrefix.bodyIsEmpty ||
        !taskPrefix.caretAtOrAfterPrefix ||
        !taskPrefix.caretAtParagraphEnd ||
        !selectedListItemIsOnlyTaskParagraph(view, itemDepth)
      : (!emptyItemCaret && $from.parentOffset !== 0) || !emptyItem)
  ) {
    return false;
  }
  if (taskPrefix) return clearTaskPrefixAndLift(view, itemDepth, taskPrefix);
  return liftEmptyStructuredListItem(view, itemType);
}

/**
 * Upgrade a plain list row appended by paste, IME, dictation, or another
 * direct transaction that does not run input rules.
 *
 * The command is intentionally scoped to the final top-level paragraph and
 * an end-of-document caret. Restored documents and multi-row text are
 * normalized before insertion; this closes the remaining live-editing gap
 * without rescanning or rebuilding the full document after every keystroke.
 */
function getTrailingPlainListParagraph(view: EditorView): {
  paragraph: PMNode;
  marker: PlainListParagraphMarker;
  paragraphPosition: number;
} | null {
  const { state } = view;
  const { $from } = state.selection;
  if (
    !state.selection.empty ||
    $from.depth !== 1 ||
    $from.parent.type.name !== 'paragraph' ||
    $from.parentOffset !== $from.parent.content.size ||
    $from.after(1) !== state.doc.content.size
  ) {
    return null;
  }

  const paragraph = $from.parent;
  let hasHardBreak = false;
  paragraph.forEach((child) => {
    if (child.type.name === 'hardBreak') hasHardBreak = true;
  });
  if (hasHardBreak) return null;

  const text = paragraph.textBetween(0, paragraph.content.size, '\uFFFC', '\uFFFC');
  const marker = plainListParagraphMarker(text);
  const first = paragraph.firstChild;
  if (!marker || first?.type.name !== 'text' || (first.text?.length ?? 0) < marker.prefixLength) {
    return null;
  }
  return { paragraph, marker, paragraphPosition: $from.before(1) };
}

export function hasTrailingPlainListParagraph(view: EditorView): boolean {
  return getTrailingPlainListParagraph(view) !== null;
}

export function isTrailingEmptyTopLevelParagraph(view: EditorView): boolean {
  const { state } = view;
  const { $from } = state.selection;
  if (
    !state.selection.empty ||
    $from.depth !== 1 ||
    $from.parent.type.name !== 'paragraph' ||
    $from.parentOffset !== $from.parent.content.size ||
    $from.after(1) !== state.doc.content.size
  ) {
    return false;
  }
  return (
    $from.parent.content.size === 0 ||
    ($from.parent.childCount === 1 && $from.parent.firstChild?.type.name === 'hardBreak')
  );
}

export function isTopLevelBlockSelection(view: EditorView): boolean {
  const { state } = view;
  const { $from, $to } = state.selection;
  const spansTopLevelBlocks =
    !state.selection.empty &&
    $from.depth === 1 &&
    $to.depth === 1 &&
    $from.parentOffset === 0 &&
    $to.parentOffset === $to.parent.content.size
  if (spansTopLevelBlocks) return true;
  return (
    !state.selection.empty &&
    $from.depth === 0 &&
    $to.depth === 0 &&
    $from.pos === 0 &&
    $to.pos === state.doc.content.size
  );
}

export function promoteTrailingPlainListParagraph(view: EditorView): boolean {
  const trailing = getTrailingPlainListParagraph(view);
  if (!trailing) return false;
  const { state } = view;
  const { paragraph, marker, paragraphPosition } = trailing;
  if (documentFenceStateBefore(state.doc, paragraphPosition)) return false;

  const paragraphType = state.schema.nodes.paragraph;
  const itemType = state.schema.nodes.listItem;
  const listType =
    marker.kind === 'ordered' ? state.schema.nodes.orderedList : state.schema.nodes.bulletList;
  if (!paragraphType || !itemType || !listType) return false;

  const body = paragraph.content.cut(marker.prefixLength);
  const list = listType.create(
    marker.attrs,
    itemType.create(null, paragraphType.create(paragraph.attrs, body)),
  );
  const tr = state.tr.replaceWith(paragraphPosition, paragraphPosition + paragraph.nodeSize, list);
  tr.setSelection(TextSelection.atEnd(tr.doc));
  view.dispatch(tr.scrollIntoView());
  return true;
}
