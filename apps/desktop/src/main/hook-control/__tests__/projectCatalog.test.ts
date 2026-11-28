// IM 共用项目回归：一个已登记的本机伙伴有别名，但微信拿到的清单漏掉了它。
// projectWorkspaces 的用例从现成列表开始，覆盖不到读取源。unit，只替换宿主存储。
import { expect, it, vi } from 'vitest';
import { companionHomes } from '../../companion-cloud/homes.js';
import { loadImProjectCatalog } from '../projectCatalog.js';

const f = vi.hoisted(() => {
  const root = process.platform === 'win32' ? 'C:/profile/owners/current' : '/profile/owners/current';
  const path = (id: string) => root + '/bots/' + id + '/workspace';
  const registered = [path('local'), path('hidden'), '/work'];
  const client = { drizzle: { select: () => ({ from: () => ({
    orderBy: () => registered.map(path => ({ path, lastUsedAt: 1 })),
  }) }) } };
  return { client, path };
});
vi.mock('../../localDb/client/current.js', () => ({ tryGetDbClient: () => f.client }));
vi.mock('../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'current', ownerGeneration: 1 }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({
  listProjectAliases: () => [{ projectKey: 'local:' + f.path('local'), alias: 'Buddy 葫芦' }],
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({}));
vi.mock('../../mcp-integrations/createProject.js', () => ({}));
vi.mock('../../sidebarSettingsStore.js', () => ({
  loadSidebarSettingsSnapshot: () => ({ hiddenProjectKeys: ['local:' + f.path('hidden')] }),
}));

it('keeps a moved teammate’s registered project available under the same name', async () => {
  const listed = async () => (await loadImProjectCatalog())?.projects.map(({ name, path }) => [name, path]);
  const expected = [['Buddy 葫芦', f.path('local')], ['work', '/work']];
  expect(await listed()).toEqual(expected);
  companionHomes.setPersistedShadows(['local']);
  try {
    expect(await listed()).toEqual(expected);
  } finally {
    companionHomes.reset();
  }
});
