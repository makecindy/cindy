import { describe, expect, it } from 'vitest';

import { resolveOrcaWorkersTabTone } from '../OrcaWorkersAttentionIcon';

describe('resolveOrcaWorkersTabTone', () => {
  it('多个 Worker 时按 出错 > 等待确认 > 完成未读 取最高一档', () => {
    expect(resolveOrcaWorkersTabTone({ urgentKind: 'error', hasDoneAttention: true, active: false }))
      .toBe('error');
    expect(resolveOrcaWorkersTabTone({ urgentKind: 'awaiting', hasDoneAttention: true, active: false }))
      .toBe('awaiting');
    expect(resolveOrcaWorkersTabTone({ urgentKind: undefined, hasDoneAttention: true, active: false }))
      .toBe('done');
    expect(resolveOrcaWorkersTabTone({ urgentKind: undefined, hasDoneAttention: false, active: false }))
      .toBeNull();
  });

  it('出错 / 等待确认在 tab 激活时也显示;完成未读激活即视为看到', () => {
    expect(resolveOrcaWorkersTabTone({ urgentKind: 'awaiting', hasDoneAttention: false, active: true }))
      .toBe('awaiting');
    expect(resolveOrcaWorkersTabTone({ urgentKind: 'error', hasDoneAttention: false, active: true }))
      .toBe('error');
    expect(resolveOrcaWorkersTabTone({ urgentKind: undefined, hasDoneAttention: true, active: true }))
      .toBeNull();
  });
});
