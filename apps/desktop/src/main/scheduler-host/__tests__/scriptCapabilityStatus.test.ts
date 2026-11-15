import { describe, expect, it } from 'vitest';

import { resolveScriptCapabilityStatuses } from '../script-capability-status';

describe('resolveScriptCapabilityStatuses', () => {
  it('marks ghost-backed capabilities ok when their ghosts are installed and awake', () => {
    const statuses = resolveScriptCapabilityStatuses([
      { id: 'xd-atlassian', name: 'XD Atlassian', enabled: true },
      { id: 'xd-feishu', name: 'XD Feishu', enabled: true },
    ]);
    expect(statuses).toEqual([
      { capability: 'github.read', state: 'ok' },
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
});
