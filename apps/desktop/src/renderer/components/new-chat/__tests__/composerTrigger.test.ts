/**
 * composerTrigger.test.ts — composer 触发符的识别契约。
 *
 * 测试价值
 * - 生产入口与可观察结果:`detectTrigger(EditorState)` 是输入框判断 `/` `$` `、` `@`
 *   面板该不该打开的唯一边界;返回值决定面板开合、查询词,以及替换起点 `from`。
 * - Bug／规则依据:makecindy/cindy#11562(中文输入法把 `/` 键上屏成顿号,首字符
 *   `、` 应等同 `/`),以及 `GHOST_SIGIL_CHARS` 已有的全角 `$` 别名契约。
 * - 现有覆盖缺口:这段逻辑此前埋在 ChatInput 内部且未导出,没有任何 state 级用例,
 *   面板开合矩阵(尤其是"什么情况下不该开")无人锁定。
 * - 最小失败输入:文档首个字符是 `、` 时 `detectTrigger` 返回 `{ kind: 'none' }`。
 * - tier:unit —— 纯 ProseMirror state,无 DOM、无 IPC、无真实输入法。
 * - 实测耗时:`vitest run composerTrigger.test.ts` 整文件 2.6s(用例本身 5ms)。
 */
import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';

import { detectTrigger } from '../composerTrigger';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    mentionChip: { group: 'inline', inline: true, atom: true },
    composerQuote: { group: 'inline', inline: true, atom: true },
  },
});

const p = (...children: PMNode[]) => schema.nodes.paragraph.create(null, children);
const txt = (text: string) => schema.text(text);
const doc = (...paragraphs: PMNode[]) => schema.nodes.doc.create(null, paragraphs);
const chip = () => schema.nodes.mentionChip.create();

/** 光标落在文档末尾时的触发结果 —— 输入法上屏后最常见的位置。 */
function triggerAtEnd(source: PMNode) {
  return detectTrigger(EditorState.create({ doc: source, selection: TextSelection.atEnd(source) }));
}

describe('detectTrigger', () => {
  it('`/` 保持原规则:段首或空白后触发,粘在词里不触发', () => {
    expect(triggerAtEnd(doc(p(txt('/com'))))).toEqual({
      kind: 'slash',
      sigil: '/',
      query: 'com',
      from: 1,
    });
    // 段中句子里打空格再打 `/` 仍然要能唤起面板(旧行为的回归线)。
    expect(triggerAtEnd(doc(p(txt('正文 /le'))))).toEqual({
      kind: 'slash',
      sigil: '/',
      query: 'le',
      from: 4,
    });
    expect(triggerAtEnd(doc(p(txt('甲/乙'))))).toEqual({ kind: 'none' });
  });

  it('文档首字符是顿号时等同 `/`,输入期间不改写字符', () => {
    expect(triggerAtEnd(doc(p(txt('、'))))).toEqual({
      kind: 'slash',
      sigil: '/',
      query: '',
      from: 1,
    });
    expect(triggerAtEnd(doc(p(txt('、lea'))))).toEqual({
      kind: 'slash',
      sigil: '/',
      query: 'lea',
      from: 1,
    });
    // 已知取舍:首位顿号 + 中文正文会弹出空结果面板,按 Esc 后顿号原样保留。
    expect(triggerAtEnd(doc(p(txt('、还有第三条'))))).toEqual({
      kind: 'slash',
      sigil: '/',
      query: '还有第三条',
      from: 1,
    });
  });

  it('顿号不在文档第一个字符时不触发', () => {
    // 正文里的顿号是正经标点。
    expect(triggerAtEnd(doc(p(txt('甲、乙'))))).toEqual({ kind: 'none' });
    expect(triggerAtEnd(doc(p(txt('甲 、'))))).toEqual({ kind: 'none' });
    // 第二段行首、以及首个 chip 之后的顿号都不算「消息开头」。
    expect(triggerAtEnd(doc(p(txt('甲')), p(txt('、abc'))))).toEqual({ kind: 'none' });
    expect(triggerAtEnd(doc(p(chip(), txt('、abc'))))).toEqual({ kind: 'none' });
    // 触发符与光标之间不能有空白(与 `/` 同一判据)。
    expect(triggerAtEnd(doc(p(txt('、 lea'))))).toEqual({ kind: 'none' });
    expect(triggerAtEnd(doc(p(txt('、'), schema.nodes.hardBreak.create(), txt('abc'))))).toEqual({
      kind: 'none',
    });
  });

  it('全角 `$` 别名与 `@` 提及的识别不变', () => {
    expect(triggerAtEnd(doc(p(txt('＄画图'))))).toEqual({
      kind: 'slash',
      sigil: '$',
      query: '画图',
      from: 1,
    });
    expect(triggerAtEnd(doc(p(txt('￥画图'))))).toEqual({
      kind: 'slash',
      sigil: '$',
      query: '画图',
      from: 1,
    });
    // 指令词后出现空白就结束 run —— 面板此时已不需要过滤,与 `/` 同一判据。
    expect(triggerAtEnd(doc(p(txt('＄画图 一只猫'))))).toEqual({ kind: 'none' });
    expect(triggerAtEnd(doc(p(txt('open @src'))))).toEqual({
      kind: 'at',
      query: 'src',
      from: 6,
    });
    expect(triggerAtEnd(doc(p(txt('mail@company'))))).toEqual({ kind: 'none' });
  });

  it('有选区或光标不在段落里时不触发', () => {
    const source = doc(p(txt('、lea')));
    const selected = detectTrigger(
      EditorState.create({ doc: source, selection: TextSelection.create(source, 1, 3) }),
    );
    expect(selected).toEqual({ kind: 'none' });
  });
});
