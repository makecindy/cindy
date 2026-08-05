import { describe, expect, it } from 'vitest';

import { validateTitleOutput } from '../title-output-validation.js';

describe('validateTitleOutput', () => {
  it.each([
    ['Assistant: 再补一个回归测试', 'role label'],
    ['Assistant：再补一个回归测试', 'full-width role label'],
    ['User - 继续', 'dash role label'],
    ['这轮反馈刚查,改样式:\nAssistant: 再补一个回归测试', 'multiline transcript'],
    ['```\n标题\n```', 'code fence'],
    ['# 标题', 'markdown heading'],
    ['根据对话内容，这是一个标题', 'meta prefix'],
    ['根据对话内容这是一个标题', 'meta prefix without punctuation'],
    ['以下是标题：登录问题', 'Chinese meta prefix before title label'],
    ['以下是一个标题', 'Chinese meta prefix before ordinary characters'],
    ['タイトル：ログイン問題', 'Japanese title label'],
    ['제목: 로그인 문제', 'Korean title label'],
    ['アシスタント：回帰テストを追加', 'Japanese role label'],
    ['사용자: 계속해 주세요', 'Korean role label'],
    ['助手：再补一个回归测试', 'Chinese role label'],
  ])('rejects %s (%s)', (value) => {
    expect(validateTitleOutput(value, 20)).toBeNull();
  });

  it.each([
    ['生成简洁中文标题', 'issue #1688 verbatim echo'],
    ['简洁中文标题', 'echo without leading verb'],
    ['请为用户消息生成一个简洁的中文标题', 'long-form Chinese echo'],
    ['生成简洁标题', 'echo without language word'],
    ['Generate a concise title', 'English echo'],
    ['Concise title', 'English echo without verb'],
    ['簡潔なタイトル', 'Japanese echo'],
    ['간결한 제목', 'Korean echo'],
    ['生成简洁中文标题。', 'echo with fullwidth period'],
    ['简洁中文标题！', 'echo with fullwidth exclamation'],
    ['Generate a concise title.', 'English echo with period'],
    ['Concise title!', 'English echo with exclamation'],
    ['簡潔なタイトル。', 'Japanese echo with period'],
    ['간결한 제목.', 'Korean echo with period'],
  ])('rejects instruction echo %s (%s)', (value) => {
    expect(validateTitleOutput(value, 20)).toBeNull();
  });

  it('keeps titles that merely mention titles', () => {
    expect(validateTitleOutput('修复标题生成 bug', 20)).toBe('修复标题生成 bug');
    expect(validateTitleOutput('优化会话标题样式', 20)).toBe('优化会话标题样式');
    // 尾部标点仅在回显探测时剥离,非回显标题原样保留。
    expect(validateTitleOutput('优化会话标题样式。', 20)).toBe('优化会话标题样式。');
  });

  it('accepts a concise Unicode title and removes accidental wrapping quotes', () => {
    expect(validateTitleOutput('  「Codex 子代理测试」  ', 20)).toBe('Codex 子代理测试');
  });

  it('uses Unicode code points for the length limit', () => {
    expect(validateTitleOutput('😀😀😀', 3)).toBe('😀😀😀');
    expect(validateTitleOutput('😀😀😀😀', 3)).toBeNull();
  });
});
