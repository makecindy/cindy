/**
 * permissionSuggestionScope.test.ts
 * ---------------------------------------------------------------------------
 * 权限卡片上那个按钮原本只写「本对话总是允许」,既没说允许的是哪一类,也容易被读成
 * 「什么都允许」。范围文本由本模块从 agent 给的授权建议里提取,所以这里锁死两件事:
 * 能描述时给出**准确**的规则原文(不意译、不放宽),形状不认识时一律返回 null
 * (调用方据此退回原文案,绝不猜一个更宽的范围出来)。
 */

import { describe, expect, it } from 'vitest';

import { describeSessionPermissionScope } from '../lib/permissionSuggestionScope';

const sessionRule = (rules: unknown[]) => ({
  type: 'addRules',
  rules,
  behavior: 'allow',
  destination: 'session',
});

describe('describeSessionPermissionScope', () => {
  it('带 ruleContent 的规则显示成 工具(规则)', () => {
    expect(
      describeSessionPermissionScope([sessionRule([{ toolName: 'Bash', ruleContent: 'curl:*' }])]),
    ).toBe('Bash(curl:*)');
  });

  it('无 ruleContent 的规则只显示工具名(MCP 工具常见)', () => {
    expect(
      describeSessionPermissionScope([sessionRule([{ toolName: 'mcp__feishu__call_tool' }])]),
    ).toBe('mcp__feishu__call_tool');
  });

  it('多条规则全部列出,并按原文去重', () => {
    expect(
      describeSessionPermissionScope([
        sessionRule([
          { toolName: 'Bash', ruleContent: 'curl:*' },
          { toolName: 'Bash', ruleContent: 'git:*' },
        ]),
        sessionRule([{ toolName: 'Bash', ruleContent: 'curl:*' }]),
      ]),
    ).toBe('Bash(curl:*)、Bash(git:*)');
  });

  // 只有「加一条放行规则」才是这个按钮的语义。其余类型拿来生成文案会说谎:
  // removeRules 是收紧、setMode 是换档位,都不是「以后允许这一类」。
  it('只认 addRules + allow,其它类型不描述', () => {
    expect(describeSessionPermissionScope([
      { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    ])).toBeNull();
    expect(describeSessionPermissionScope([
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
    ])).toBeNull();
    expect(describeSessionPermissionScope([
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    ])).toBeNull();
  });

  it('形状不认识时返回 null,不猜也不兜底放宽', () => {
    expect(describeSessionPermissionScope([])).toBeNull();
    expect(describeSessionPermissionScope([null, 'nope', 42])).toBeNull();
    expect(describeSessionPermissionScope([sessionRule([{ ruleContent: 'curl:*' }])])).toBeNull();
    expect(describeSessionPermissionScope([sessionRule([{ toolName: '   ' }])])).toBeNull();
    expect(describeSessionPermissionScope([sessionRule('not-an-array' as unknown as unknown[])])).toBeNull();
  });

  it('部分规则可描述时,只列可描述的那些', () => {
    expect(
      describeSessionPermissionScope([
        sessionRule([{ toolName: 'Bash', ruleContent: 'curl:*' }, { notAToolRule: true }]),
      ]),
    ).toBe('Bash(curl:*)');
  });
});
