import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import { ghostInstallApprovalToken } from '../../../shared/ghost';

const harness = vi.hoisted(() => ({
  root: '',
  generation: 1,
  membershipKind: 'personal' as 'personal' | 'org',
  ghosts: [] as InstalledGhost[],
  ledger: null as { scope: string; organizationId: string | null; source?: string; installed?: boolean } | null,
  quit: null as (() => void | Promise<void>) | null,
  snapshot: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => harness.root } }));
vi.mock('../../lifecycle', () => ({
  onQuit: (_name: string, callback: () => void | Promise<void>) => { harness.quit = callback; },
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => `owner:${harness.generation}`,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner' }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(harness.root, ...parts),
}));
vi.mock('../../authManager', () => ({
  getAuthState: () => ({
    isAuthenticated: true,
    user: { id: 'member', membershipKind: harness.membershipKind },
  }),
  getActiveAuthRealm: () => 'global',
}));
vi.mock('../../cindy-brain/index', () => ({
  getGhostManager: () => ({ list: () => harness.ghosts, inspect: harness.inspect }),
}));
vi.mock('../../cindy-brain/exportGhostPackage', () => ({
  snapshotInstalledGhostPackage: harness.snapshot,
}));
vi.mock('../../plugin-market/ledger', () => ({
  PluginMarketLedger: class {
    installationForAuthorization() {
      return harness.ledger;
    }
  },
}));
const bytes = Buffer.from('fixed-package-bytes');
import * as prepared from '../prepared';
let testGeneration = 0;
beforeEach(async () => {
  vi.resetAllMocks();
  harness.generation = ++testGeneration * 1000;
  harness.membershipKind = 'personal';
  harness.ledger = null;
  harness.root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-contribution-prepare-test-'));
  harness.ghosts = [
    {
      manifest: {
        schemaVersion: 2,
        id: 'hello',
        name: 'Hello',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
      },
      namespace: null,
      publishingSource: { kind: 'local', source: 'manual' },
      namespaceState: 'confirmed',
      enabled: true,
      dir: path.join(harness.root, 'current'),
      approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    },
  ];
  harness.snapshot.mockResolvedValue({ status: 'prepared', bytes, contentSha256: 'fixed-content' });
  harness.inspect.mockResolvedValue({
    canonicalManifest: harness.ghosts[0].manifest,
    packageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
});
afterEach(async () => {
  await fsp.rm(harness.root, { recursive: true, force: true });
});
describe('current installation contribution preparation', () => {
  it.each(['manual', 'ai'] as const)('rejects trusted official public plugins before packaging (%s)', async source => {
    harness.ghosts[0].publishingSource = { kind: 'public-market', pluginId: 'official-plugin' };
    harness.ghosts[0].trust = { level: 'cindy-official', publisherSigned: true, publisherVerified: true, reviewed: true };
    harness.ledger = { scope: 'public', organizationId: null, source: 'market', installed: true };
    await expect(prepared.prepareInstalledContribution('hello', source)).rejects.toThrow('OFFICIAL_PLUGIN_GITHUB_REQUIRED');
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.inspect).not.toHaveBeenCalled();
  });
  it.each(['personal', 'org'] as const)('prepares a local plugin for the %s member without inferring official identity from package text', async membershipKind => {
    harness.membershipKind = membershipKind;
    harness.ghosts[0].manifest.name = 'Cindy community tool';
    harness.ghosts[0].manifest.author = 'Cindy';
    expect(await prepared.prepareInstalledContribution('hello')).toMatchObject({ ghostId: 'hello' });
    expect(harness.snapshot).toHaveBeenCalled();
  });
  it.each(['git-market', 'local-market'])('rejects %s before reading package bytes', async source => {
    harness.ledger = { scope: 'public', organizationId: null, source, installed: true };
    await expect(prepared.prepareInstalledContribution('hello')).rejects.toThrow('Custom market installation');
    expect(harness.snapshot).not.toHaveBeenCalled();
  });
  it('refuses an unknown source rather than falling back to first publication', async () => {
    delete harness.ghosts[0].publishingSource;
    await expect(prepared.prepareInstalledContribution('hello')).rejects.toThrow('source could not be verified');
    expect(harness.snapshot).not.toHaveBeenCalled();
  });
  it('rejects a same-ID installation that differs from the clicked instance evidence before reading bytes', async () => {
    await expect(
      prepared.prepareInstalledContribution('hello', 'manual', {
        directory: path.join(harness.root, 'previous-account'),
        approvalToken: ghostInstallApprovalToken(harness.ghosts[0].approval),
      }),
    ).rejects.toThrow('Original installed plugin no longer matches');
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.inspect).not.toHaveBeenCalled();
  });
  it.each(['personal', 'organization'])('refuses %s ledger resources even for an organization member before creating a public snapshot', async scope => {
    harness.membershipKind = 'org';
    harness.ledger = { scope, organizationId: scope === 'organization' ? 'org' : null };
    await expect(prepared.prepareInstalledContribution('hello')).rejects.toThrow(
      'Private plugin resources',
    );
    expect(harness.snapshot).not.toHaveBeenCalled();
  });
  it('discards preparation if the account generation changes during inspect', async () => {
    harness.inspect.mockImplementationOnce(async () => {
      harness.generation++;
      return {
        canonicalManifest: harness.ghosts[0].manifest,
        packageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    });
    await expect(prepared.prepareInstalledContribution('hello')).rejects.toThrow('OWNER_CHANGED');
    expect(await fsp.readdir(harness.root)).toEqual([]);
  });
  it('pins the inspected bytes and refuses later approval changes before submission', async () => {
    const result = await prepared.prepareInstalledContribution('hello');
    const entry = prepared.getPreparedContribution(result.preparedId);
    expect(await fsp.readFile(entry.filePath)).toEqual(bytes);
    expect(result.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    harness.ghosts[0] = {
      ...harness.ghosts[0],
      approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' },
    };
    expect(() => prepared.assertPreparedInstallation(entry)).toThrow('Installed plugin changed');
    await prepared.releasePreparedContribution(result.preparedId);
  });
});


describe('publishing summary package binding', () => {
  it('keeps notes from the package and detects changed installed bytes before submission', async () => {
    harness.ghosts[0].manifest.releaseNotes = 'All changes since the last released version';
    const summary = await prepared.prepareInstalledContribution('hello');
    expect(summary.releaseNotes).toBe(harness.ghosts[0].manifest.releaseNotes);
    const entry = prepared.getPreparedContribution(summary.preparedId);
    await expect(prepared.assertPreparedContent(entry)).resolves.toBeUndefined();
    harness.snapshot.mockResolvedValueOnce({ status: 'prepared', bytes, contentSha256: 'changed-content' });
    await expect(prepared.assertPreparedContent(entry)).rejects.toThrow('CONTRIBUTION_PACKAGE_CHANGED');
  });
});


it('gives concurrent preview callers independent ownership', async () => {
  const [first, second] = await Promise.all([prepared.prepareInstalledContribution('hello'), prepared.prepareInstalledContribution('hello')]);
  expect(first.preparedId).not.toBe(second.preparedId);
  await prepared.releasePreparedContribution(first.preparedId);
  expect(prepared.getPreparedContribution(second.preparedId).summary).toEqual(second);
});

// unit，PR #6669：原有顺序上限用例漏掉最后一个名额被两个 prepare 同时读取的时序。
// 真实入口准备七份再并发两份，只能保留八份；失败目录须清理，释放后仍能正常准备。
it('keeps the preview limit when concurrent callers compete for the last slot', async () => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 7; i++) ids.push((await prepared.prepareInstalledContribution('hello')).preparedId);
    const attempts = await Promise.allSettled([
      prepared.prepareInstalledContribution('hello'),
      prepared.prepareInstalledContribution('hello'),
    ]);
    const failures: unknown[] = [];
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') ids.push(attempt.value.preparedId);
      else failures.push(attempt.reason);
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: expect.stringContaining('Too many prepared contributions') });
    expect(ids).toHaveLength(8);
    expect(await fsp.readdir(harness.root)).toHaveLength(8);
    await prepared.releasePreparedContribution(ids.pop()!);
    ids.push((await prepared.prepareInstalledContribution('hello')).preparedId);
    expect(await fsp.readdir(harness.root)).toHaveLength(8);
  } finally {
    await Promise.all(ids.map(id => prepared.releasePreparedContribution(id)));
  }
});

// unit：真实 prepare 生成文件后执行宿主退出回调；原 TTL 用例漏掉正常退出前不触发定时器的场景。
// 最小输入：一个预览和一个已接管快照；退出后两份包与内存条目均应释放。
it('releases both preview and operation-owned package bytes on normal quit', async () => {
  const first = await prepared.prepareInstalledContribution('hello');
  const second = await prepared.prepareInstalledContribution('hello');
  const entry = prepared.getPreparedContribution(second.preparedId);
  entry.pinned = true;
  expect(harness.quit).toBeTypeOf('function');
  await harness.quit!();
  expect(() => prepared.getPreparedContribution(first.preparedId)).toThrow('PRECONDITION_FAILED');
  expect(() => prepared.getPreparedContribution(second.preparedId)).toThrow('PRECONDITION_FAILED');
  expect(await fsp.readdir(harness.root)).toEqual([]);
});

it('keeps operation-owned packages without consuming the eight preview slots', async () => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const summary = await prepared.prepareInstalledContribution('hello');
      ids.push(summary.preparedId);
      prepared.getPreparedContribution(summary.preparedId).pinned = true;
    }
    for (let i = 0; i < 8; i++) ids.push((await prepared.prepareInstalledContribution('hello')).preparedId);
    await expect(prepared.prepareInstalledContribution('hello')).rejects.toThrow('Too many prepared contributions');
    await expect(fsp.access(prepared.getPreparedContribution(ids[0]).filePath)).resolves.toBeUndefined();
  } finally {
    await Promise.all(ids.map(id => prepared.releasePreparedContribution(id)));
  }
});
