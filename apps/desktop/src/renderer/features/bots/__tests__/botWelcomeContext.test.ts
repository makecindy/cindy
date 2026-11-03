import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { normalizeBotWelcomeContext } from '../../../../shared/botWelcomeContext';

const h = vi.hoisted(() => ({ projects: [] as unknown[], sessions: [] as unknown[], read: vi.fn(), ensure: vi.fn() }));
vi.mock('@/lib/recentWorkdirsStore', () => ({ recentWorkdirsStore: { get: () => h.projects, ensure: h.ensure } }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { getByFilter: (filter: string) => { h.read(); return filter === 'active' ? h.sessions : null; }, ensureByFilter: h.ensure } }));
import { readCachedBotWelcomeContext } from '../botWelcomeContext';

const now = Date.parse('2026-09-15T10:00:00Z');
const at = new Date(now - 1000).toISOString();
const session = (patch: Record<string, unknown> = {}) => ({ id: 's1', title: 'Build a puzzle game', source: 'desktop', status: 'active', workspaceKind: 'project', workingDir: '/work/game/.cindy-worktrees/test', userSendAt: at, ...patch });

beforeEach(() => {
  h.projects = [];
  h.sessions = [];
  h.read.mockReset();
  h.ensure.mockReset();
  setDataOwnerGeneration('owner-a');
});

describe('cached invitation background', () => {
  it('uses only warm metadata, collapses worktrees and keeps repeated automation from flooding the hints', () => {
    h.projects = [{ path: '/work/game', lastUsedAt: at, exists: true }];
    h.sessions = [session(), ...Array.from({ length: 25 }, (_, i) => session({ id: `auto-${i}`, source: 'scheduler', title: 'Daily issue triage' })), session({ id: 'auto-other', source: 'scheduler', title: 'Weekly release notes' })];
    expect(readCachedBotWelcomeContext(now)).toEqual({ projects: ['game'], tasks: ['Build a puzzle game'], automations: ['Daily issue triage', 'Weekly release notes'] });
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('falls back immediately for empty caches and uses task metadata when the project cache is empty', () => {
    expect(readCachedBotWelcomeContext(now)).toBeUndefined();
    h.sessions = [session({ workspaceKind: 'dialogue', workingDir: null })];
    expect(readCachedBotWelcomeContext(now)).toEqual({ projects: [], tasks: ['Build a puzzle game'], automations: [] });
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('excludes stale, deleted, Bot, child, draft and remote records', () => {
    h.projects = [{ path: '/gone', exists: false, lastUsedAt: at }];
    h.sessions = [
      session({ source: 'bot' }), session({ parentSessionId: 'parent' }), session({ orcaRole: 'worker' }),
      session({ status: 'deleted' }), session({ userSendAt: null }), session({ userSendAt: '2020-01-01' }),
      session({ remoteHostId: 'ssh-host' }), session({ deviceLinkDeviceId: 'other-device' }),
    ].map((row, i) => ({ ...row, id: String(i) }));
    expect(readCachedBotWelcomeContext(now)).toBeUndefined();
  });

  it('does not return a snapshot across an owner change or a failed cache read', () => {
    h.sessions = [session()];
    h.read.mockImplementationOnce(() => setDataOwnerGeneration('owner-b'));
    expect(readCachedBotWelcomeContext(now)).toBeUndefined();
    h.read.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(readCachedBotWelcomeContext(now)).toBeUndefined();
  });

  it('bounds and sanitizes the IPC shape without accepting arbitrary context fields', () => {
    expect(normalizeBotWelcomeContext(null)).toBeUndefined();
    expect(normalizeBotWelcomeContext({ projects: {}, tasks: [null, 123] })).toBeUndefined();
    const context = normalizeBotWelcomeContext({ projects: ['A', 'A', 'B', 'C', 'D'], tasks: ['hello\nworld', 'x'.repeat(1000)], automations: ['one', 'two', 'three'], instructions: 'not part of the contract' });
    expect(context).toEqual({ projects: ['A', 'B', 'C'], tasks: ['hello world', 'x'.repeat(120)], automations: ['one', 'two'] });
  });
});
