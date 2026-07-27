import { describe, expect, it } from 'vitest';

import { resolveScriptCapabilityStatuses } from '../script-capability-status';

describe('resolveScriptCapabilityStatuses', () => {
  it('marks ghost-backed capabilities ok when their ghosts are installed and awake', () => {
    const statuses = resolveScriptCapabilityStatuses([
      { id: 'xd-atlassian', name: 'XD Atlassian', enabled: true },
      { id: 'xd-feishu', name: 'XD Feishu', enabled: true },
    ]);
    expect(statuses).toEqual([
      { capability: 'jira.read', state: 'ok' },
      { capability: 'jira.comment', state: 'ok' },
      { capability: 'sessions.dispatch', state: 'ok' },
      { capability: 'feishu.read', state: 'ok' },
    ]);
  });

  it('marks feishu.read against xd-feishu availability (2026-07-17 ghost pipe 切换)', () => {
    const asleep = resolveScriptCapabilityStatuses([
      { id: 'xd-feishu', name: 'XD Feishu', enabled: false },
    ]);
    expect(asleep.find((s) => s.capability === 'feishu.read')).toEqual({
      capability: 'feishu.read',
      state: 'ghost-asleep',
      ghostName: 'XD Feishu',
    });
    const missing = resolveScriptCapabilityStatuses([]);
    expect(missing.find((s) => s.capability === 'feishu.read')).toEqual({
      capability: 'feishu.read',
      state: 'ghost-missing',
      ghostName: 'xd-feishu',
    });
  });

  it('marks jira capabilities ghost-asleep when the ghost is disabled', () => {
    const statuses = resolveScriptCapabilityStatuses([
      { id: 'xd-atlassian', name: 'XD Atlassian', enabled: false },
    ]);
    expect(statuses.find((s) => s.capability === 'jira.read')).toEqual({
      capability: 'jira.read',
      state: 'ghost-asleep',
      ghostName: 'XD Atlassian',
    });
    // host 原生能力不受意识状态影响
    expect(statuses.find((s) => s.capability === 'sessions.dispatch')?.state).toBe('ok');
  });

  it('marks jira capabilities ghost-missing (name falls back to id) when not installed', () => {
    const statuses = resolveScriptCapabilityStatuses([]);
    expect(statuses.find((s) => s.capability === 'jira.comment')).toEqual({
      capability: 'jira.comment',
      state: 'ghost-missing',
      ghostName: 'xd-atlassian',
    });
  });

  it('生命周期投影的非 ready 态映射为对应能力警示', () => {
    const cases: Array<{
      readiness: 'needs_setup' | 'needs_reauth' | 'degraded' | 'blocked' | 'unknown';
      expected: 'ghost-needs-setup' | 'ghost-needs-reauth' | 'ghost-blocked' | 'ghost-degraded';
    }> = [
      { readiness: 'needs_setup', expected: 'ghost-needs-setup' },
      { readiness: 'needs_reauth', expected: 'ghost-needs-reauth' },
      { readiness: 'degraded', expected: 'ghost-degraded' },
      // blocked 是云端会话/账号服务缺失,独立成态(文案≠「去配置」);
      // unknown 按「需要用户处置」归类到 needs-setup 警示
      { readiness: 'blocked', expected: 'ghost-blocked' },
      { readiness: 'unknown', expected: 'ghost-needs-setup' },
    ];
    for (const { readiness, expected } of cases) {
      const statuses = resolveScriptCapabilityStatuses([
        { id: 'xd-atlassian', name: 'XD Atlassian', enabled: true, readiness },
      ]);
      expect(statuses.find((s) => s.capability === 'jira.read')).toEqual({
        capability: 'jira.read',
        state: expected,
        ghostName: 'XD Atlassian',
      });
    }
    // ready 与缺省(旧调用方)不受影响
    const ok = resolveScriptCapabilityStatuses([
      { id: 'xd-atlassian', name: 'XD Atlassian', enabled: true, readiness: 'ready' },
    ]);
    expect(ok.find((s) => s.capability === 'jira.read')?.state).toBe('ok');
  });
});
