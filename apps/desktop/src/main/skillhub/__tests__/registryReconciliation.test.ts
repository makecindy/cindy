import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-scan-maintenance-'));
vi.mock('electron', () => ({ app: { getPath: () => root } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../registry', () => ({ registryService: { getInstall: vi.fn(), removeInstall: vi.fn() } }));
import { registryService, type StoredInstall } from '../registry';
import { reconcileScannedInstall } from '../registryReconciliation';
import { acquireSharedSkillMutationLease } from '../sharedMutationLease';

afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(existing = true) {
  const skillName = randomUUID();
  const installPath = path.join(root, '.agents', 'skills', skillName);
  if (existing) fs.mkdirSync(installPath, { recursive: true });
  const entry = { version: '1.0.0', catalogScope: 'market' } as StoredInstall;
  vi.mocked(registryService.getInstall).mockResolvedValue(entry);
  vi.mocked(registryService.removeInstall).mockClear();
  return { record: { skillName, installPath, entry }, link: path.join(root, '.claude', 'skills', skillName) };
}

describe('background registry maintenance', () => {
  it('holds the mutation lease across async registry checks and the final Claude link write', async () => {
    const { record, link } = fixture();
    let checked!: () => void;
    const checking = new Promise<void>((resolve) => { checked = resolve; });
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    vi.mocked(registryService.getInstall).mockImplementationOnce(async () => {
      checked();
      await waiting;
      return record.entry;
    });
    const repair = reconcileScannedInstall(record, false);
    await checking;
    try { expect(await acquireSharedSkillMutationLease([record.skillName])).toBeNull(); }
    finally { resume(); await repair; }
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(record.installPath));
    const next = await acquireSharedSkillMutationLease([record.skillName]);
    expect(next).not.toBeNull();
    await next!();
  });

  it('cannot create a late link while an uninstall receipt is pending, including after restart', async () => {
    const { record, link } = fixture();
    const token = randomUUID();
    const lease = (await acquireSharedSkillMutationLease([record.skillName]))!;
    lease.retainUntilComplete(token);
    await lease();
    vi.resetModules();
    const restarted = await import('../registryReconciliation');
    await restarted.reconcileScannedInstall(record, false);
    expect(fs.existsSync(link)).toBe(false);
    const resumed = (await acquireSharedSkillMutationLease([record.skillName], token))!;
    fs.renameSync(record.installPath, `${record.installPath}-trashed`);
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    resumed.complete(token);
    await resumed();
    await restarted.reconcileScannedInstall(record, false);
    expect(() => fs.lstatSync(link)).toThrow();
  });

  it.each(['registry', 'source'] as const)('rejects a stale %s snapshot before creating a link', async (change) => {
    const { record, link } = fixture();
    vi.mocked(registryService.getInstall).mockImplementationOnce(async () => {
      if (change === 'registry') return { ...record.entry, version: '2.0.0' };
      fs.renameSync(record.installPath, `${record.installPath}-old`);
      fs.mkdirSync(record.installPath);
      return record.entry;
    });
    await reconcileScannedInstall(record, false);
    expect(fs.existsSync(link)).toBe(false);
  });

  it('preserves an unrelated existing Claude link', async () => {
    const { record, link } = fixture();
    const external = path.join(root, randomUUID());
    fs.mkdirSync(external);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    await reconcileScannedInstall(record, false);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(external));
  });

  it('does not remove an orphan record if its source is restored during the registry read', async () => {
    const { record } = fixture(false);
    vi.mocked(registryService.getInstall).mockImplementationOnce(async () => {
      fs.mkdirSync(record.installPath, { recursive: true });
      return record.entry;
    });
    await reconcileScannedInstall(record, true);
    expect(registryService.removeInstall).not.toHaveBeenCalled();
  });

  it('treats access failure as an unknown source, never an orphan', async () => {
    const { record } = fixture();
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    await reconcileScannedInstall(record, true);
    expect(registryService.removeInstall).not.toHaveBeenCalled();
  });
});
