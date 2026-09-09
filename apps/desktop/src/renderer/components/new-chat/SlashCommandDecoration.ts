/**
 * SlashCommandDecoration — slash 指令的可编辑确认胶囊。
 *
 * 文档里始终保存普通文本 `/command`;只有完整命中当前会话可用命令时才用
 * ProseMirror decoration 加上胶囊外观。这样光标、选择与 Backspace 都保持
 * 浏览器原生逐字行为,而不是把 slash 指令变成不可拆分的 atom chip。
 *
 * roster 由 ChatInput 在 loadAllCommands 完成后推入,plugin 不在输入热路径做 IPC。
 * 旧草稿里曾保存过的 `mentionChip(kind=slash)` 会在首个 transaction 中无损迁移
 * 回纯文本,同时保留其后的原有空格与正文。
 */
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { slashCommandRuntimePrefixLength } from '@cindy/maker-shared/composer-palette';

import type { UnifiedCommand } from '@/lib/slashCommands';

const PLUGIN_KEY = new PluginKey<SlashCommandPluginState>('slashCommandDecoration');
const META_KEY = 'slashCommandDecoration';

export type SlashCommandRosterItem = Pick<UnifiedCommand, 'name' | 'description'> & {
  runtimeCommandName?: string;
};
export type SlashCommandRoster = ReadonlyArray<SlashCommandRosterItem>;

interface SlashCommandPluginState {
  commands: SlashCommandRoster;
  decorations: DecorationSet;
}

export interface SlashCommandMatch {
  from: number;
  to: number;
  command: SlashCommandRosterItem;
}

function previousInlineAllowsSlash(parent: PMNode, childIndex: number): boolean {
  if (childIndex === 0) return true;
  const previous = parent.child(childIndex - 1);
  if (!previous.isText) return true;
  return /\s$/.test(previous.text ?? '');
}

function nextInlineEndsSlashRun(parent: PMNode, childIndex: number): boolean {
  if (childIndex + 1 >= parent.childCount) return true;
  const next = parent.child(childIndex + 1);
  if (!next.isText) return true;
  return /^\s/.test(next.text ?? '');
}

/** 找出所有边界合法且完整命中 roster 的 `/command` 纯文本区间。 */
export function findSlashCommandMatches(
  doc: PMNode,
  commands: SlashCommandRoster,
): SlashCommandMatch[] {
  if (commands.length === 0) return [];
  const byName = new Map<string, SlashCommandRosterItem>();
  for (const command of commands) {
    const name = command.name.trim();
    if (name) byName.set(name.toLowerCase(), command);
    const runtime = command.runtimeCommandName?.trim();
    // Palette shows `git`; Pi wire form is `skill:git`. Both must light the pill.
    if (runtime) byName.set(runtime.toLowerCase(), command);
  }
  if (byName.size === 0) return [];

  const matches: SlashCommandMatch[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (!node.isText || !parent) return true;
    const text = node.text ?? '';
    const run = /\/(\S+)/g;
    let candidate: RegExpExecArray | null;
    while ((candidate = run.exec(text)) !== null) {
      const start = candidate.index;
      const end = start + candidate[0].length;
      const startsAtBoundary =
        start > 0 ? /\s/.test(text[start - 1]) : previousInlineAllowsSlash(parent, index);
      if (!startsAtBoundary) continue;
      const endsAtBoundary =
        end < text.length ? /\s/.test(text[end]) : nextInlineEndsSlashRun(parent, index);
      if (!endsAtBoundary) continue;
      const command = byName.get(candidate[1].toLowerCase());
      if (!command) continue;
      matches.push({ from: pos + start, to: pos + end, command });
    }
    return true;
  });
  return matches;
}

function slashPillAttrs(command: SlashCommandRosterItem): Record<string, string> {
  return {
    class: 'slash-cmd-pill',
    'data-slash-command': command.name,
    ...(command.description ? { title: command.description } : {}),
  };
}

function buildDecorations(doc: PMNode, commands: SlashCommandRoster): DecorationSet {
  const matches = findSlashCommandMatches(doc, commands);
  if (matches.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const match of matches) {
    const token = doc.textBetween(match.from, match.to);
    const prefixLength = slashCommandRuntimePrefixLength(token, match.command);
    if (prefixLength > 0) {
      decorations.push(
        Decoration.inline(match.from + 1, match.from + 1 + prefixLength, {
          class: 'slash-cmd-runtime-prefix',
        }),
      );
    }
    decorations.push(Decoration.inline(match.from, match.to, slashPillAttrs(match.command)));
  }
  return DecorationSet.create(doc, decorations);
}

/** Palette 选择后用普通文本替换 slash run,不创建 mentionChip atom。 */
export function replaceSlashCommandRunWithText(
  tr: Transaction,
  schema: Schema,
  from: number,
  to: number,
  commandName: string,
): Transaction {
  return tr.replaceWith(from, to, schema.text(`/${commandName} `));
}

function migrateLegacySlashChips(state: EditorState): Transaction | null {
  const legacy: Array<{ from: number; to: number; command: string }> = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'mentionChip' || node.attrs.kind !== 'slash') return true;
    const command = String(node.attrs.path || node.attrs.label || '');
    legacy.push({ from: pos, to: pos + node.nodeSize, command });
    return false;
  });
  if (legacy.length === 0) return null;

  const tr = state.tr;
  for (let i = legacy.length - 1; i >= 0; i -= 1) {
    const item = legacy[i];
    tr.replaceWith(item.from, item.to, state.schema.text(`/${item.command}`));
  }
  return tr.setMeta('addToHistory', false);
}

export function setSlashCommandRoster(editor: Editor | null, commands: SlashCommandRoster): void {
  if (!editor || editor.isDestroyed) return;
  const current = PLUGIN_KEY.getState(editor.state);
  if (current && current.commands === commands) return;
  editor.view.dispatch(editor.state.tr.setMeta(META_KEY, commands));
}

/** Return the command roster currently used by the decoration plugin. */
export function getSlashCommandRoster(state: EditorState): SlashCommandRoster {
  return PLUGIN_KEY.getState(state)?.commands ?? [];
}

/** Return a roster update carried by this transaction, if present. */
export function getSlashCommandRosterUpdate(
  tr: Transaction,
): SlashCommandRoster | undefined {
  return tr.getMeta(META_KEY) as SlashCommandRoster | undefined;
}

/** Return the exact slash runs currently decorated by this editor's roster. */
export function getDecoratedSlashCommandMatches(editor: Editor): SlashCommandMatch[] {
  return findSlashCommandMatches(editor.state.doc, getSlashCommandRoster(editor.state));
}

/** 导出供 ProseMirror state 层测试 roster、退格与 legacy 草稿迁移。 */
export function createSlashCommandPlugin(): Plugin<SlashCommandPluginState> {
  return new Plugin<SlashCommandPluginState>({
    key: PLUGIN_KEY,
    state: {
      init(_config, state): SlashCommandPluginState {
        return { commands: [], decorations: buildDecorations(state.doc, []) };
      },
      apply(tr, old): SlashCommandPluginState {
        const roster = tr.getMeta(META_KEY) as SlashCommandRoster | undefined;
        if (roster) return { commands: roster, decorations: buildDecorations(tr.doc, roster) };
        if (!tr.docChanged) return old;
        return { commands: old.commands, decorations: buildDecorations(tr.doc, old.commands) };
      },
    },
    appendTransaction(_transactions, _oldState, newState) {
      return migrateLegacySlashChips(newState);
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

export const SlashCommandDecoration = Extension.create({
  name: 'slashCommandDecoration',

  addProseMirrorPlugins() {
    return [createSlashCommandPlugin()];
  },
});
