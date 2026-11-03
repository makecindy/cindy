import { describe, it, expect } from 'vitest';
import {
  computeTextareaContinuation,
  computeTextareaBackspace,
} from '../composerListTextarea';

/**
 * textarea 列表适配层纯逻辑测试。用 `|` 标记光标:helper 去掉标记后返回
 * { value, caret },避免手数 offset。
 */
function caret(marked: string): { value: string; caret: number } {
  const idx = marked.indexOf('|');
  if (idx < 0) throw new Error('测试字符串缺少光标标记 |');
  return { value: marked.slice(0, idx) + marked.slice(idx + 1), caret: idx };
}

function continuation(marked: string) {
  const { value, caret: c } = caret(marked);
  return computeTextareaContinuation(value, c, c);
}

function backspace(marked: string) {
  const { value, caret: c } = caret(marked);
  return computeTextareaBackspace(value, c, c);
}

describe('computeTextareaContinuation', () => {
  it('有序列表接续:序号 +1', () => {
    expect(continuation('1. buy|')).toEqual({ value: '1. buy\n2. ', caret: 10 });
  });

  it('有序列表用 ) 分隔也接续', () => {
    expect(continuation('3) foo|')).toEqual({ value: '3) foo\n4) ', caret: 10 });
  });

  it('中文顿号序号接续', () => {
    const r = continuation('1、买菜|');
    expect(r).toEqual({ value: '1、买菜\n2、', caret: 7 });
  });

  it('无序列表接续:前缀原样复制', () => {
    expect(continuation('- item|')).toEqual({ value: '- item\n- ', caret: 9 });
  });

  it('待办项接续:新项永远未勾选', () => {
    const r = continuation('- [x] done|');
    expect(r).toEqual({ value: '- [x] done\n- [ ] ', caret: 17 });
  });

  it('引用行接续', () => {
    expect(continuation('> quote|')).toEqual({ value: '> quote\n> ', caret: 10 });
  });

  it('空项(前缀后无内容)→ 清掉前缀退出列表', () => {
    // "1. buy\n2. " 的第二行只有前缀,光标在行尾。
    const value = '1. buy\n2. ';
    const c = value.length;
    expect(computeTextareaContinuation(value, c, c)).toEqual({
      value: '1. buy\n',
      caret: 7,
    });
  });

  it('保留缩进', () => {
    expect(continuation('  - a|')).toEqual({ value: '  - a\n  - ', caret: 10 });
  });

  it('非列表行 → null', () => {
    expect(continuation('hello|')).toBeNull();
  });

  it('有选区(非折叠光标)→ null', () => {
    expect(computeTextareaContinuation('1. buy', 0, 6)).toBeNull();
  });

  it('多行文本中间行接续,后文保留', () => {
    // "1. a\n2. b|\ntail" —— 在第二行尾接续,tail 不受影响。
    const r = continuation('1. a\n2. b|\ntail');
    expect(r).toEqual({ value: '1. a\n2. b\n3. \ntail', caret: 13 });
  });

  it('光标在标记后、正文前(`1. |todo`)→ 接续拆分,不退出(codex P2)', () => {
    // 不能只看光标前("1. "),否则误判空项退出、删标记留裸 "todo"。整行有正文 → 拆分。
    expect(continuation('1. |todo')).toEqual({ value: '1. \n2. todo', caret: 7 });
  });

  it('真正空项(光标前后都无正文)仍退出列表', () => {
    // "1. |" 行尾无正文 → exit(清前缀回行首)。
    expect(continuation('1. |')).toEqual({ value: '', caret: 0 });
  });
});

describe('computeTextareaBackspace', () => {
  it('空列表项在行尾退格:只删前缀、保留换行,停在空行行首', () => {
    // "1. a\n2. " 第二行是空项,光标在末尾。
    const value = '1. a\n2. ';
    const c = value.length;
    expect(computeTextareaBackspace(value, c, c)).toEqual({ value: '1. a\n', caret: 5 });
    // 空行上再退格不再拦截,交给默认退格回到上一行。
    expect(computeTextareaBackspace('1. a\n', 5, 5)).toBeNull();
  });

  it('首行空列表项退格:只删前缀', () => {
    const value = '1. ';
    const c = value.length;
    expect(computeTextareaBackspace(value, c, c)).toEqual({ value: '', caret: 0 });
  });

  it('前缀后有内容 → null(走默认逐字符退格)', () => {
    expect(backspace('2. x|')).toBeNull();
  });

  it('光标不在行尾 → null', () => {
    // "2. " 中光标在前缀中间。
    expect(backspace('2.| ')).toBeNull();
  });

  it('非列表行 → null', () => {
    expect(backspace('plain|')).toBeNull();
  });

  it('空项后紧跟换行(非文本末尾)也退出:只删前缀、保留前后换行', () => {
    // "x\n- \nnext" 光标在第二行(空 bullet)行尾,其后是 \n(非 EOF)。
    const value = 'x\n- \nnext';
    expect(computeTextareaBackspace(value, 4, 4)).toEqual({ value: 'x\n\nnext', caret: 2 });
  });

  it('有选区 → null', () => {
    expect(computeTextareaBackspace('1. ', 0, 3)).toBeNull();
  });
});
