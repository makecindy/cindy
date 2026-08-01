/**
 * agentKindToVendor 回归 —— 2026-07-30 实测 bug:Dialogues 会话行的 vendor 图标
 * 只写了 `=== 'codex' ? 'codex' : 'cc'`,PI 会话被吞成 Claude 像素脸。
 * 该映射现收敛到 VendorIcon.agentKindToVendor,这里锁死三种 agentKind 的取值
 * 与 null/别名回落,防止再回退成二元三元。
 */
import { describe, expect, it } from 'vitest';

import { agentKindToVendor } from '@/components/sidebar/VendorIcon';

describe('agentKindToVendor', () => {
  it('maps pi sessions to the pi vendor mark (2026-07-30 regression)', () => {
    expect(agentKindToVendor('pi')).toBe('pi');
  });

  it('maps codex to codex and cc/claude-code/null to cc', () => {
    expect(agentKindToVendor('codex')).toBe('codex');
    expect(agentKindToVendor('cc')).toBe('cc');
    expect(agentKindToVendor('claude-code')).toBe('cc');
    expect(agentKindToVendor(null)).toBe('cc');
    expect(agentKindToVendor(undefined)).toBe('cc');
  });
});
