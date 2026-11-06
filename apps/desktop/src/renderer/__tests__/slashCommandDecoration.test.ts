import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';

import {
  commandPaletteReplacementNames,
  createSlashCommandPlugin,
  findSlashCommandMatches,
  replaceSlashCommandRunWithText,
  resolveSlashCommandRunEnd,
} from '../components/new-chat/SlashCommandDecoration';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    mentionChip: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        kind: { default: 'file' },
        label: { default: '' },
        path: { default: '' },
      },
    },
  },
});

const p = (...children: PMNode[]) => schema.nodes.paragraph.create(null, children);
const txt = (text: string) => schema.text(text);
const doc = (...paragraphs: PMNode[]) => schema.nodes.doc.create(null, paragraphs);
const command = (name: string) => ({
  kind: 'desktop' as const,
  name,
  description: `${name} command`,
});

function decorationRanges(plugin: ReturnType<typeof createSlashCommandPlugin>, state: EditorState) {
  return (plugin.getState(state)?.decorations.find() ?? []).map((item) => ({
    from: item.from,
    to: item.to,
  }));
}

describe('SlashCommandDecoration', () => {
  it('只装饰边界合法且完整命中的纯文本指令', () => {
    const commands = [command('skill'), command('help')];
    const source = doc(p(txt('/skill 参数 /unknown /helpful /HELP')), p(txt('正文/help /help')));

    expect(findSlashCommandMatches(source, commands)).toMatchObject([
      { from: 1, to: 7, command: { name: 'skill' } },
      { command: { name: 'help' } },
      { command: { name: 'help' } },
    ]);
  });

  it('palette 选择写入 text node,Backspace 可逐字删除且删坏后 decoration 消失', () => {
    const plugin = createSlashCommandPlugin();
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('/ski'))),
      plugins: [plugin],
    });
    state = state.apply(
      replaceSlashCommandRunWithText(state.tr, schema, 1, 5, 'skill').setMeta(
        'slashCommandDecoration',
        [command('skill')],
      ),
    );

    expect(state.doc.firstChild?.firstChild?.isText).toBe(true);
    expect(state.doc.textContent).toBe('/skill ');
    expect(decorationRanges(plugin, state)).toEqual([{ from: 1, to: 7 }]);

    state = state.apply(state.tr.delete(7, 8));
    expect(state.doc.textContent).toBe('/skill');
    expect(decorationRanges(plugin, state)).toEqual([{ from: 1, to: 7 }]);

    state = state.apply(state.tr.delete(6, 7));
    expect(state.doc.textContent).toBe('/skil');
    expect(decorationRanges(plugin, state)).toEqual([]);
  });

  it('palette 选择只替换光标前的命令查询词并保留无空格草稿', () => {
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('/goal已有草稿'))),
    });
    const runEnd = resolveSlashCommandRunEnd(state.doc, 1, 'goal', ['goal']);

    state = state.apply(replaceSlashCommandRunWithText(state.tr, schema, 1, runEnd, 'goal'));

    expect(state.doc.textContent).toBe('/goal 已有草稿');
  });

  it('光标位于带参数命令中间时仍替换匹配的命令后缀', () => {
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('/compact 参数'))),
    });
    const runEnd = resolveSlashCommandRunEnd(state.doc, 1, 'compa', ['compact']);

    state = state.apply(replaceSlashCommandRunWithText(state.tr, schema, 1, runEnd, 'compact'));

    expect(state.doc.textContent).toBe('/compact 参数');
  });

  it('意识指令按显示标签补全光标后的后缀', () => {
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('$draw'))),
    });
    const command = {
      kind: 'desktop' as const,
      name: 'draw/@root',
      label: 'draw',
      description: '',
    };
    const runEnd = resolveSlashCommandRunEnd(
      state.doc,
      1,
      'dra',
      commandPaletteReplacementNames(command),
    );

    state = state.apply(state.tr.replaceWith(1, runEnd, schema.text('$draw/@root ')));

    expect(state.doc.textContent).toBe('$draw/@root ');
  });

  it('旧草稿的 slash atom 在首个 transaction 自动迁移为纯文本', () => {
    const plugin = createSlashCommandPlugin();
    const legacySlash = schema.nodes.mentionChip.create({
      kind: 'slash',
      label: 'skill',
      path: 'skill',
    });
    let state = EditorState.create({
      schema,
      doc: doc(p(legacySlash, txt(' 参数'))),
      plugins: [plugin],
    });

    state = state.applyTransaction(
      state.tr.setMeta('slashCommandDecoration', [command('skill')]),
    ).state;

    expect(state.doc.textContent).toBe('/skill 参数');
    expect(state.doc.firstChild?.firstChild?.isText).toBe(true);
    expect(decorationRanges(plugin, state)).toEqual([{ from: 1, to: 7 }]);
  });

  it('matches Pi runtime aliases and hides the skill: prefix', () => {
    const commands = [{
      kind: 'agent-skill' as const,
      name: 'git',
      description: 'git skill',
      source: 'skill' as const,
      runtimeCommandName: 'skill:git',
    }];
    const source = doc(p(txt('/skill:git follow /git')));

    expect(findSlashCommandMatches(source, commands)).toMatchObject([
      { from: 1, to: 11, command: { name: 'git' } },
      { from: 19, to: 23, command: { name: 'git' } },
    ]);

    const plugin = createSlashCommandPlugin();
    let state = EditorState.create({
      schema,
      doc: source,
      plugins: [plugin],
    });
    state = state.apply(state.tr.setMeta('slashCommandDecoration', commands));

    expect(decorationRanges(plugin, state)).toEqual([
      { from: 1, to: 11 },
      { from: 2, to: 8 },
      { from: 19, to: 23 },
    ]);
  });
});
