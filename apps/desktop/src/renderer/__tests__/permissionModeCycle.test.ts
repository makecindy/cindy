import { describe, expect, it } from 'vitest';

import { canonicalizePermissionMode, getNextPermissionMode } from '../lib/permissionModeCycle';
import type { PermissionModeDescriptor } from '../hooks/useAgentCapabilities';

function descriptors(ids: string[]): PermissionModeDescriptor[] {
  return ids.map((id) => ({ id, displayName: id }));
}

// cc 典型模式列表 (capabilities 返回顺序)
const CC_MODES = descriptors(['ask', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

describe('getNextPermissionMode', () => {
  it('cycles through the full capabilities list in order', () => {
    expect(getNextPermissionMode('ask', CC_MODES)).toBe('acceptEdits');
    expect(getNextPermissionMode('acceptEdits', CC_MODES)).toBe('plan');
    expect(getNextPermissionMode('plan', CC_MODES)).toBe('auto');
    expect(getNextPermissionMode('auto', CC_MODES)).toBe('bypassPermissions');
  });

  it('wraps around from the last mode to the first', () => {
    expect(getNextPermissionMode('bypassPermissions', CC_MODES)).toBe('ask');
  });

  it('falls back to the first option when current mode is not in the list', () => {
    expect(getNextPermissionMode('someUnknownMode', CC_MODES)).toBe('ask');
  });

  it('returns null when there are fewer than two options (key not consumed)', () => {
    expect(getNextPermissionMode('ask', descriptors(['ask']))).toBeNull();
    expect(getNextPermissionMode('ask', [])).toBeNull();
  });

  it('cycles a two-mode list back and forth', () => {
    const two = descriptors(['acceptEdits', 'plan']);
    expect(getNextPermissionMode('acceptEdits', two)).toBe('plan');
    expect(getNextPermissionMode('plan', two)).toBe('acceptEdits');
  });
});

// 显示选中项、同档比较、Shift+Tab 轮切必须共用这一道归一,否则会出现「点界面上已选中
// 的那项 = 一次真实切档」——白写一次 setPermissionMode,进而 dismissAllPending 结掉
// 手里的 pending 请求。
describe('canonicalizePermissionMode', () => {
  it('清单里已有的档原样返回', () => {
    expect(canonicalizePermissionMode('acceptEdits', CC_MODES)).toBe('acceptEdits');
    expect(canonicalizePermissionMode('bypassPermissions', CC_MODES)).toBe('bypassPermissions');
  });

  it('legacy default 收敛到清单首项(ask),与选择器显示的选中项一致', () => {
    expect(canonicalizePermissionMode('default', CC_MODES)).toBe('ask');
  });

  it('另一 agent 的专有档收敛到首项(codex 会话带着 cc 的 acceptEdits)', () => {
    const codexModes = descriptors(['ask', 'auto', 'bypassPermissions']);
    expect(canonicalizePermissionMode('acceptEdits', codexModes)).toBe('ask');
    expect(canonicalizePermissionMode('plan', codexModes)).toBe('ask');
  });

  it('capabilities 还没到时原样返回,不猜', () => {
    expect(canonicalizePermissionMode('default', [])).toBe('default');
  });

  it('归一后轮切才会前进到下一档,而不是停在 ask', () => {
    const canonical = canonicalizePermissionMode('default', CC_MODES);
    expect(getNextPermissionMode(canonical, CC_MODES)).toBe('acceptEdits');
    // 不归一的话:'default' 不在清单里 → 落回首项 ask,用户按了却像没动。
    expect(getNextPermissionMode('default', CC_MODES)).toBe('ask');
  });
});
