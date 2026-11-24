// IM 共用项目回归：一个已登记的本机伙伴有别名，但微信拿到的清单漏掉了它。
// projectWorkspaces 的用例从现成列表开始，覆盖不到读取源。unit，只替换宿主存储。
import { expect, it, vi } from 'vitest';
import { companionHomes } from '../../companion-cloud/homes.js';
import { loadImProjectCatalog } from '../projectCatalog.js';

const f = vi.hoisted(() => {
  const root = '/profile/owners/current';
  const path = (id: string) => root + '/bots/' + id + '/workspace';
  const registered = [path('local'), path('away'), path('deleted'), path('hidden'), '/work'];
  const client = { drizzle: { select: () => ({ from: () => ({
    orderBy: () => registered.map(path => ({ path, lastUsedAt: 1 })),
    where: () => ['local', 'away', 'hidden'].map(id => ({ id })),
  }) }) } };
  return { client, root, path };
});
vi.mock('../../localDb/client/current.js', () => ({ tryGetDbClient: () => f.client }));
vi.mock('../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'current', ownerGeneration: 1 }),
  ownerScopedUserDataPath: () => f.root, isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({
  listProjectAliases: () => [{ projectKey: 'local:' + f.path('local'), alias: 'Buddy 葫芦' }],
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({}));
vi.mock('../../mcp-integrations/createProject.js', () => ({}));
vi.mock('../../sidebarSettingsStore.js', () => ({
  loadSidebarSettingsSnapshot: () => ({ hiddenProjectKeys: ['local:' + f.path('hidden')] }),
}));

it('offers the registered local buddy by its project name, excluding removed and demoted copies', async () => {
  companionHomes.setPersistedShadows(['away']);
  try {
    const catalog = await loadImProjectCatalog({ includeTeammateProjects: true });
    expect(catalog?.projects.map(project => [project.name, project.path])).toEqual([
      ['Buddy 葫芦', f.path('local')], ['work', '/work'],
    ]);
    expect((await loadImProjectCatalog())?.projects.map(project => project.path)).toEqual(['/work']);
  } finally {
    companionHomes.reset();
  }
});
