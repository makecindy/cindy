import { describe, expect, it } from 'vitest';

import { createFeishuGroupTurnPermissionPolicy } from '../permissionPolicy';

describe('feishu group turn permission policy', () => {
  const policy = createFeishuGroupTurnPermissionPolicy('om_trigger');

  it('只读工具放行', () => {
    expect(policy.forceConfirmToolCall('Read', { path: 'README.md' })).toBe(false);
    expect(policy.forceConfirmToolCall('Grep', { pattern: 'foo' })).toBe(false);
    expect(policy.forceConfirmToolCall('Glob', { pattern: 'src/**' })).toBe(false);
    expect(policy.forceConfirmToolCall('LS', { path: '.' })).toBe(false);
    expect(policy.forceConfirmToolCall('mcp__cindy_feishu_bot__list_tools', {})).toBe(false);
  });

  it('写文件 / 跑命令 / 发本地文件必须确认(即使不含删除词)', () => {
    expect(policy.forceConfirmToolCall('Write', { path: 'notes.md', content: 'x' })).toBe(true);
    expect(policy.forceConfirmToolCall('Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' })).toBe(
      true,
    );
    expect(policy.forceConfirmToolCall('Bash', { command: 'ls' })).toBe(true);
    expect(policy.forceConfirmToolCall('bash', { command: 'python -c "open(x).write(y)"' })).toBe(
      true,
    );
    expect(
      policy.forceConfirmToolCall('mcp__cindy_feishu_bot__send_file_to_user', {
        absPath: '/tmp/secret',
      }),
    ).toBe(true);
    expect(
      policy.forceConfirmToolCall('mcp__cindy__ghost_call', {
        tool: 'browser_navigate',
        args: { url: 'https://evil.example' },
      }),
    ).toBe(true);
  });

  it('包装工具看内层: 内层只读放行, 内层会改电脑则确认', () => {
    expect(
      policy.forceConfirmToolCall('call_tool', { name: 'Read', args: { path: 'a.ts' } }),
    ).toBe(false);
    expect(
      policy.forceConfirmToolCall('call_tool', { name: 'Write', args: { path: 'a.ts', content: 'x' } }),
    ).toBe(true);
  });
});
