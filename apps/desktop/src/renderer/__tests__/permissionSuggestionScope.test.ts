/**
 * permissionSuggestionScope.test.ts
 * ---------------------------------------------------------------------------
 * 权限卡片上那个按钮原本只写「本对话总是允许」,既没说允许的是哪一类,也容易被读成
 * 「什么都允许」。范围文本由本模块从 agent 给的授权建议里提取,所以这里锁死两件事:
 * 能描述时给出**准确**的规则原文(不意译、不放宽);只要有**任何一项**授权项描述不完整
 * 就整体返回 null。后者是安全要求:点击会把 suggestions 里每一项都转发成
 * updatedPermissions,文案漏掉一项(比如混进来的 setMode)就等于一边宣称「只允许这一类」、
 * 一边顺手改了权限档位。分隔符交给调用方按语言拼,这里只返回结构化清单。
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
    ).toEqual(['Bash(curl:*)']);
  });

  it('无 ruleContent 的规则只显示工具名(MCP 工具常见)', () => {
    expect(
      describeSessionPermissionScope([sessionRule([{ toolName: 'mcp__feishu__call_tool' }])]),
    ).toEqual(['mcp__feishu__call_tool']);
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
    ).toEqual(['Bash(curl:*)', 'Bash(git:*)']);
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

  // 关键安全用例:混进一项描述不出来的授权,整个范围声明必须放弃 —— 否则按钮会
  // 宣称「只允许 Bash(curl:*)」,而点击时把那条未列出的 update 一起交出去。
  it('任何一项描述不全 → 整体放弃,不做部分声明', () => {
    expect(
      describeSessionPermissionScope([
        sessionRule([{ toolName: 'Bash', ruleContent: 'curl:*' }, { notAToolRule: true }]),
      ]),
    ).toBeNull();
    expect(
      describeSessionPermissionScope([
        sessionRule([{ toolName: 'Bash', ruleContent: 'curl:*' }]),
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      ]),
    ).toBeNull();
    expect(
      describeSessionPermissionScope([
        sessionRule([{ toolName: 'Bash', ruleContent: 'curl:*' }]),
        { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      ]),
    ).toBeNull();
  });

  it('rules 为空数组也算描述不出来', () => {
    expect(describeSessionPermissionScope([sessionRule([])])).toBeNull();
  });
});
