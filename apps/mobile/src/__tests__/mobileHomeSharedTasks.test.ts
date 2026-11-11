import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { buildMobileHomePresentation, type MobileHomeSessionLike } from '@/session/mobileHome';
import { buildHomeScopeMenuItems, buildHomeScopePullDownActions } from '@/session/homeChromeMenus';
import { splitSharedHomeGroup } from '@/session/sharedHomeGroup';

const peer = sharedTaskHostPeer('shared', 'host');
function session(id: string, deviceId: string, name: string): MobileHomeSessionLike {
  return {
    id, title: name, status: 'active', workspaceKind: 'dialogue', workingDir: '',
    agentKind: 'cc', model: 'claude',
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    deviceLinkDeviceId: deviceId, deviceLinkDeviceName: name,
  };
}

describe('shared tasks in the mobile Home', () => {
  // #7237 / unit: real Home and native scope-menu projections; existing shared
  // filtering coverage had only one named computer, missing duplicate fallbacks.
  it('distinguishes two unnamed computer scopes while preserving selection IDs', () => {
    const home = buildMobileHomePresentation({ selectedDeviceId: 'host-b', devices: [
      { deviceId: 'host-b', name: 'host-b', canOpen: true },
      { deviceId: 'host-a', name: 'host-a', canOpen: true },
    ], sessions: [] });
    const scopes = home.deviceFilters.filter(item => item.deviceId !== null);
    expect(scopes.find(item => item.deviceId === 'host-a')?.label).toMatch(/ \(1\)$/);
    expect(scopes.find(item => item.deviceId === 'host-b')?.label).toMatch(/ \(2\)$/);
    expect(scopes.find(item => item.selected)?.deviceId).toBe('host-b');
    expect(buildHomeScopePullDownActions(scopes, 'All').map(item => item.title)).toEqual(scopes.map(item => item.label));
  });

  it.each([undefined, peer])('keeps shared rows but excludes task peers from device scopes (selection %s)', (selectedDeviceId) => {
    const home = buildMobileHomePresentation({
      selectedDeviceId,
      devices: [{ deviceId: 'desktop', name: 'My computer', canOpen: true }],
      sessions: [session('local', 'desktop', 'My computer'), session('joined', peer, 'Shared review')],
    });
    expect(home.selectedDeviceId).toBeNull();
    expect(home.chats.map(item => item.session.id).sort()).toEqual(['joined', 'local']);
    expect((home.chats.find(item => item.session.id === 'joined')?.session as MobileHomeSessionLike).deviceLinkDeviceId).toBe(peer);
    expect(home.deviceFilters.map(item => item.deviceId)).toEqual([null, 'desktop']);
    expect(buildHomeScopeMenuItems(home.deviceFilters, 'All').map(item => item.label)).toEqual(['✓ All', 'My computer']);
    expect(buildHomeScopePullDownActions(home.deviceFilters, 'All').map(item => item.title)).toEqual(['All', 'My computer']);
  });

  it('offers only All when the account has joined tasks but no browsable computer', () => {
    const home = buildMobileHomePresentation({ sessions: [session('joined', peer, 'Shared review')] });
    expect(home.chats).toHaveLength(1);
    expect(home.deviceFilters.map(item => item.deviceId)).toEqual([null]);
    expect(home.primaryDevice).toBeNull();
    expect(buildHomeScopeMenuItems(home.deviceFilters, 'All')).toHaveLength(1);
    expect(buildHomeScopePullDownActions(home.deviceFilters, 'All')).toHaveLength(1);
  });

  it('retains real device selection even when its ID resembles a shared peer prefix', () => {
    const deviceId = 'shared-task~real-device';
    const home = buildMobileHomePresentation({
      selectedDeviceId: deviceId,
      devices: [{ deviceId, name: 'My computer', canOpen: true }],
      sessions: [session('local', deviceId, 'My computer'), session('joined', peer, 'Shared review')],
    });
    expect(home.selectedDeviceId).toBe(deviceId);
    expect(home.chats.map(item => item.session.id)).toEqual(['local']);
    expect(home.deviceFilters.map(item => item.deviceId)).toEqual([null, deviceId]);
  });
});

describe('shared Home group', () => {
  const own = { sharedTaskId: 'mine', sessionId: 'owner-task', hostDeviceId: 'desktop', ownerAccountId: 'owner', title: 'My share', revision: 1, source: 'desktop' as string | null | undefined };
  const split = (sessions: MobileHomeSessionLike[], owned = [own], searchQuery = '', statusFilter: 'active' | 'archived' | 'all' = 'active', selectedDeviceId?: string) => {
    const home = buildMobileHomePresentation({ sessions, searchQuery, statusFilter, selectedDeviceId, devices: [
      { deviceId: 'desktop', name: 'Desktop', canOpen: true },
      { deviceId: 'other', name: 'Other', canOpen: true },
    ] });
    return splitSharedHomeGroup(home, owned, { sessions, searchQuery, statusFilter });
  };

  it('groups joined and owned tasks, retaining ordinary tasks without duplicates', () => {
    const result = split([session('joined', peer, 'Joined'), session('owner-task', 'desktop', 'My share'), session('normal', 'desktop', 'Normal')]);
    expect(result.rows.map(row => row.item?.session.id).sort()).toEqual(['joined', 'owner-task']);
    expect(result.rows.find(row => row.item?.session.id === 'joined')?.role).toBe('joined');
    expect(result.rows.find(row => row.item?.session.id === 'owner-task')?.role).toBe('owned');
    expect(result.home.chats.map(item => item.session.id)).toEqual(['normal']);
    expect((result.rows.find(row => row.item?.session.id === 'joined')?.item?.session as MobileHomeSessionLike).deviceLinkDeviceId).toBe(peer);
  });

  it('keeps source-confirmed owner tasks visible without a complete session mirror', () => {
    expect(split([]).rows).toEqual([{ key: 'shared:mine', role: 'owned', task: own }]);
    expect(split([], []).rows).toEqual([]);
  });

  it.each([undefined, 'cindy-make', 'cindy-make-merge'])('does not synthesize a share row with source %s', source => {
    expect(split([], [{ ...own, source }]).rows).toEqual([]);
    expect(split([], [{ ...own, source: null }]).rows).toHaveLength(1);
  });

  it('moves pinned and project shared tasks into the same group', () => {
    const result = split([
      { ...session('joined', peer, 'Joined'), pinnedAt: '2026-09-21T00:00:00.000Z' },
      { ...session('owner-task', 'desktop', 'My share'), workspaceKind: 'project', workingDir: '/repo' },
      { ...session('normal', 'desktop', 'Normal'), workspaceKind: 'project', workingDir: '/repo' },
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.home.pinned).toEqual([]);
    expect(result.home.projects[0].sessions.map(item => item.session.id)).toEqual(['normal']);
    expect(result.home.projects[0].sessionCount).toBe(1);
  });

  it('does not reintroduce hydrated owner tasks hidden by search or status', () => {
    const sessions = [session('owner-task', 'desktop', 'My share')];
    expect(split(sessions, [own], 'unmatched').rows).toEqual([]);
    expect(split(sessions, [own], '', 'archived').rows).toEqual([]);
  });

  it('applies search, device and archive filters to discovery-only rows', () => {
    expect(split([], [own], 'SHARE').rows).toHaveLength(1);
    expect(split([], [own], 'unmatched').rows).toEqual([]);
    expect(split([], [own], '', 'archived').rows).toEqual([]);
    expect(split([], [own], '', 'active', 'other').rows).toEqual([]);
    expect(split([], [own], '', 'active', 'desktop').rows).toHaveLength(1);
  });

  it('does not merge a same-ID task on a different host', () => {
    const result = split([session('owner-task', 'other', 'Unrelated')]);
    expect(result.rows).toEqual([{ key: 'shared:mine', role: 'owned', task: own }]);
    expect(result.home.chats[0].title).toBe('Unrelated');
  });

  it('returns a no-longer-shared owner task to the ordinary list', () => {
    const result = split([session('owner-task', 'desktop', 'My share')], []);
    expect(result.rows).toEqual([]);
    expect(result.home.chats).toHaveLength(1);
  });

  it('keeps a joined role when a different host owns a task with the same session ID', () => {
    const result = split([session('owner-task', peer, 'Joined elsewhere')]);
    expect(result.rows.map(row => row.role)).toEqual(['joined', 'owned']);
  });

  it.each(['owned', 'joined'] as const)('keeps a single-role %s group without an extra subgroup', (role) => {
    const result = role === 'owned'
      ? split([session('owner-task', 'desktop', 'Mine')])
      : split([session('joined', peer, 'Joined')], []);
    expect(result.rows.map(row => row.role)).toEqual([role]);
    expect(result.home.chats).toEqual([]);
  });
});

// Shared role identity and filtering run above through the production presentation.
// Check the production row's accessibility projection rather than crown/layout strings.
describe('shared role accessibility', () => {
  it.each(['owned', 'joined', undefined] as const)('announces ownership only for role %s', (sharedRole) => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8');
    const tree = ts.createSourceFile('HomeSurface.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'accessibilityTitle') initializer = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (!initializer) throw new Error('Missing production row accessibility title');
    const project = new Function('sharedRole', 'item', 't', 'return (' + initializer.getText(tree) + ');');
    expect(project(sharedRole, { title: 'Task' }, (key: string) => key)).toBe(sharedRole === 'owned' ? 'Task, sharedTask.roleHost' : 'Task');
  });
});
