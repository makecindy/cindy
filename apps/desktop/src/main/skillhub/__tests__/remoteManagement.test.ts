import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSkillsManagement, type RemoteSkillRecord } from '../remoteManagement';
import type { RemoteActionInvokeRequest } from '@cindy/device-link';
import type { RemoteSkillReceipt } from '../../../shared/remoteSkills';

const entry = (id = 'global-instance', revision = 'r1'): RemoteSkillRecord<string> => ({
  target: id,
  view: {
    id,
    revision,
    name: 'same-name',
    description: 'fixture',
    kind: 'skill',
    scope: 'global',
    engines: ['Codex'],
    enabled: true,
    managedByPlugin: false,
    builtIn: false,
    canUninstall: true,
    version: '1.0.0',
    market: { name: 'same-name', catalogScope: 'market' },
  },
});
let records: ReturnType<typeof entry>[], live: boolean, visible: boolean;
const mutate = vi.fn(),
  scan = vi.fn(async () => records);
let management: RemoteSkillsManagement<string>;
const catalog = vi.fn(),
  readFile = vi.fn(),
  projects = vi.fn(),
  market = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  records = [entry(), entry('project-instance')];
  live = visible = true;
  management = new RemoteSkillsManagement({
    capture: () => ({ current: () => live, visible: () => visible }),
    scan,
    market: market.mockResolvedValue({ items: [], nextCursor: null }),
    catalog,
    readFile,
    projects: projects.mockResolvedValue([
      { id: 'target-project', revision: 'p1', name: 'Project B' },
    ]),
    latest: async (name, catalogScope) => ({
      name,
      catalogScope,
      displayName: name,
      description: '',
      version: '2.0.0',
    }),
    detail: async () => '# fixture',
    mutate,
  });
});
const invoke = async (
  action: string,
  input: Record<string, unknown> = {},
  id?: string,
  peer = 'control-a',
) =>
  (
    await management.provider().invoke!({ controllerDeviceId: peer }, {
      collectionId: 'skills',
      client: { protocolVersion: 1, primitives: [] },
      actionId: `management:${action}`,
      input,
      ...(id ? { resourceRef: { collectionId: 'skills', kind: 'skill', id } } : {}),
    } satisfies RemoteActionInvokeRequest)
  ).result as RemoteSkillReceipt;

describe('remote Skills reuse the Host instances and mutation services', () => {
  it('advertises the complete catalog and keeps installed scans independent of market availability', async () => {
    expect(management.provider().collection.actions).toEqual(
      expect.arrayContaining([{ id: 'management:catalog', label: 'Browse skill catalog' }]),
    );
    await expect(invoke('snapshot', { installedOnly: true })).resolves.toMatchObject({
      projects: [{ id: 'target-project', revision: 'p1' }],
      items: expect.any(Array),
    });
    expect(market).not.toHaveBeenCalled();
    await invoke('snapshot');
    expect(market).toHaveBeenCalledOnce();
  });
  it('fences catalog responses when the owning account/peer changes during a read', async () => {
    catalog.mockImplementation(async () => {
      live = false;
      return { success: true, items: [] };
    });
    await expect(invoke('catalog', { method: 'list', scope: 'team' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(catalog).toHaveBeenCalledWith({ method: 'list', scope: 'team' });
    catalog.mockClear();
    await expect(invoke('catalog')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(catalog).not.toHaveBeenCalled();
  });
  it('binds file browsing to the selected physical revision and rejects traversal before reading', async () => {
    readFile.mockResolvedValue({ success: true, content: '# Guide' });
    await expect(
      invoke(
        'read-file',
        { path: 'references/guide.md', expectedRevision: 'r1' },
        'project-instance',
      ),
    ).resolves.toMatchObject({ content: '# Guide' });
    expect(readFile).toHaveBeenCalledWith(records[1], 'references/guide.md', false);
    readFile.mockClear();
    for (const path of ['../guide.md', '/private/file', 'folder/../guide.md', 'C:\\private']) {
      await expect(
        invoke('read-file', { path, expectedRevision: 'r1' }, 'project-instance'),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    await expect(
      invoke('children', { path: '', expectedRevision: 'old' }, 'project-instance'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(readFile).not.toHaveBeenCalled();
  });
  it('installs only into the Host project selected before confirmation, and rechecks its identity', async () => {
    const receipt = await invoke('begin', {
      operationId: 'project-install',
      kind: 'install',
      name: 'same-name',
      catalogScope: 'team',
      version: '2.0.0',
      projectId: 'target-project',
      projectRevision: 'p1',
    });
    await invoke('answer', {
      operationId: receipt.operationId,
      requestId: receipt.confirmation!.requestId,
      accepted: true,
    });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(mutate.mock.calls[0][4]).toEqual({
      id: 'target-project',
      revision: 'p1',
      name: 'Project B',
    });
    mutate.mockClear();
    const pending = await invoke('begin', {
      operationId: 'changed-project',
      kind: 'install',
      name: 'same-name',
      catalogScope: 'team',
      version: '2.0.0',
      projectId: 'target-project',
      projectRevision: 'p1',
    });
    projects.mockResolvedValue([{ id: 'target-project', revision: 'p2', name: 'Project B' }]);
    await invoke('answer', {
      operationId: pending.operationId,
      requestId: pending.confirmation!.requestId,
      accepted: true,
    });
    await vi.waitFor(async () =>
      expect((await invoke('operation', { operationId: pending.operationId })).phase).toBe(
        'failed',
      ),
    );
    expect(mutate).not.toHaveBeenCalled();
    await expect(
      invoke('begin', {
        operationId: 'unknown-project',
        kind: 'install',
        name: 'same-name',
        catalogScope: 'team',
        version: '2.0.0',
        projectId: '/controller/project',
        projectRevision: 'p2',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('lists same-name instances independently and reads only the named revision', async () => {
    const snapshot = (await invoke('snapshot')) as unknown as { items: Array<{ id: string }> };
    expect(snapshot.items.map((i) => i.id)).toEqual(['global-instance', 'project-instance']);
    await expect(
      invoke('detail', { expectedRevision: 'old' }, 'global-instance'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      invoke('detail', { expectedRevision: 'r1' }, 'project-instance'),
    ).resolves.toMatchObject({ markdown: '# fixture', id: 'project-instance' });
  });
  it('changes only the selected physical target and preserves a queryable success receipt', async () => {
    await invoke(
      'begin',
      { operationId: 'toggle', kind: 'disable', expectedRevision: 'r1' },
      'project-instance',
    );
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(mutate.mock.calls[0][1].target).toBe('project-instance');
    expect((await invoke('operation', { operationId: 'toggle' })).phase).toBe('succeeded');
  });
  it('waits outside the installer for confirmation and binds it to the requesting controller', async () => {
    const receipt = await invoke(
      'begin',
      { operationId: 'remove', kind: 'uninstall', expectedRevision: 'r1' },
      'global-instance',
    );
    expect(receipt.phase).toBe('confirmation');
    expect(mutate).not.toHaveBeenCalled();
    await expect(
      invoke(
        'answer',
        { operationId: 'remove', requestId: receipt.confirmation!.requestId, accepted: true },
        undefined,
        'control-b',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await invoke('answer', {
      operationId: 'remove',
      requestId: receipt.confirmation!.requestId,
      accepted: true,
    });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
  });
  it('rejects a replaced instance after confirmation and never calls uninstall', async () => {
    const receipt = await invoke(
      'begin',
      { operationId: 'replace', kind: 'uninstall', expectedRevision: 'r1' },
      'global-instance',
    );
    records = [entry('global-instance', 'r2')];
    await invoke('answer', {
      operationId: 'replace',
      requestId: receipt.confirmation!.requestId,
      accepted: true,
    });
    await vi.waitFor(async () =>
      expect((await invoke('operation', { operationId: 'replace' })).phase).toBe('failed'),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
  it('queries committed results after disconnect but refuses approval from the stale peer epoch', async () => {
    const receipt = await invoke(
      'begin',
      { operationId: 'offline', kind: 'uninstall', expectedRevision: 'r1' },
      'global-instance',
    );
    live = false;
    await expect(
      invoke('answer', {
        operationId: 'offline',
        requestId: receipt.confirmation!.requestId,
        accepted: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await invoke('operation', { operationId: 'offline' })).phase).toBe('confirmation');
    visible = false;
    await expect(invoke('operation', { operationId: 'offline' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('does not replay a completed uninstall when the instance has gone', async () => {
    const input = { operationId: 'dedupe', kind: 'uninstall', expectedRevision: 'r1' };
    const receipt = await invoke('begin', input, 'global-instance');
    await invoke('answer', {
      operationId: 'dedupe',
      requestId: receipt.confirmation!.requestId,
      accepted: true,
    });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    records = [];
    expect((await invoke('begin', input, 'global-instance')).phase).toBe('succeeded');
    expect(mutate).toHaveBeenCalledOnce();
  });
  it('cancels confirmation without changing the original skill', async () => {
    const receipt = await invoke(
      'begin',
      { operationId: 'cancel', kind: 'update', expectedRevision: 'r1', version: '2.0.0' },
      'global-instance',
    );
    await invoke('answer', {
      operationId: 'cancel',
      requestId: receipt.confirmation!.requestId,
      accepted: false,
    });
    expect((await invoke('operation', { operationId: 'cancel' })).phase).toBe('cancelled');
    expect(mutate).not.toHaveBeenCalled();
  });
  it('allocates one receipt for overlapping requests with the same operation id', async () => {
    const input = { operationId: 'overlap', kind: 'uninstall', expectedRevision: 'r1' };
    const [first, second] = await Promise.all([
      invoke('begin', input, 'global-instance'),
      invoke('begin', input, 'global-instance'),
    ]);
    expect(first.confirmation!.requestId).toBe(second.confirmation!.requestId);
    await invoke('answer', {
      operationId: 'overlap',
      requestId: first.confirmation!.requestId,
      accepted: true,
    });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
  });
  it('refuses independent mutation of plugin-managed Skills and unknown release versions', async () => {
    records[0].view.managedByPlugin = true;
    await expect(
      invoke(
        'begin',
        { operationId: 'plugin', kind: 'disable', expectedRevision: 'r1' },
        'global-instance',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      invoke('begin', {
        operationId: 'install',
        kind: 'install',
        name: 'new-skill',
        catalogScope: 'team',
        version: 'old',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mutate).not.toHaveBeenCalled();
  });
});
