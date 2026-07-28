import { describe, expect, it } from 'vitest';
import { computeListContinuation } from '../composerListContinuation';

describe('computeListContinuation', () => {
  describe('有序列表', () => {
    it('`1. ` 接续为序号 +1', () => {
      expect(computeListContinuation('1. foo')).toEqual({ action: 'continue', insert: '2. ' });
    });

    it('多位数序号正常自增', () => {
      expect(computeListContinuation('12) bar')).toEqual({ action: 'continue', insert: '13) ' });
    });

    it('七位数序号正常自增', () => {
      expect(computeListContinuation('999999. item')).toEqual({
        action: 'continue',
        insert: '1000000. ',
      });
    });

    it('八位数序号正常接续', () => {
      expect(computeListContinuation('10000000. item')).toEqual({
        action: 'continue',
        insert: '10000001. ',
      });
    });

    it('保留分隔符后的多余空白', () => {
      expect(computeListContinuation('3.  foo')).toEqual({ action: 'continue', insert: '4.  ' });
    });

    it('中文顿号序号(无空格)接续', () => {
      expect(computeListContinuation('1、中文项')).toEqual({ action: 'continue', insert: '2、' });
    });

    it('保留缩进', () => {
      expect(computeListContinuation('  2. nested')).toEqual({ action: 'continue', insert: '  3. ' });
    });

    it('空项退出列表(光标前后都无正文)', () => {
      expect(computeListContinuation('1. ')).toEqual({ action: 'exit' });
      expect(computeListContinuation('1.   ')).toEqual({ action: 'exit' });
      expect(computeListContinuation('5、')).toEqual({ action: 'exit' });
    });

    it('光标在标记后、正文前(`1. |todo`)不算空项 → 接续拆分,不退出', () => {
      // 光标前 = "1. "(rest 空),但光标后仍有 "todo" → 整行非空 → continue
      expect(computeListContinuation('1. ', 'todo')).toEqual({ action: 'continue', insert: '2. ' });
      // 光标后是空白也算空项
      expect(computeListContinuation('1. ', '   ')).toEqual({ action: 'exit' });
    });

    it('序号后没有空格不算列表(避免误伤中文正文和 `1.5倍` 这类输入)', () => {
      expect(computeListContinuation('1.foo')).toBeNull();
      expect(computeListContinuation('1.中文项')).toBeNull();
      expect(computeListContinuation('1.5倍速')).toBeNull();
    });
  });

  describe('无序列表', () => {
    it('`- ` / `+ ` / `* ` / `• ` 原样接续', () => {
      expect(computeListContinuation('- item')).toEqual({ action: 'continue', insert: '- ' });
      expect(computeListContinuation('+ item')).toEqual({ action: 'continue', insert: '+ ' });
      expect(computeListContinuation('* item')).toEqual({ action: 'continue', insert: '* ' });
      expect(computeListContinuation('• item')).toEqual({ action: 'continue', insert: '• ' });
    });

    it('保留缩进与空白宽度', () => {
      expect(computeListContinuation('  -  wide')).toEqual({ action: 'continue', insert: '  -  ' });
    });

    it('空项退出', () => {
      expect(computeListContinuation('- ')).toEqual({ action: 'exit' });
    });

    it('`-foo`(无空格)不算列表', () => {
      expect(computeListContinuation('-foo')).toBeNull();
    });
  });

  describe('待办列表', () => {
    it('未勾选项接续为新的未勾选项', () => {
      expect(computeListContinuation('- [ ] task')).toEqual({ action: 'continue', insert: '- [ ] ' });
    });

    it('已勾选项接续仍为未勾选新项', () => {
      expect(computeListContinuation('- [x] done')).toEqual({ action: 'continue', insert: '- [ ] ' });
      expect(computeListContinuation('* [X] done')).toEqual({ action: 'continue', insert: '* [ ] ' });
    });

    it('空项退出(含 `]` 顶到行尾的形态)', () => {
      expect(computeListContinuation('- [ ] ')).toEqual({ action: 'exit' });
      expect(computeListContinuation('- [ ]')).toEqual({ action: 'exit' });
    });
  });

  describe('引用', () => {
    it('`> ` 接续', () => {
      expect(computeListContinuation('> quoted')).toEqual({ action: 'continue', insert: '> ' });
    });

    it('空引用退出', () => {
      expect(computeListContinuation('> ')).toEqual({ action: 'exit' });
    });

    it('`>no space` 不算引用', () => {
      expect(computeListContinuation('>no space')).toBeNull();
    });
  });

  describe('非列表行', () => {
    it('普通文本 / 空行返回 null', () => {
      expect(computeListContinuation('hello world')).toBeNull();
      expect(computeListContinuation('')).toBeNull();
      expect(computeListContinuation('   ')).toBeNull();
    });

    it('行首是原子节点占位符(mention chip)时不匹配', () => {
      expect(computeListContinuation('￼1. x')).toBeNull();
    });

    it('字母序号(`a. `)不支持', () => {
      expect(computeListContinuation('a. foo')).toBeNull();
    });
  });
});
