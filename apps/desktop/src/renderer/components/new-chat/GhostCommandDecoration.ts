/**
 * GhostCommandDecoration — 意识指令的输入框「确认胶囊」。
 *
 * 消息以 `$画图 ...` 开头且指令词命中一段**已唤醒**的意识时,把指令词渲染成
 * 带意识头像的胶囊、触发符渲染层隐藏(样式见 globals.css `.ghost-cmd-pill` /
 * `.ghost-cmd-sigil`),给用户一个"意识已确定接单"的即时反馈;没命中(没这个
 * 指令 / 意识沉睡 / 位置不对)保持普通文字、触发符照常显示。纯 ProseMirror decoration——doc 里仍是纯文本 `$指令`,不改
 * 序列化、不建 chip(见 ChatInput insertSlashCommand 的"不建 chip"设计决策),
 * 发送链路零影响(规则 10)。
 *
 * 判定与发送期严格同源(规则 9 确定性):
 * - 匹配器复用 ghostCommand.ts 的 findGhostByCommand(启用态 + 指令词大小写
 *   折叠),胶囊亮 ⇔ 发送时 expandGhostCommand 会追加硬指令,两者永不漂移。
 * - 位置语义对齐 serializeEditorContent + COMMAND_RE:序列化后 `.trim()`,
 *   所以允许前导空白/空段落;`$` 前若有 chip(序列化成 `@...` 非空白前缀)
 *   或首个非空白字符不是触发符(含全角变体)则不亮;指令词后必须是空白 /
 *   hardBreak / 段落边界(序列化为 `\n`),紧贴 chip 视为 run 未断,不亮。
 *
 * 意识清单不在 plugin 里查(listSync 是同步 IPC,不进 keystroke 热路径):
 * ChatInput 经 useInstalledGhosts 订阅,变更时用 setGhostCommandRoster 推进来。
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import {
  findGhostByCommand,
  findGhostByCommandIncludingDisabled,
} from '@/cindy-brain/ghostCommand';
import type { InstalledGhost } from '../../../shared/ghost';

const PLUGIN_KEY = new PluginKey<GhostCommandPluginState>('ghostCommandDecoration');
const META_KEY = 'ghostCommandDecoration';

interface GhostCommandPluginState {
  ghosts: InstalledGhost[];
  decorations: DecorationSet;
}

/** 触发符字符集——与 ChatInput 的 GHOST_SIGIL_CHARS / COMMAND_RE 同一套。 */
const SIGILS = new Set(['$', '＄', '¥', '￥']);

/** 指令词形状:紧跟触发符的连续非空白,≤32 字符(同 COMMAND_RE)。 */
const WORD_RE = /^(\S{1,32})/;

/**
 * 头像 data URL 白名单形状:只接受 base64 图片,其它一律回退幽灵图标。
 * 值要进内联 style 的 `url("...")`,这里顺带排除了引号/括号/空白等能破坏
 * CSS 声明的字符(base64 字符集本身就不含它们)。
 */
const SAFE_ICON_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i;

export interface GhostCommandMatch {
  /** 触发符字符的 doc 位置。 */
  from: number;
  /** 指令词结束后的 doc 位置(decoration 区间 [from, to))。 */
  to: number;
  ghost: InstalledGhost;
}

/**
 * 在 doc 里找「已确认的意识指令」:定位首个非空白内容,校验触发符 + 指令词 +
 * 词尾边界,再经 findGhostByCommand 对已唤醒意识核身。任何一步不满足返回
 * null(渲染层绝不比发送层更乐观)。
 */
export function findGhostCommandMatch(
  doc: PMNode,
  ghosts: InstalledGhost[],
  options: { includeDisabled?: boolean } = {},
): GhostCommandMatch | null {
  if (ghosts.length === 0) return null;
  let paraPos = 0;
  for (let pi = 0; pi < doc.childCount; pi++) {
    const para = doc.child(pi);
    if (para.type.name !== 'paragraph') {
      // A command after a leading structured list is not a message-start
      // command. Let the placement path insert the selected command before
      // that list instead of replacing the later paragraph.
      return null;
    }
    let childPos = paraPos + 1; // 段落内容起点
    for (let ci = 0; ci < para.childCount; ci++) {
      const child = para.child(ci);
      // chip 序列化成 `@...`(非空白)——出现在指令前意味着序列化文本不再以
      // `$` 开头,COMMAND_RE 必不匹配。
      if (child.type.name === 'mentionChip') return null;
      if (child.isText) {
        const text = child.text ?? '';
        const first = /\S/.exec(text);
        if (first) {
          const i = first.index;
          if (!SIGILS.has(text[i])) return null;
          const word = WORD_RE.exec(text.slice(i + 1))?.[1];
          // `$` 后直接空白 / 节点结束(相邻 text 节点会被 ProseMirror 合并,
          // 词不可能续在下个节点里)→ 无指令词。
          if (!word) return null;
          const after = i + 1 + word.length;
          if (after < text.length) {
            // 命中 32 字符上限但 run 未断 → 超长,发送期同样不匹配。
            if (!/\s/.test(text[after])) return null;
          } else {
            // 词到节点末尾:下一个 sibling 是 chip 时序列化紧贴续上非空白,
            // run 未断;hardBreak / 段落边界序列化为 `\n`,是合法词尾。
            const next = ci + 1 < para.childCount ? para.child(ci + 1) : null;
            if (next && next.type.name !== 'hardBreak') return null;
          }
          const ghost = options.includeDisabled
            ? findGhostByCommandIncludingDisabled(ghosts, word)
            : findGhostByCommand(ghosts, word);
          if (!ghost) return null;
          return { from: childPos + i, to: childPos + after, ghost };
        }
        // 全空白文本,继续找
      }
      // hardBreak / 其它 inline:序列化为空白,继续找
      childPos += child.nodeSize;
    }
    paraPos += para.nodeSize;
  }
  return null;
}

/**
 * 胶囊 span 的渲染属性(导出供测试锁契约):头像 data URL 过白名单才注入
 * `--ghost-cmd-icon`(globals.css 据此换掉默认幽灵图标),异形值静默回退。
 */
export function ghostPillAttrs(ghost: InstalledGhost): Record<string, string> {
  const attrs: Record<string, string> = {
    class: 'ghost-cmd-pill',
    'data-ghost-cmd': ghost.manifest.id,
    // hover 报幕意识名(胶囊里只有 $指令,名字不占输入区空间)。
    title: ghost.manifest.name,
  };
  const icon = ghost.iconDataUrl;
  if (icon && SAFE_ICON_DATA_URL_RE.test(icon)) {
    attrs['data-ghost-cmd-icon'] = '';
    attrs.style = `--ghost-cmd-icon:url("${icon}")`;
  }
  return attrs;
}

/** 由匹配结果构建胶囊 decoration(未命中 → 空集)。 */
function buildDecorations(doc: PMNode, ghosts: InstalledGhost[]): DecorationSet {
  const match = findGhostCommandMatch(doc, ghosts);
  if (!match) return DecorationSet.empty;
  return DecorationSet.create(doc, [
    // 触发符($ 及全角变体)只做识别不做展示:胶囊头像已点明"这是意识",
    // 字符本身渲染层隐藏(doc 里仍在,编辑/发送/复制都不受影响;改坏词
    // 导致胶囊消失时它自然重新显形)。
    Decoration.inline(match.from, match.from + 1, { class: 'ghost-cmd-sigil' }),
    Decoration.inline(match.from + 1, match.to, ghostPillAttrs(match.ghost)),
  ]);
}

/**
 * 推送最新意识清单(装/卸/唤醒/沉睡即时反映)。同引用去重——
 * useInstalledGhosts 的 state 引用只在真变更时更新。
 */
export function setGhostCommandRoster(editor: Editor | null, ghosts: InstalledGhost[]): void {
  if (!editor || editor.isDestroyed) return;
  const current = PLUGIN_KEY.getState(editor.state);
  if (current && current.ghosts === ghosts) return;
  editor.view.dispatch(editor.state.tr.setMeta(META_KEY, ghosts));
}

/** 导出供测试直接在 ProseMirror state 层实例化(同 VoiceInputDraftDecoration)。 */
export function createGhostCommandPlugin(): Plugin<GhostCommandPluginState> {
  return new Plugin<GhostCommandPluginState>({
    key: PLUGIN_KEY,
    state: {
      init(_config, state: EditorState): GhostCommandPluginState {
        // 清单由 ChatInput 挂载后经 meta 推入,首帧空集(用户尚未输入)。
        return { ghosts: [], decorations: buildDecorations(state.doc, []) };
      },
      apply(tr: Transaction, old: GhostCommandPluginState): GhostCommandPluginState {
        const roster = tr.getMeta(META_KEY) as InstalledGhost[] | undefined;
        if (roster) return { ghosts: roster, decorations: buildDecorations(tr.doc, roster) };
        if (!tr.docChanged) return old;
        // 只扫消息头部的指令 run,输入量级下全量重算成本可忽略(同 CjkPunct)。
        return { ghosts: old.ghosts, decorations: buildDecorations(tr.doc, old.ghosts) };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

export const GhostCommandDecoration = Extension.create({
  name: 'ghostCommandDecoration',

  addProseMirrorPlugins() {
    return [createGhostCommandPlugin()];
  },
});
