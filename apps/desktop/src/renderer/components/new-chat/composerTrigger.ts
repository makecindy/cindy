/**
 * Composer 触发符识别 —— 纯 ProseMirror state 函数。
 *
 * 从 ChatInput 抽出,只依赖 EditorState,因此可以在真实 schema 的
 * EditorState 上直接测触发矩阵,不必挂载整只输入框(React 侧只负责把
 * 结果映射成面板开关)。
 *
 * 四种触发:
 *   - `/`  技能/命令面板:段首或空白后,到光标无空白
 *   - `、` 同上,但**只认文档第一个字符**(中文输入法把 `/` 键上屏成顿号)
 *   - `$`  意识指令面板:与 `/` 同规则,全角变体同权
 *   - `@`  文件/目录/Agent 提及:段首或空白后,到光标无空白
 */
import type { EditorState } from '@tiptap/pm/state';

import { COMPOSER_QUOTE_NODE_TYPE } from '@/lib/composerQuoteDocument';

export interface TriggerSlash {
  kind: 'slash';
  /** 触发符:'/' = 技能/命令,'$' = 意识指令(2026-07-09 定案分流)。 */
  sigil: '/' | '$';
  query: string;
  from: number; // absolute position of the leading `/`, `、` or `$`
}
export interface TriggerAt {
  kind: 'at';
  query: string;
  from: number; // absolute position of the `@`
}
export type TriggerState = TriggerSlash | TriggerAt | { kind: 'none' };

/**
 * `$` 触发符的等价字符集:中文输入法下 Shift+4 产出的是全角 ¥(U+FFE5),
 * 全角标点模式/日文布局还可能产出全角 $(U+FF04)/半角 ¥(U+00A5)——
 * 一律视作 `$`,用户打中文时不必切输入法。面板选中后统一替换为 ASCII
 * `$cmd `(见 ChatInput 的 insertSlashCommand),发送期 ghostCommand.ts 的
 * COMMAND_RE 认同一字符集,两端必须保持一致。
 */
const GHOST_SIGIL_CHARS = ['$', '＄', '¥', '￥'] as const;

/**
 * `/` 的输入法别名 —— 中文输入法在标点模式下把 `/` 键上屏成顿号(U+3001),
 * 用户不必先切英文或删掉顿号重输(makecindy/cindy#11562)。
 *
 * 只认文档第一个字符:顿号在中文里是正经标点(`甲、乙`),放开到段首或空白后
 * 会大面积误触正文;而 `/` 自己的"段首或空白后"规则保持原样,不因为加了别名
 * 就收紧(已有的 `正文 /` 仍要能唤起面板)。
 *
 * 别名命中后其余判据与 `/` 完全一致,且**输入期间一个字都不改写**:面板只在
 * 选中命令时把 `、query` 整段换成 ASCII `/name `,按 Esc 关掉面板后顿号仍是
 * 可编辑、可原样发送的标点。
 *
 * 没收的同族字符:`／`(U+FF0F,全角/日文布局)在中文里是正经分隔号
 * (`男／女`),`＠`(U+FF20)会与 mention 的误触面纠缠——各自需要独立验证,
 * 不随本条一起放开。
 */
const SLASH_IME_ALIAS_CHARS = ['、'] as const;

/**
 * 依据当前选区判断活跃的面板触发。`from` 是触发符的文档绝对位置,ChatInput
 * 用它做面板抑制记账(按 Esc 后同一个 `from` 不再自动弹)与整段替换的起点。
 */
export function detectTrigger(state: EditorState): TriggerState {
  const { selection } = state;
  if (!selection.empty) return { kind: 'none' };

  const pos = selection.from;
  const $pos = state.doc.resolve(pos);

  // Must be inside a paragraph
  const parent = $pos.parent;
  if (parent.type.name !== 'paragraph') return { kind: 'none' };

  const offsetInParent = $pos.parentOffset;
  // Collect paragraph text up to the caret. We iterate children because
  // inline nodes (chips) break `textBetween` semantics — we want chips to
  // act as hard boundaries that reset any @-run.
  let textSoFar = '';
  let consumed = 0;
  parent.forEach((child) => {
    if (consumed >= offsetInParent) return;
    const size = child.nodeSize;
    if (child.type.name === 'mentionChip' || child.type.name === COMPOSER_QUOTE_NODE_TYPE) {
      textSoFar = ''; // chips reset the @ / slash run
      consumed += size;
      return;
    }
    if (child.isText) {
      const remaining = offsetInParent - consumed;
      const slice = (child.text ?? '').slice(0, remaining);
      textSoFar += slice;
      consumed += slice.length;
    } else {
      // hardBreak (Shift+Enter) → treat as whitespace so @ / / triggers
      // fire at the start of a new line, not glued to the previous word.
      if (child.type.name === 'hardBreak') textSoFar += '\n';
      consumed += size;
    }
  });

  // Slash detection — mirror @ semantics: trigger when `/` sits at the start
  // of the current paragraph OR is preceded by whitespace, with no whitespace
  // between it and the caret. The previous "must be doc[0]" rule was too
  // strict — users couldn't fire / after a Shift+Enter or in a sentence.
  const slashIdx = textSoFar.lastIndexOf('/');
  if (slashIdx >= 0) {
    const beforeSlash = slashIdx === 0 ? '' : textSoFar[slashIdx - 1];
    const slashAllowed = slashIdx === 0 || /\s/.test(beforeSlash);
    const afterSlash = textSoFar.slice(slashIdx + 1);
    if (slashAllowed && !/\s/.test(afterSlash)) {
      return {
        kind: 'slash',
        sigil: '/',
        query: afterSlash,
        from: pos - (textSoFar.length - slashIdx),
      };
    }
  }

  // `/` 的输入法别名(见 SLASH_IME_ALIAS_CHARS)。文档第一个字符的绝对位置固定是
  // 1(顶层首段落的 content start),所以 `from === 1` 恰好等价于「顿号是整个文档
  // 的第一个字符」:段落不是首个子节点、前面有 chip(会重置 textSoFar)、光标已经
  // 进到别的段落或折行后,算出来的 `from` 都大于 1。
  const firstChar = textSoFar[0];
  if (firstChar !== undefined && (SLASH_IME_ALIAS_CHARS as readonly string[]).includes(firstChar)) {
    const from = pos - textSoFar.length;
    const afterAlias = textSoFar.slice(1);
    if (from === 1 && !/\s/.test(afterAlias)) {
      return { kind: 'slash', sigil: '/', query: afterAlias, from };
    }
  }

  // `$` 检测 —— 与 `/` 同规则(段首或空白后,到光标无空白):意识指令面板。
  // 全角变体(GHOST_SIGIL_CHARS)同权触发;都是单 UTF-16 code unit,位置
  // 计算与 ASCII `$` 完全一致。
  let dollarIdx = -1;
  for (const sigil of GHOST_SIGIL_CHARS) {
    const idx = textSoFar.lastIndexOf(sigil);
    if (idx > dollarIdx) dollarIdx = idx;
  }
  if (dollarIdx >= 0) {
    const beforeDollar = dollarIdx === 0 ? '' : textSoFar[dollarIdx - 1];
    const dollarAllowed = dollarIdx === 0 || /\s/.test(beforeDollar);
    const afterDollar = textSoFar.slice(dollarIdx + 1);
    if (dollarAllowed && !/\s/.test(afterDollar)) {
      return {
        kind: 'slash',
        sigil: '$',
        query: afterDollar,
        from: pos - (textSoFar.length - dollarIdx),
      };
    }
  }

  // @ detection — find the last `@` with whitespace or start-of-text before it.
  const atIdx = textSoFar.lastIndexOf('@');
  if (atIdx >= 0) {
    const before = atIdx === 0 ? '' : textSoFar[atIdx - 1];
    const allowed = atIdx === 0 || /\s/.test(before);
    const after = textSoFar.slice(atIdx + 1);
    const from = pos - (textSoFar.length - atIdx);
    if (allowed && !/\s/.test(after)) {
      return {
        kind: 'at',
        query: after,
        from,
      };
    }
  }

  return { kind: 'none' };
}
