import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/xdt-learn-profile-test/userData') },
}));
vi.mock('../../appSessionState', () => ({
  ownerScopedUserDataPath: (...parts: string[]) =>
    `/tmp/xdt-learn-profile-test/userData/owners/test-owner/${parts.join('/')}`,
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../maker-host/memory-settings-store', () => ({
  readMemorySettings: vi.fn(() => ({ maker: true, claudeCode: true, codex: true, pi: true })),
}));

import {
  collectUserProfile,
  formatProfileBlock,
  PROFILE_TOTAL_CHAR_BUDGET,
  type ProfileShard,
} from '../profile';
import { readMemorySettings } from '../../maker-host/memory-settings-store';

const TEST_ROOT = '/tmp/xdt-learn-profile-test';

const shard = (over: Partial<ProfileShard> = {}): ProfileShard => ({
  type: 'user',
  title: 'Chris 的偏好',
  body: '简洁高效,中文交流',
  sourceLabel: '',
  ...over,
});

beforeEach(async () => {
  await fs.promises.rm(TEST_ROOT, { recursive: true, force: true });
  vi.mocked(readMemorySettings).mockReturnValue({ maker: true, claudeCode: true, codex: true, pi: true });
});

describe('formatProfileBlock', () => {
  it('renders user shards without a project label, scoped shards with one', () => {
    const block = formatProfileBlock([
      shard(),
      shard({ type: 'feedback', title: 'PR 跟进', body: '要查 reviewThreads', sourceLabel: 'xdt-maker' }),
    ]);
    expect(block).toContain('--- Chris 的偏好 (user) ---');
    expect(block).toContain('--- PR 跟进 (feedback, project: xdt-maker) ---');
    expect(block).toContain('要查 reviewThreads');
  });

  it('returns empty string for no shards', () => {
    expect(formatProfileBlock([])).toBe('');
  });

  it('stops at the total char budget instead of overflowing', () => {
    const big = 'x'.repeat(1200);
    const many = Array.from({ length: 20 }, (_, i) => shard({ title: `t${i}`, body: big }));
    const block = formatProfileBlock(many);
    expect(block.length).toBeLessThanOrEqual(PROFILE_TOTAL_CHAR_BUDGET + 100);
  });

  it('redacts sensitive title and source label metadata', () => {
    const block = formatProfileBlock([
      shard({
        title: 'alice@example.com',
        sourceLabel: 'ops.internal',
      }),
    ]);
    expect(block).not.toContain('alice@example.com');
    expect(block).not.toContain('ops.internal');
    expect(block).toContain('[REDACTED:email]');
    expect(block).toContain('[REDACTED:internal-address]');
  });
});

describe('collectUserProfile', () => {
  it('returns empty when Maker Memory is disabled', async () => {
    vi.mocked(readMemorySettings).mockReturnValue({ maker: false, claudeCode: true, codex: true, pi: true });

    const profile = await collectUserProfile(null);

    expect(profile).toEqual({ block: '', used: false });
  });

  it('redacts shard frontmatter titles before building the prompt block', async () => {
    const dir = path.join(
      TEST_ROOT,
      'userData',
      'owners',
      'test-owner',
      'maker-memory',
      'workdir',
    );
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'user_contact.md'),
      '---\ntitle: "contact alice@example.com"\n---\nPrefers short replies.\n',
      'utf8',
    );

    const profile = await collectUserProfile(null);

    expect(profile.used).toBe(true);
    expect(profile.block).not.toContain('alice@example.com');
    expect(profile.block).toContain('[REDACTED:email]');
    expect(profile.block).toContain('Prefers short replies.');
  });
});
