/**
 * Account env resolver: master keeps today's behaviour (no CLAUDE_CONFIG_DIR); an extra
 * account gets its own config dir, but only after its profile links are prepared.
 */
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ClaudeAccountEnvError, profileDirFor, resolveClaudeAccountEnv } from '../accountEnv.js';
import type { PrepareReport } from '../profileLinker.js';
import { MASTER_ACCOUNT_ID, type ClaudeAccount } from '../types.js';

const accountsRoot = path.resolve('/data/claude-accounts');
const masterDir = path.resolve('/home/me/.claude');
const master: ClaudeAccount = { id: MASTER_ACCOUNT_ID, kind: 'master', label: 'Master', createdAt: 1 };
const work: ClaudeAccount = { id: 'acct_work0001', kind: 'extra', label: 'Work', createdAt: 1 };

const okReport = (profileDir: string): PrepareReport => ({
  profileDir,
  masterDir,
  mode: 'linked',
  entries: [{ name: 'projects', kind: 'dir', status: 'ok' }],
  conflicts: [],
});

describe('profileDirFor', () => {
  it('maps a generated id to a dir under the accounts root', () => {
    expect(profileDirFor(accountsRoot, 'acct_work0001')).toBe(path.join(accountsRoot, 'acct_work0001'));
  });

  it.each(['master', '../x', 'acct_UPPER0001', 'acct_', ''])('rejects %j', (id) => {
    expect(() => profileDirFor(accountsRoot, id)).toThrow(ClaudeAccountEnvError);
  });
});

describe('resolveClaudeAccountEnv', () => {
  it('returns an empty env for the master and never prepares anything', async () => {
    const prepare = vi.fn();
    const result = await resolveClaudeAccountEnv({ account: master, accountsRoot, masterDir, prepare });
    expect(result).toEqual({ env: {}, accountId: MASTER_ACCOUNT_ID });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('prepares the profile and sets CLAUDE_CONFIG_DIR for an extra account', async () => {
    const prepare = vi.fn(async (o: { profileDir: string }) => okReport(o.profileDir));
    const result = await resolveClaudeAccountEnv({ account: work, accountsRoot, masterDir, prepare });
    const profileDir = path.join(accountsRoot, 'acct_work0001');
    expect(prepare).toHaveBeenCalledWith({ profileDir, masterDir, accountsRoot });
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: profileDir });
    expect(result.accountId).toBe('acct_work0001');
    expect(result.report?.mode).toBe('linked');
  });

  it('blocks the spawn instead of falling back to master when prepare fails', async () => {
    const prepare = vi.fn(async () => {
      throw new Error('EPERM: operation not permitted');
    });
    await expect(resolveClaudeAccountEnv({ account: work, accountsRoot, masterDir, prepare })).rejects.toMatchObject({
      name: 'ClaudeAccountEnvError',
      code: 'profile_unavailable',
      accountId: 'acct_work0001',
    });
  });

  it('rejects an account record whose kind and id disagree', async () => {
    const forged = { ...work, kind: 'master' as const };
    await expect(
      resolveClaudeAccountEnv({ account: forged, accountsRoot, masterDir, prepare: vi.fn() }),
    ).rejects.toMatchObject({ code: 'invalid_account' });
  });
});
