/**
 * ghostCommandDecoration.test.ts — 意识指令「确认胶囊」的匹配契约
 * ---------------------------------------------------------------------------
 * 胶囊亮 ⇔ 发送期 expandGhostCommand 会追加硬指令,两者必须永不漂移。本测试
 * 在 ProseMirror state 层锁死 findGhostCommandMatch 的位置语义(对齐
 * serializeEditorContent 的 `.trim()` + ghostCommand.ts 的 COMMAND_RE):
 *   1. `$指令` 命中已唤醒意识 → 胶囊区间精确覆盖触发符 + 指令词;
 *   2. 前导空白 / 空段落被 trim → 仍亮;正文中段的 `$` 不亮;
 *   3. chip 在前(序列化 `@...` 前缀)/ 指令词紧贴 chip(run 未断)→ 不亮;
 *   4. 未装 / 沉睡 / 全角触发符 / 大小写折叠等与 findGhostByCommand 同判;
 *   5. roster 经 meta 推入后 plugin 重算(装/卸即时反映,不依赖 docChanged);
 *   6. Backspace 整体删除只在「胶囊亮 + 光标在胶囊外(尾随空格之后)」接管,
 *      胶囊内(含贴着词尾的位置)与其余情况一律落回原生逐字删——那里是编辑位,
 *      改词能力不能被捷径吃掉。
 */
import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyGhostCommandBackspace,
  createGhostCommandPlugin,
  findGhostCommandMatch,
  ghostPillAttrs,
} from '../components/new-chat/GhostCommandDecoration';
import type { GhostManifest, InstalledGhost } from '../../shared/ghost';

const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    mentionChip: { group: 'inline', inline: true, atom: true },
  },
});

/** 与 ChatInput 编辑器同构的最小 doc 构造:字符串 = 文本,标记走辅助函数。 */
const p = (...children: PMNode[]) => schema.nodes.paragraph.create(null, children);
const txt = (s: string) => schema.text(s);
const chip = () => schema.nodes.mentionChip.create();
const br = () => schema.nodes.hardBreak.create();
const doc = (...paras: PMNode[]) => schema.nodes.doc.create(null, paras);

function makeGhost(
  command: string,
  opts: { enabled?: boolean; icon?: string; id?: string } = {},
): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id: opts.id ?? `ghost-${command}`,
    name: `意识 ${command}`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    command,
  };
  return {
    manifest,
    dir: '',
    enabled: opts.enabled ?? true,
    ...(opts.icon ? { iconDataUrl: opts.icon } : {}),
  };
}

const 画图 = makeGhost('画图');

describe('findGhostCommandMatch — 位置语义与发送期同源', () => {
  it('`$画图 一只猫` 命中:区间精确覆盖 $+指令词', () => {
    const m = findGhostCommandMatch(doc(p(txt('$画图 一只猫'))), [画图]);
    // 段落内容从 pos 1 起:$ 在 1,词 2 字,to = 1 + 3
    expect(m).toMatchObject({ from: 1, to: 4 });
    expect(m?.ghost.manifest.id).toBe('ghost-画图');
  });

  it('全角触发符(￥/＄)同权命中', () => {
    expect(findGhostCommandMatch(doc(p(txt('￥画图 猫'))), [画图])).not.toBeNull();
    expect(findGhostCommandMatch(doc(p(txt('＄画图 猫'))), [画图])).not.toBeNull();
  });

  it('指令词大小写折叠(同 findGhostByCommand)', () => {
    const draw = makeGhost('Draw');
    const m = findGhostCommandMatch(doc(p(txt('$draw a cat'))), [draw]);
    expect(m?.ghost.manifest.command).toBe('Draw');
  });

  it('无尾随空格(消息就是 `$画图`)也命中——序列化后词尾即消息尾', () => {
    expect(findGhostCommandMatch(doc(p(txt('$画图'))), [画图])).toMatchObject({ from: 1, to: 4 });
  });

  it('前导空白与空段落被 trim,仍命中(位置随实际字符)', () => {
    expect(findGhostCommandMatch(doc(p(txt('  $画图 猫'))), [画图])).toMatchObject({
      from: 3,
      to: 6,
    });
    // 空首段(nodeSize 2)→ 第二段内容从 pos 3 起
    expect(findGhostCommandMatch(doc(p(), p(txt('$画图 猫'))), [画图])).toMatchObject({
      from: 3,
      to: 6,
    });
  });

  it('指令词后是 hardBreak(序列化 \\n)是合法词尾', () => {
    expect(findGhostCommandMatch(doc(p(txt('$画图'), br(), txt('一只猫'))), [画图])).not.toBeNull();
  });

  it('不亮:正文中段的 $ / 首个非空白不是触发符', () => {
    expect(findGhostCommandMatch(doc(p(txt('帮我 $画图 猫'))), [画图])).toBeNull();
    expect(findGhostCommandMatch(doc(p(txt('画图 猫'))), [画图])).toBeNull();
  });

  it('不亮:chip 在指令前(序列化后 $ 不再是首字符)', () => {
    expect(findGhostCommandMatch(doc(p(chip(), txt('$画图 猫'))), [画图])).toBeNull();
    expect(findGhostCommandMatch(doc(p(chip()), p(txt('$画图 猫'))), [画图])).toBeNull();
  });

  it('不亮:指令词紧贴 chip(序列化 `$画图@...` run 未断)', () => {
    expect(findGhostCommandMatch(doc(p(txt('$画图'), chip())), [画图])).toBeNull();
  });

  it('不亮:未装该指令 / 意识沉睡 / 裸 $ / 超长指令词', () => {
    expect(findGhostCommandMatch(doc(p(txt('$不存在 猫'))), [画图])).toBeNull();
    expect(
      findGhostCommandMatch(doc(p(txt('$画图 猫'))), [makeGhost('画图', { enabled: false })]),
    ).toBeNull();
    expect(findGhostCommandMatch(doc(p(txt('$ 画图'))), [画图])).toBeNull();
    expect(findGhostCommandMatch(doc(p(txt(`$${'长'.repeat(33)} 猫`))), [画图])).toBeNull();
  });
});

describe('createGhostCommandPlugin — roster meta 与 decoration 生命周期', () => {
  const META_KEY = 'ghostCommandDecoration';

  function decorationSpecs(
    plugin: ReturnType<typeof createGhostCommandPlugin>,
    state: EditorState,
  ) {
    const set = plugin.getState(state)?.decorations;
    return (set?.find() ?? []).map((d) => ({ from: d.from, to: d.to }));
  }

  it('roster 推入前不亮;meta 推入即亮(不依赖 docChanged);清空 roster 即灭', () => {
    const plugin = createGhostCommandPlugin();
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('$画图 一只猫'))),
      plugins: [plugin],
    });
    expect(decorationSpecs(plugin, state)).toEqual([]);

    state = state.apply(state.tr.setMeta(META_KEY, [画图]));
    // 两段:隐藏触发符 [1,2) + 胶囊本体 [2,4)
    expect(decorationSpecs(plugin, state)).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 4 },
    ]);

    state = state.apply(state.tr.setMeta(META_KEY, []));
    expect(decorationSpecs(plugin, state)).toEqual([]);
  });

  it('docChanged 时按现有 roster 重算:词被改坏即灭,改回即亮', () => {
    const plugin = createGhostCommandPlugin();
    let state = EditorState.create({
      schema,
      doc: doc(p(txt('$画图 猫'))),
      plugins: [plugin],
    });
    state = state.apply(state.tr.setMeta(META_KEY, [画图]));
    expect(decorationSpecs(plugin, state)).toHaveLength(2);

    // 在词中间插入字符 → `$画X图` 不再命中
    state = state.apply(state.tr.insertText('X', 3, 3));
    expect(decorationSpecs(plugin, state)).toEqual([]);

    // 删回去 → 恢复命中(隐藏触发符 + 胶囊两段)
    state = state.apply(state.tr.delete(3, 4));
    expect(decorationSpecs(plugin, state)).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  it('头像 data URL 白名单:base64 图片注入 --ghost-cmd-icon,异形值回退幽灵图标', () => {
    const good = ghostPillAttrs(makeGhost('画图', { icon: 'data:image/png;base64,AAAA' }));
    expect(good['data-ghost-cmd-icon']).toBe('');
    expect(good.style).toBe('--ghost-cmd-icon:url("data:image/png;base64,AAAA")');

    // 非 base64 / 含可破坏 CSS 声明字符的值一律不进内联 style
    const bad = ghostPillAttrs(makeGhost('画图', { icon: 'data:image/svg+xml,<svg onload=x>' }));
    expect(bad['data-ghost-cmd-icon']).toBeUndefined();
    expect(bad.style).toBeUndefined();

    // 无头像:保底属性齐全(class / id / title)
    const plain = ghostPillAttrs(画图);
    expect(plain).toMatchObject({
      class: 'ghost-cmd-pill',
      'data-ghost-cmd': 'ghost-画图',
    });
  });
});

describe('applyGhostCommandBackspace — 整体删除的接管边界', () => {
  const META_KEY = 'ghostCommandDecoration';

  /**
   * 在 state 层跑一次 Backspace:推 roster → 放光标 → 调用。view 只需要
   * state / dispatch 两个面,applyGhostCommandBackspace 不碰 DOM。
   */
  function backspaceAt(
    initial: PMNode,
    ghosts: InstalledGhost[],
    caret: number,
    caretTo = caret,
  ): { handled: boolean; text: string; caret: number } {
    const plugin = createGhostCommandPlugin();
    let state = EditorState.create({ schema, doc: initial, plugins: [plugin] });
    state = state.apply(state.tr.setMeta(META_KEY, ghosts));
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret, caretTo)));
    const view = {
      get state() {
        return state;
      },
      dispatch: (tr: ReturnType<typeof state.tr.delete>) => {
        state = state.apply(tr);
      },
    } as unknown as EditorView;
    const handled = applyGhostCommandBackspace(view);
    return {
      handled,
      text: state.doc.textBetween(0, state.doc.content.size, '\n'),
      caret: state.selection.from,
    };
  }

  // `$画图 一只猫`:$ 在 1,词尾 4,尾随空格 4,正文自 5 起
  const 带正文 = () => doc(p(txt('$画图 一只猫')));

  it('光标在胶囊外(尾随空格之后):整体删,不留孤立空格', () => {
    expect(backspaceAt(带正文(), [画图], 5)).toEqual({ handled: true, text: '一只猫', caret: 1 });
  });

  it('全角触发符(￥)同权整体删', () => {
    expect(backspaceAt(doc(p(txt('￥画图 猫'))), [画图], 5)).toMatchObject({
      handled: true,
      text: '猫',
    });
  });

  it('不接管:光标贴在词尾(视觉上在胶囊右内边距里)—— 那里是编辑位', () => {
    expect(backspaceAt(带正文(), [画图], 4)).toEqual({
      handled: false,
      text: '$画图 一只猫',
      caret: 4,
    });
  });

  it('不接管:没有尾随空格时光标只可能停在胶囊内,一律逐字删', () => {
    expect(backspaceAt(doc(p(txt('$画图'))), [画图], 4)).toMatchObject({
      handled: false,
      text: '$画图',
    });
    // 词尾是 hardBreak:光标在换行后属于下一行行首,退格该合并行而不是删引用
    expect(backspaceAt(doc(p(txt('$画图'), br(), txt('一只猫'))), [画图], 5)).toMatchObject({
      handled: false,
    });
  });

  it('不接管:光标在词中间 / 触发符前 / 正文里 —— 改词能力照旧', () => {
    expect(backspaceAt(带正文(), [画图], 3)).toMatchObject({
      handled: false,
      text: '$画图 一只猫',
    });
    expect(backspaceAt(带正文(), [画图], 1)).toMatchObject({
      handled: false,
      text: '$画图 一只猫',
    });
    expect(backspaceAt(带正文(), [画图], 8)).toMatchObject({
      handled: false,
      text: '$画图 一只猫',
    });
  });

  it('不接管:选区非空(原生删选区)', () => {
    expect(backspaceAt(带正文(), [画图], 1, 5)).toMatchObject({ handled: false });
  });

  it('不接管:胶囊没亮(roster 空 / 未装该指令 / 意识沉睡 / 位置不对)', () => {
    expect(backspaceAt(带正文(), [], 5)).toMatchObject({ handled: false, text: '$画图 一只猫' });
    expect(backspaceAt(doc(p(txt('$不存在 猫'))), [画图], 5)).toMatchObject({ handled: false });
    expect(backspaceAt(带正文(), [makeGhost('画图', { enabled: false })], 5)).toMatchObject({
      handled: false,
      text: '$画图 一只猫',
    });
    // 正文中段的 `$` 不是消息起点指令,不整体删
    expect(backspaceAt(doc(p(txt('帮我 $画图 猫'))), [画图], 8)).toMatchObject({ handled: false });
  });
});

describe('ghost command pill visual contract', () => {
  it('matches the shared inline reference chip geometry and color tokens', () => {
    const pillRule = globalsSource.match(/\.ProseMirror \.ghost-cmd-pill \{([\s\S]*?)\n\}/)?.[1];
    const iconRule = globalsSource.match(
      /\.ProseMirror \.ghost-cmd-pill::before \{([\s\S]*?)\n\}/,
    )?.[1];
    const joinedLeftRule = globalsSource.match(
      /\.ProseMirror \.ghost-cmd-pill:has\(\+ \.ghost-cmd-pill\) \{([\s\S]*?)\n\}/,
    )?.[1];
    const joinedRightRule = globalsSource.match(
      /\.ProseMirror \.ghost-cmd-pill \+ \.ghost-cmd-pill \{([\s\S]*?)\n\}/,
    )?.[1];

    expect(pillRule).toContain('background: var(--surface-chip)');
    expect(pillRule).toContain('border: 1px solid var(--border-default)');
    expect(pillRule).toContain('border-radius: 9999px');
    expect(pillRule).toContain('padding: 2px 8px');
    expect(pillRule).toContain('color: var(--text-primary)');
    expect(pillRule).toContain('font-size: 12px');
    expect(pillRule).toContain('font-weight: 400');
    expect(pillRule).toContain('line-height: 20px');
    expect(iconRule).toContain('width: 14px');
    expect(iconRule).toContain('height: 14px');
    expect(iconRule).toContain('margin-right: 6px');
    expect(joinedLeftRule).toContain('margin-right: 0');
    expect(joinedRightRule).toContain('margin-left: 0');
  });
});
