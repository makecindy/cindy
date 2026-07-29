/**
 * Tiptap 扩展 —— 给 chat input 里的 CJK 标点(《》「」『』【】())包一层
 * 带显式 CJK 字体栈的 inline span。
 *
 * 解决的问题
 * -----------
 * Chromium 在 contentEditable 里对 Unicode "Common script"字符 (《》「」 等
 * CJK 标点的 script 属性是 Common,不是 Han) 会按相邻字符的 script 来 itemize:
 *   - 序列开头 / 紧挨空格 / 紧挨 Latin 字符的 《 → 当作 Latin script,跳过
 *     字体栈里所有 CJK 字体,命中第一个含 《 字形的 Latin 字体 (Windows 上是
 *     Segoe UI),渲染成 Latin 比例的窄字形 (~7.5px)
 *   - 紧挨汉字的 》 → 当作 CJK script,走 PingFang/YaHei 全角 (~15px)
 *
 * 同一行里就出现了"《 半角、》 全角"的视觉错乱。lang="zh-CN" 在 contentEditable
 * 里被 Chromium 忽略,font-family 栈把 CJK 字体提到最前也无效 —— Chromium 的
 * 这个 itemizer 在 contentEditable 里不老实读 font-family 顺序。
 *
 * 唯一能稳定打断这个 itemization 的办法: 把每个 CJK 标点用一个 <span> 包起来,
 * span 边界强制把 itemization 切开,Chromium 在 span 内部重新 resolve font,
 * 此时显式 font-family 才生效。
 *
 * 边界处理
 * --------
 * - IME 组合期 (用户打 pinyin 还没选字): 保留组合开始前已有的 decoration,
 *   只随 transaction 映射其位置,compositionend 后再按当前 doc 补算。这样既不
 *   重建输入法维护的 DOM,也不会让已有标点在每次组字时切回另一套字形。
 * - 性能: chat input 文本量很小,正常 doc 变化、slash roster 或 voice replacement
 *   range 变化时采用全量重扫;只有组合期为保持已有 DOM 稳定才映射旧 decoration。
 * - 不污染源数据: decoration 只是渲染层,doc JSON 里没有 span,copy/paste/save
 *   拿到的都是纯文本
 *
 * 已知 trade-off
 * --------------
 * - 光标移到 CJK 标点旁边时 (...|<span>《</span>...) 是 span 边界,Chromium 在
 *   边界处的光标定位有 quirk,可能要按两下方向键才"穿过"标点。这是 Chromium 限
 *   制,无解,大多数用户感知不到
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
import {
  resolveVoiceInputReplacementRange,
  type VoiceInputReplacementRange,
} from './VoiceInputDraftDecoration';
import {
  hasCjkContextPunctuation,
  isCjkContextPunctuation,
} from './CjkPunctuationUtils';

type CjkDecorationPluginState = {
  decorations: DecorationSet;
  suspendedForComposition: boolean;
};

type CompositionMeta = 'suspend' | 'resume';

const PLUGIN_KEY = new PluginKey<CjkDecorationPluginState>('cjkPunctDecoration');

const LONG_ALPHANUMERIC_BODY_RE = /^\s*[A-Za-z0-9]{12,}\s*$/;

type ListLineRange = { from: number; to: number };

function listLineRanges(
  doc: PMNode,
  slashCommandMatches: ReadonlyArray<Pick<SlashCommandMatch, 'from' | 'to'>> = [],
  voiceReplacementRange: VoiceInputReplacementRange | null = null,
): ListLineRange[] {
  const ranges: ListLineRange[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const contentBase = blockPos + 1;
    let lineText = '';
    let lineStart = 0;
    let lineEnd = 0;
    let lineHasInlineAtom = false;
    const lines: Array<{
      text: string;
      start: number;
      end: number;
      hasInlineAtom: boolean;
    }> = [];
    const flush = () => {
      lines.push({
        text: lineText,
        start: lineStart,
        end: lineEnd,
        hasInlineAtom: lineHasInlineAtom,
      });
    };
    block.nodesBetween(0, block.content.size, (node, pos) => {
      if (node.type.name === 'hardBreak') {
        lineEnd = pos;
        flush();
        lineText = '';
        lineStart = pos + node.nodeSize;
        lineEnd = lineStart;
        lineHasInlineAtom = false;
      } else if (node.isText) {
        lineText += node.text ?? '';
        lineEnd = pos + node.nodeSize;
      } else {
        lineText += '\uFFFC';
        lineEnd = pos + node.nodeSize;
        lineHasInlineAtom = true;
      }
      return false;
    });
    lineEnd = block.content.size;
    flush();
    const lineMatches = lines.map((line) => ({
      line,
      match: matchListPrefix(line.text),
    }));
    // ComposerListIndentDecoration switches the entire paragraph to its
    // prefix-only fallback when any list row contains an atom, a recognized
    // slash pill, voice replacement, or CJK punctuation. Its unindented sibling
    // wrapper must remain one inline-block, so those rows opt out of nested
    // punctuation spans and use a Unicode-scoped composite font class instead.
    const hasFallbackLine = lineMatches.some(({ line, match }) => {
      if (!match) return false;
      const overlapsSlashCommandPill = slashCommandMatches.some(
        (slashMatch) =>
          slashMatch.from < contentBase + line.end && slashMatch.to > contentBase + line.start,
      );
      const overlapsVoiceReplacement =
        voiceReplacementRange !== null &&
        voiceReplacementRange.from < contentBase + line.end &&
        voiceReplacementRange.to > contentBase + line.start;
      const hasCjkPunctuation = hasCjkContextPunctuation(line.text);
      return (
        line.hasInlineAtom ||
        overlapsSlashCommandPill ||
        (lines.length > 1 && (overlapsVoiceReplacement || hasCjkPunctuation))
      );
    });
    lineMatches.forEach(({ line, match }) => {
      if (!match) {
        if (hasFallbackLine && lines.length > 1 && line.end > line.start) {
          ranges.push({ from: contentBase + line.start, to: contentBase + line.end });
        }
        return;
      }
      const prefixFrom = contentBase + line.start;
      const prefixTo = prefixFrom + match.prefixLength;
      const body = line.text.slice(match.prefixLength);
      // Prefix-only fallback slots and long-run marker boxes cannot overlap a
      // per-character font span: ProseMirror would split the fixed-width box
      // into duplicate fragments. Their tiny marker range opts into the CJK
      // stack as one box; fallback bodies and node-wrapped single-line bodies
      // retain character-scoped font spans and the normal UI/user font stack.
      if (
        hasFallbackLine ||
        (lines.length === 1 &&
          LONG_ALPHANUMERIC_BODY_RE.test(body) &&
          !line.text.slice(0, match.prefixLength).includes('\t'))
      ) {
        ranges.push({ from: prefixFrom, to: prefixTo });
      }
    });
    return false;
  });
  return ranges;
}

/**
 * 显式 CJK 字体栈。
 *
 * !! 注意 HarmonyOS Sans SC 的位置 !!
 * 项目通过 npm 包 harmonyos-sans-sc-webfont-splitted 加载了 HarmonyOS Sans SC
 * 作为 webfont(全平台都有,不止 Mac/Windows 系统装的)。但实测 HarmonyOS 的
 * 《 字形被设计成 0.5em 半角宽,跟相邻汉字 1em 全角混排会出现"《 半角、汉字
 * 全角"的视觉错乱(codemirrorGithubTheme.ts:153 的注释也说过"字符变细变窄")。
 * 所以这里 HarmonyOS 必须排到 YaHei UI / PingFang 后面,优先让"传统全角风格"
 * 的 CJK 字体接管 CJK 标点渲染:
 *   - Mac: PingFang SC 命中,《》 全角一致
 *   - Windows: PingFang / Hiragino 没装跳过,YaHei UI 命中,《》 全角一致
 *   - 其他平台: 兜底到 Noto Sans CJK SC / Source Han / HarmonyOS / sans-serif
 *
 * 不要把 HarmonyOS 提前 —— 提前会让所有 CJK 标点又走它的半角字形,问题复发。
 */
const CJK_FONT_STACK =
  "'PingFang SC','Hiragino Sans GB'," +
  "'Microsoft YaHei UI','Microsoft YaHei'," +
  "'Noto Sans CJK SC','Source Han Sans SC'," +
  "'HarmonyOS Sans SC',sans-serif";

/**
 * 扫描整个 doc, 给所有 CJK 标点位置生成 inline decoration。
 * 用 descendants 遍历所有 text node, 对每个 text node 内的字符做上下文匹配。
 * 注意 from/to 是 doc-level position, 不是 text-node-local offset。
 */
function buildDecorations(
  doc: PMNode,
  slashCommandMatches: ReadonlyArray<Pick<SlashCommandMatch, 'from' | 'to'>> = [],
  voiceReplacementRange: VoiceInputReplacementRange | null = null,
  ignoreListRanges = false,
): DecorationSet {
  const decorations: Decoration[] = [];
  const listRanges = ignoreListRanges
    ? []
    : listLineRanges(doc, slashCommandMatches, voiceReplacementRange);

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    for (let index = 0; index < text.length; index += 1) {
      if (!isCjkContextPunctuation(text, index)) continue;
      const from = pos + index;
      const to = from + 1;
      if (listRanges.some((range) => from >= range.from && to <= range.to)) {
        // ComposerListIndentDecoration owns the wrapping container for these
        // ranges. An overlapping inline font decoration would split fixed-width
        // boxes at punctuation boundaries; marker boxes use
        // `.composer-list-cjk-font`, while unindented fallback rows use the
        // Unicode-scoped `.composer-list-cjk-punctuation-font`.
        continue;
      }
      decorations.push(
        Decoration.inline(from, to, {
          // inline style 的优先级比 .ProseMirror 的 css 规则高, 强制覆盖
          style: `font-family:${CJK_FONT_STACK}`,
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const CjkPunctDecoration = Extension.create({
  name: 'cjkPunctDecoration',

  addProseMirrorPlugins() {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<CjkDecorationPluginState>({
        key: PLUGIN_KEY,
        state: {
          init(_config, state: EditorState) {
            const roster = getSlashCommandRoster(state);
            return {
              decorations: buildDecorations(state.doc, findSlashCommandMatches(state.doc, roster)),
              suspendedForComposition: false,
            };
          },
          apply(tr: Transaction, old: CjkDecorationPluginState, oldState: EditorState) {
            const compositionMeta = tr.getMeta(PLUGIN_KEY) as CompositionMeta | undefined;
            if (compositionMeta === 'suspend') {
              // ComposerListIndentDecoration removes its wrappers during IME
              // composition so ProseMirror does not let native composition DOM
              // get split by stale layout decorations. Rebuild CJK spans
              // without the list-owned exclusions for that same window; this
              // keeps marker dots and fallback sibling ASCII punctuation in the
              // explicit CJK font stack while the list wrappers are absent.
              const roster = getSlashCommandRoster(oldState);
              return {
                decorations: buildDecorations(
                  tr.doc,
                  findSlashCommandMatches(tr.doc, roster),
                  resolveVoiceInputReplacementRange(tr, oldState).range,
                  true,
                ),
                suspendedForComposition: true,
              };
            }

            const rosterUpdate = getSlashCommandRosterUpdate(tr);
            const voiceReplacement = resolveVoiceInputReplacementRange(tr, oldState);
            if (old.suspendedForComposition && compositionMeta !== 'resume') {
              return {
                decorations: tr.docChanged
                  ? old.decorations.map(tr.mapping, tr.doc)
                  : old.decorations,
                suspendedForComposition: true,
              };
            }
            // doc、命令 roster 和 voice replacement 都没变 → decoration 位置不变,
            // 直接复用;任一输入变化都需要重新扫描。
            if (
              compositionMeta !== 'resume' &&
              !tr.docChanged &&
              rosterUpdate === undefined &&
              !voiceReplacement.changed
            ) {
              return old;
            }
            // doc、命令 roster 或 voice replacement 变化 → 全量重算。
            // 之前考虑过用 old.map(tr.mapping, tr.doc) 做增量, 但 chat input
            // 文本量很小 (< 1KB 常见), 全量重扫成本可忽略, 而增量映射要额外
            // 处理"变化范围内新增/删除的 CJK 标点", 代码复杂度上升不划算。
            const roster = rosterUpdate ?? getSlashCommandRoster(oldState);
            return {
              decorations: buildDecorations(
                tr.doc,
                findSlashCommandMatches(tr.doc, roster),
                voiceReplacement.range,
              ),
              suspendedForComposition: false,
            };
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)?.decorations ?? DecorationSet.empty;
          },
          handleDOMEvents: {
            compositionstart(view) {
              if (resumeTimer !== null) {
                clearTimeout(resumeTimer);
                resumeTimer = null;
              }
              if (!PLUGIN_KEY.getState(view.state)?.suspendedForComposition) {
                view.dispatch(
                  view.state.tr
                    .setMeta(PLUGIN_KEY, 'suspend' satisfies CompositionMeta)
                    .setMeta('addToHistory', false),
                );
              }
              return false;
            },
            compositionend(view) {
              if (resumeTimer !== null) clearTimeout(resumeTimer);
              resumeTimer = setTimeout(() => {
                resumeTimer = null;
                if (view.isDestroyed || view.composing) return;
                if (!PLUGIN_KEY.getState(view.state)?.suspendedForComposition) return;
                view.dispatch(
                  view.state.tr
                    .setMeta(PLUGIN_KEY, 'resume' satisfies CompositionMeta)
                    .setMeta('addToHistory', false),
                );
              }, 0);
              return false;
            },
          },
        },
        view() {
          return {
            destroy() {
              if (resumeTimer !== null) clearTimeout(resumeTimer);
              resumeTimer = null;
            },
          };
        },
      }),
    ];
  },
});
