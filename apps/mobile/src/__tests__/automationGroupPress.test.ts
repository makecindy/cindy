import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteSessionListItem } from '@cindy/maker-shared/session-list';
import { resolveMobileSessionRowStatus } from '../session/sessionRightStatus';

const source = readFileSync(resolve(process.cwd(), 'app/devices/index.tsx'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  const openGroupPrimary = () => {');
const body = source.slice(start, source.indexOf('  return (', start));
// Execute the actual row handler while keeping native rendering out of this unit test.
const handler = new Function('group', 'statusTarget', 'attention', 'rightStatus', 'groupExpanded',
  'selectionMode', 'onPressSelection', 'onOpenSession', 'onToggleAutomationGroup', 'item',
  `${body}\nreturn handlePress;`);
const row = (id: string, time: number): RemoteSessionListItem => ({
  session: { id, status: 'active', createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString() },
  pendingInteractionCount: 0,
} as RemoteSessionListItem);

describe('automation group row press', () => {
  it.each([false, true])('opens the persisted interruption only while collapsed (expanded=%s)', (expanded) => {
    const interrupted = row('interrupted', 1000);
    Object.assign(interrupted.session, { activeTurnStartedAt: 1000, interruptedTurnStartedAt: 1000, lastTurnEndedAt: 900 });
    const latest = row('latest', 2000);
    const item = { ...latest, automationGroup: { key: 'group', items: [interrupted, latest], sessionCount: 2 } } as RemoteSessionListItem;
    const { status, target } = resolveMobileSessionRowStatus(item, false, expanded);
    const open = vi.fn(); const toggle = vi.fn();
    handler(item.automationGroup, target, false, status, expanded, false, undefined, open, toggle, item)();
    if (expanded) { expect(toggle).toHaveBeenCalledWith('group'); expect(open).not.toHaveBeenCalled(); }
    else { expect(open).toHaveBeenCalledWith(interrupted); expect(toggle).not.toHaveBeenCalled(); }
    Object.assign(interrupted.session, { lastTurnEndedAt: 1000 });
    const resolved = resolveMobileSessionRowStatus(item, false, false);
    open.mockClear(); toggle.mockClear();
    handler(item.automationGroup, resolved.target, false, resolved.status, false, false, undefined, open, toggle, item)();
    expect(toggle).toHaveBeenCalledWith('group'); expect(open).not.toHaveBeenCalled();
  });

  it.each(['time', 'running', 'done', 'awaiting', 'error'])('preserves selection, expansion and existing attention for %s', (status) => {
    const item = row('latest', 2000); const group = { key: 'group' };
    for (const attention of [false, true]) for (const expanded of [false, true]) {
      const open = vi.fn(); const toggle = vi.fn(); const select = vi.fn();
      handler(group, item, attention, status, expanded, true, select, open, toggle, item)();
      expect(select).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled(); expect(toggle).not.toHaveBeenCalled();
      handler(group, item, attention, status, expanded, false, select, open, toggle, item)();
      expect(open).toHaveBeenCalledTimes(!expanded && (attention || status === 'error') ? 1 : 0);
      expect(toggle).toHaveBeenCalledTimes(expanded || (!attention && status !== 'error') ? 1 : 0);
    }
  });

  it('keeps the arrow independent from row navigation', () => {
    const arrow = source.slice(source.indexOf('event.stopPropagation();', start));
    expect(arrow).toMatch(/^event.stopPropagation\(\);\s+onToggleAutomationGroup\?\.\(group.key\);/);
  });
});
