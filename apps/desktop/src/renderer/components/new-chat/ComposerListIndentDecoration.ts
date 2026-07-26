/**
 * Tiptap 扩展 —— composer 列表行缩进(纯视觉,对齐 Claude 原生 App 的
 * "进入列表模式"反馈)。
 *
 * 行为:当某一"行"(段落内以 hardBreak 划分)以列表 / 待办 / 引用前缀开头
 * (`1. ` / `- ` / `- [ ] ` / `> ` 等,与列表接续共用 matchListPrefix 判定),
 * 单行段落使用 node decoration,hardBreak 分隔的多行段落按行使用 inline
 * decoration；连续数字/字母正文使用 marker/body 两个盒子，避免长串把
 * 列表标记单独挤到上一行。所有路径都把前缀的估算宽度写入 CSS 变量。
 * CSS 将列表行作为独立的换行容器:首行用负 text-indent 把标记悬挂在左侧,
 * 自动换行后的续行则从正文起点开始。用户打完 `1. `(空格落下)那一刻
 * 缩进立即出现,即"已进入列表状态"的视觉信号;空项退出(前缀被删)时缩进
 * 同步消失。
 *
 * 与 CjkPunctDecoration 相同的设计约束:
 * - decoration 只是渲染层,doc JSON / 草稿存储 / 发送内容里没有任何痕迹;
 * - doc 没变直接复用 DecorationSet,变了全量重扫(chat input 文本量小,
 *   全量成本可忽略,不值得做增量映射);
 * - 只在 doc 发生变化时重算,view.update 不参与 decoration 计算;
 * - 这是纯文本编辑器的视觉缩进,不改变 doc JSON / 发送文本。
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { matchListPrefix } from '@/lib/composerListContinuation';
import {
  findSlashCommandMatches,
  getSlashCommandRoster,
  getSlashCommandRosterUpdate,
  type SlashCommandMatch,
} from './SlashCommandDecoration';

const PLUGIN_KEY = new PluginKey<DecorationSet>('composerListIndentDecoration');
const TAB_SIZE = 8;

/** 行内一个非文本 inline 节点(mention chip 等)的占位符,与 applyListContinuation 一致。 */
const ATOM_PLACEHOLDER = '\uFFFC';
const CJK_PUNCTUATION_RE = /[\u3000-\u303f\uff00-\uffef]/;
// 只有正文整体是一个没有自然断点的数字/字母串时才拆成 marker/body。
// 普通句子里偶然出现长 token 时，交给 overflow-wrap:anywhere，保留空格
// 的自然断词行为，避免把整句变成逐字断行。
const LONG_ALPHANUMERIC_BODY_RE = /^\s*[A-Za-z0-9]{12,}\s*$/;

function addLongRunDecoration(
  decorations: Decoration[],
  from: number,
  to: number,
  prefixLength: number,
  prefix: string,
): void {
  const prefixTo = from + prefixLength;
  decorations.push(
    Decoration.inline(from, prefixTo, {
      class: 'composer-list-long-run-marker',
      style: listPrefixIndentStyle(prefix),
    }),
    Decoration.inline(prefixTo, to, {
      class: 'composer-list-long-run-body',
      style: listPrefixIndentStyle(prefix),
    }),
  );
}

/**
 * 将列表前缀换算成当前字体下的近似宽度。
 *
 * ChatInput 已启用 tabular-nums,所以数字直接用 1ch;句点、空格、方括号等
 * 窄字符按 0.4ch 估算;中文顿号按全角 1em。这里只生成数字和 CSS 单位,
 * 不会透传用户文本。Tab 先用固定 tab stop 做首帧回退，插件 view 在布局
 * 完成后用 Range 实测并覆盖变量，避免比例字体下的 ch 近似误差。
 */
export function listPrefixIndentStyle(prefix: string): string {
  let ch = 0;
  let em = 0;
  for (const char of prefix) {
    if (char >= '0' && char <= '9') {
      ch += 1;
    } else if (char === '\t') {
      // CSS cannot express the rendered width of a tab in a proportional font.
      // Use a deterministic pre-layout fallback; the plugin view replaces this
      // value with the actual Range width once Chromium has laid out the span.
      ch += TAB_SIZE;
    } else if (char === '、' || char === '\u3000') {
      em += 1;
    } else {
      ch += 0.4;
    }
  }
  const chValue = Number(ch.toFixed(2));
  const emValue = Number(em.toFixed(2));
  const positive = emValue > 0 ? `calc(${chValue}ch + ${emValue}em)` : `${chValue}ch`;
  const negative = emValue > 0 ? `calc(-${chValue}ch - ${emValue}em)` : `-${chValue}ch`;
  return [`--composer-list-hang:${positive}`, `--composer-list-hang-negative:${negative}`]
    .map((declaration) => `${declaration};`)
    .join('');
}

/**
 * 扫描 doc,给所有"列表行"的整行内容生成 inline decoration。
 * 返回的 from/to 是 doc-level position。导出以便单测直接断言范围。
 */
export function buildListIndentDecorations(
  doc: PMNode,
  slashCommandMatches: ReadonlyArray<Pick<SlashCommandMatch, 'from' | 'to'>> = [],
): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true; // 继续下钻找 textblock
    const contentBase = blockPos + 1; // +1 跨过 textblock 的开标记

    // 段落内按 hardBreak 切行;occupied 与 doc position 一一对应
    // (text 每字符 1、atom 节点占位符 1)。
    let lineText = '';
    let lineStartOffset = 0;
    let lineEndOffset = 0;
    let lineHasInlineAtom = false;
    const lines: Array<{
      text: string;
      start: number;
      end: number;
      hasInlineAtom: boolean;
    }> = [];
    const flushLine = () => {
      lines.push({
        text: lineText,
        start: lineStartOffset,
        end: lineEndOffset,
        hasInlineAtom: lineHasInlineAtom,
      });
    };
    block.nodesBetween(0, block.content.size, (node, pos) => {
      if (node.type.name === 'hardBreak') {
        // `pos` is the end of the current line in the textblock content.
        lineEndOffset = pos;
        flushLine();
        lineText = '';
        lineStartOffset = pos + node.nodeSize;
        lineEndOffset = lineStartOffset;
        lineHasInlineAtom = false;
      } else if (node.isText) {
        lineText += node.text ?? '';
        lineEndOffset = pos + node.nodeSize;
      } else {
        lineText += ATOM_PLACEHOLDER;
        lineEndOffset = pos + node.nodeSize;
        lineHasInlineAtom = true;
      }
      return false;
    });
    lineEndOffset = block.content.size;
    flushLine(); // 段落最后一行

    const addLineDecoration = (line: (typeof lines)[number]) => {
      const match = matchListPrefix(line.text);
      if (!match) {
        return;
      }
      const from = contentBase + line.start;
      const to = contentBase + line.end;
      const prefix = line.text.slice(0, match.prefixLength);
      const body = line.text.slice(match.prefixLength);
      const overlapsSlashCommandPill = slashCommandMatches.some(
        (slashMatch) => slashMatch.from < to && slashMatch.to > from,
      );
      const hasOverlappingInlineDecoration = line.hasInlineAtom || overlapsSlashCommandPill;
      const hasTabPrefix = prefix.includes('\t');
      const hasCjkPunctuation = CJK_PUNCTUATION_RE.test(prefix) || CJK_PUNCTUATION_RE.test(body);
      const lineClass = [
        hasTabPrefix ? 'composer-list-tab-indent' : '',
        hasCjkPunctuation ? 'composer-list-cjk-font' : '',
      ]
        .filter(Boolean)
        .join(' ');
      if (hasOverlappingInlineDecoration) {
        // Keep list-mode feedback without wrapping an inline decoration range.
        // Prefix-only styling cannot be split by CJK punctuation, slash-command
        // pills, or inline atoms, and is safer than producing multiple blocks.
        decorations.push(
          Decoration.inline(from, from + match.prefixLength, {
            class: [
              'composer-list-prefix-indent',
              hasTabPrefix ? 'composer-list-tab-indent' : '',
              hasCjkPunctuation ? 'composer-list-cjk-font' : '',
            ]
              .filter(Boolean)
              .join(' '),
            'data-composer-list-prefix-length': String(match.prefixLength),
          }),
        );
        return;
      }
      if (LONG_ALPHANUMERIC_BODY_RE.test(body) && !hasTabPrefix) {
        addLongRunDecoration(decorations, from, to, match.prefixLength, prefix);
        return;
      }
      decorations.push(
        Decoration.inline(from, to, {
          class: `composer-list-line-indent ${lineClass}`.trim(),
          'data-composer-list-prefix-length': String(match.prefixLength),
          style: listPrefixIndentStyle(prefix),
        }),
      );
    };

    if (lines.length === 1) {
      const [line] = lines;
      const match = line && matchListPrefix(line.text);
      const prefix = match ? line.text.slice(0, match.prefixLength) : '';
      const body = line && match ? line.text.slice(match.prefixLength) : '';
      const from = line ? contentBase + line.start : contentBase;
      const to = line ? contentBase + line.end : contentBase;
      const hasLongAlphanumericBody = LONG_ALPHANUMERIC_BODY_RE.test(body);
      const hasCjkPunctuation = CJK_PUNCTUATION_RE.test(prefix) || CJK_PUNCTUATION_RE.test(body);
      // A node decoration stays on the paragraph even when CjkPunctDecoration
      // adds nested inline spans, so punctuation cannot split the list wrapper.
      if (
        line &&
        match &&
        !line.hasInlineAtom &&
        (!hasLongAlphanumericBody || prefix.includes('\t'))
      ) {
        const hasTabPrefix = prefix.includes('\t');
        decorations.push(
          Decoration.node(blockPos, blockPos + block.nodeSize, {
            class: [
              'composer-list-block-indent',
              hasTabPrefix ? 'composer-list-tab-indent' : '',
              hasCjkPunctuation ? 'composer-list-cjk-font' : '',
            ]
              .filter(Boolean)
              .join(' '),
            'data-composer-list-prefix-length': String(match.prefixLength),
            style: listPrefixIndentStyle(prefix),
          }),
        );
      } else if (
        line &&
        match &&
        !line.hasInlineAtom &&
        hasLongAlphanumericBody &&
        !prefix.includes('\t')
      ) {
        addLongRunDecoration(
          decorations,
          contentBase + line.start,
          contentBase + line.end,
          match.prefixLength,
          prefix,
        );
      } else if (line && match) {
        decorations.push(
          Decoration.inline(
            contentBase + line.start,
            contentBase + line.start + match.prefixLength,
            {
              class: prefix.includes('\t')
                ? `composer-list-prefix-indent composer-list-tab-indent${
                    hasCjkPunctuation ? ' composer-list-cjk-font' : ''
                  }`
                : `composer-list-prefix-indent${
                    hasCjkPunctuation ? ' composer-list-cjk-font' : ''
                  }`,
              'data-composer-list-prefix-length': String(match.prefixLength),
            },
          ),
        );
      }
    } else {
      lines.forEach(addLineDecoration);
    }

    return false; // textblock 内部已手动扫过,不再下钻
  });

  return DecorationSet.create(doc, decorations);
}

export const ComposerListIndentDecoration = Extension.create({
  name: 'composerListIndentDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: PLUGIN_KEY,
        state: {
          init(_config, state: EditorState) {
            const roster = getSlashCommandRoster(state);
            return buildListIndentDecorations(
              state.doc,
              findSlashCommandMatches(state.doc, roster),
            );
          },
          apply(tr: Transaction, old: DecorationSet, oldState: EditorState) {
            const rosterUpdate = getSlashCommandRosterUpdate(tr);
            if (!tr.docChanged && rosterUpdate === undefined) return old;
            const roster = rosterUpdate ?? getSlashCommandRoster(oldState);
            return buildListIndentDecorations(tr.doc, findSlashCommandMatches(tr.doc, roster));
          },
        },
        props: {
          decorations(state) {
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
        view() {
          return {
            update(view) {
              const tabSpans = view.dom.querySelectorAll<HTMLElement>('.composer-list-tab-indent');
              tabSpans.forEach((span) => {
                const prefixLength = Number(span.dataset.composerListPrefixLength ?? Number.NaN);
                if (!Number.isFinite(prefixLength) || prefixLength <= 0) return;
                const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
                let remaining = prefixLength;
                let startNode: Text | null = null;
                let endNode: Text | null = null;
                let endOffset = 0;
                while (remaining > 0) {
                  const node = walker.nextNode() as Text | null;
                  if (!node) break;
                  const length = node.data.length;
                  if (!startNode) startNode = node;
                  endNode = node;
                  if (length >= remaining) {
                    endOffset = remaining;
                    remaining = 0;
                    break;
                  }
                  remaining -= length;
                }
                if (!startNode || !endNode || remaining > 0) return;
                const range = document.createRange();
                range.setStart(startNode, 0);
                range.setEnd(endNode, endOffset);
                const width = range.getBoundingClientRect().width;
                if (!Number.isFinite(width) || width <= 0) return;
                span.style.setProperty('--composer-list-hang', `${width}px`);
                span.style.setProperty('--composer-list-hang-negative', `-${width}px`);
              });
            },
          };
        },
        // 注:曾有一个 view().update 里 `if (view.composing) return` 的"IME 保护",
        // 但重算发生在上面的 state.apply(只看 tr.docChanged),view.update 在视图更新
        // 之后才跑、DecorationSet 早已算好,该钩子等价 no-op(greptile P2)——已删除。
        // 真要在 IME 期跳过重算,应在 apply 里按 composition 事务标记判断,而非此处。
      }),
    ];
  },
});
