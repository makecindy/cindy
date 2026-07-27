/**
 * Atomic Tiptap node for file, directory, Agent, command, conversation and
 * project references in the composer. The React NodeView keeps all reference
 * kinds on the same visual/interaction contract while renderHTML remains the
 * clipboard and draft-serialization fallback.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import {
  CornerDownRight,
  File,
  Folder,
  FolderOpen,
  MessageSquareQuote,
  Sparkles,
} from 'lucide-react';

import { InlineReferenceChip } from '@/components/chat/InlineReferenceChip';
import { parseSessionDeepLinkHref } from '@/lib/deepLink';

import { resolvePastedSessionMessageText } from './sessionLinkPaste';

export interface MentionChipAttrs {
  /** Chip kind — decides icon + trailing slash behaviour + serialization. */
  kind: 'file' | 'dir' | 'agent' | 'slash' | 'session' | 'project';
  /** Visible basename, Agent name, command, conversation title/message or project name. */
  label: string;
  /** Serialization path/deep-link. */
  path: string;
  /** Resolved session/project labels serialize as explicit Markdown labels. */
  titled?: boolean;
  /** Readable target message body for the agent-facing projection. */
  agentText?: string;
  agentTextTruncated?: boolean;
}

function displayLabel(attrs: MentionChipAttrs): string {
  if (attrs.kind === 'dir') return `${attrs.label}/`;
  if (attrs.kind === 'slash') return `/${attrs.label}`;
  return attrs.label;
}

function MentionIcon({ attrs }: { attrs: MentionChipAttrs }) {
  if (attrs.kind === 'slash') return null;
  if (attrs.kind === 'file') return <File aria-hidden />;
  if (attrs.kind === 'dir') return <Folder aria-hidden />;
  if (attrs.kind === 'agent') return <Sparkles aria-hidden />;
  if (attrs.kind === 'project') return <FolderOpen aria-hidden />;
  return parseSessionDeepLinkHref(attrs.path)?.messageClientId ? (
    <MessageSquareQuote aria-hidden />
  ) : (
    <CornerDownRight aria-hidden />
  );
}

function MentionChipNodeView({ node, selected }: NodeViewProps) {
  const attrs = node.attrs as MentionChipAttrs;
  const label = displayLabel(attrs).replace(/\s+/g, ' ').trim();
  const [tooltip, setTooltip] = useState(displayLabel(attrs));

  useEffect(() => {
    const fallback = displayLabel(attrs);
    const target = attrs.kind === 'session' ? parseSessionDeepLinkHref(attrs.path) : null;
    if (!target?.messageClientId) {
      setTooltip(fallback);
      return;
    }
    let cancelled = false;
    void resolvePastedSessionMessageText(target.sessionId, target.messageClientId)
      .then((text) => {
        if (!cancelled) setTooltip(text?.trim() || fallback);
      })
      .catch(() => {
        if (!cancelled) setTooltip(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [attrs.kind, attrs.label, attrs.path]);

  return (
    <NodeViewWrapper
      as="span"
      data-mention-chip=""
      data-kind={attrs.kind}
      data-label={attrs.label}
      data-path={attrs.path}
      data-titled={attrs.titled ? 'true' : undefined}
      data-agent-text={attrs.agentText}
      data-agent-text-truncated={attrs.agentTextTruncated ? 'true' : undefined}
      data-drag-handle=""
      draggable={true}
      contentEditable={false}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      className="inline-flex max-w-[min(240px,55vw)] cursor-grab select-none align-middle active:cursor-grabbing"
    >
      <InlineReferenceChip
        label={label}
        icon={<MentionIcon attrs={attrs} />}
        tooltip={tooltip}
        ariaLabel={displayLabel(attrs)}
        selected={selected}
        // ProseMirror atomic node:chip 整体被选中 / 删除,内部文字不参与
        // selection(外层 wrapper 也已 userSelect: none,这里显式声明意图)。
        textSelectable={false}
        className={attrs.kind === 'slash' ? 'text-[var(--chat-input-text)]' : undefined}
      />
    </NodeViewWrapper>
  );
}

const FALLBACK_CHIP_CLASS =
  'inline-flex min-w-0 max-w-[min(240px,55vw)] select-none items-center align-middle ' +
  'gap-1.5 rounded-full border border-[var(--border-default)] px-2 py-0.5 ' +
  'bg-[var(--surface-chip)] text-[var(--text-primary)] text-[12px] font-normal leading-5';

export const MentionChipNode = Node.create<Record<string, never>, Record<string, never>>({
  name: 'mentionChip',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      kind: {
        default: 'file',
        parseHTML: (element) => element.getAttribute('data-kind') ?? 'file',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label') ?? '',
        renderHTML: (attrs) => ({ 'data-label': attrs.label }),
      },
      path: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-path') ?? '',
        renderHTML: (attrs) => ({ 'data-path': attrs.path }),
      },
      titled: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-titled') === 'true',
        renderHTML: (attrs) => (attrs.titled ? { 'data-titled': 'true' } : {}),
      },
      agentText: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-agent-text'),
        renderHTML: (attrs) => (
          typeof attrs.agentText === 'string' ? { 'data-agent-text': attrs.agentText } : {}
        ),
      },
      agentTextTruncated: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-agent-text-truncated') === 'true',
        renderHTML: (attrs) => (
          attrs.agentTextTruncated ? { 'data-agent-text-truncated': 'true' } : {}
        ),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention-chip]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as MentionChipAttrs;
    const label = displayLabel(attrs).replace(/\s+/g, ' ').trim();
    const chipAttrs = mergeAttributes(HTMLAttributes, {
      'data-mention-chip': '',
      'aria-label': displayLabel(attrs),
      class: FALLBACK_CHIP_CLASS,
      style: 'color: var(--text-primary); user-select: none; -webkit-user-select: none; -webkit-user-drag: element;',
      draggable: 'true',
      contenteditable: 'false',
    });
    const labelNode = ['span', { class: 'min-w-0 truncate' }, label];

    if (attrs.kind === 'slash') return ['span', chipAttrs, labelNode];

    const iconPaths =
      attrs.kind === 'session' && parseSessionDeepLinkHref(attrs.path)?.messageClientId
        ? SESSION_MESSAGE_ICON_PATHS
        : ICON_PATHS[attrs.kind];
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
        ...iconPaths.map((d) => ['path', { d }] as const),
      ],
      labelNode,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChipNodeView);
  },
});

/** Lucide path fallback used by ProseMirror DOM serialization. */
const ICON_PATHS: Record<Exclude<MentionChipAttrs['kind'], 'slash'>, string[]> = {
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
  dir: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ],
  agent: [
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
    'M20 3v4',
    'M22 5h-4',
    'M4 17v2',
    'M5 18H3',
  ],
  session: ['M15 10l5 5-5 5', 'M4 4v7a4 4 0 0 0 4 4h12'],
  project: [
    'm6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2',
  ],
};

const SESSION_MESSAGE_ICON_PATHS = [
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'M8 12a2 2 0 0 0 2-2V8H8',
  'M14 12a2 2 0 0 0 2-2V8h-2',
];
