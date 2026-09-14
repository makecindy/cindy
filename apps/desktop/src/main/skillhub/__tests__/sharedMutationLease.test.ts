import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-lease-'));
vi.mock('electron', () => ({ app: { getPath: (name: string) => {
  if (name !== 'appData') throw new Error('lease must not depend on profile-specific userData');
  return root;
} } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { acquireSharedSkillMutationLease, withSkillMutation } from '../sharedMutationLease';
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('shared Skill mutation lease', () => {
  it('borrows only the current call chain and keeps an unawaited child locked until it finishes', async () => {
    const lease = (await acquireSharedSkillMutationLease(['parent']))!;
    let finishChild!: () => void;
    const waiting = new Promise<void>((resolve) => { finishChild = resolve; });
    let child!: Promise<unknown>;
    await lease.run(async () => {
      expect(await withSkillMutation(['PARENT', 'extra'], async () => 'nested')).toBe('nested');
      child = withSkillMutation(['parent'], () => waiting);
    });
    expect(await withSkillMutation(['parent'], async () => 'independent')).toBeUndefined();
    let released = false;
    const releasing = lease().then(() => { released = true; });
    try {
      expect(await acquireSharedSkillMutationLease(['parent'])).toBeNull();
      expect(released).toBe(false);
    } finally {
      finishChild();
      await child;
      await releasing;
    }
    expect(await withSkillMutation(['parent'], async () => 'next')).toBe('next');
  });

  it('does not borrow an expired async context after its lease has been released', async () => {
    const lease = (await acquireSharedSkillMutationLease(['expired']))!;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    let delayed!: Promise<unknown>;
    await lease.run(async () => {
      delayed = waiting.then(() => withSkillMutation(['expired'], async () => 'stale'));
    });
    await lease();
    const successor = (await acquireSharedSkillMutationLease(['expired']))!;
    try {
      resume();
      expect(await delayed).toBeUndefined();
    } finally { await successor(); }
  });

  it('contains a damaged durable barrier to its own resource name', async () => {
    const token = randomUUID();
    const key = createHash('sha256').update('damaged-receipt').digest('hex');
    const file = path.join(root, 'Cindy', 'shared-skill-mutation-locks', 'pending', key, `${token}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{');
    try {
      expect(await acquireSharedSkillMutationLease(['damaged-receipt'])).toBeNull();
      const other = await acquireSharedSkillMutationLease(['healthy-receipt']);
      expect(other).not.toBeNull();
      await other!();
    } finally { fs.unlinkSync(file); }
  });

  it('retains a durable barrier after release and allows only its full receipt to resume', async () => {
    const token = randomUUID();
    const names = ['durable-source', 'durable-alias'];
    const lease = await acquireSharedSkillMutationLease(names);
    lease!.retainUntilComplete(token);
    await lease!();
    vi.resetModules();
    const restarted = (await import('../sharedMutationLease')).acquireSharedSkillMutationLease;
    expect(await restarted(['durable-alias'])).toBeNull();
    expect(await restarted(names, randomUUID())).toBeNull();
    expect(await restarted(['durable-alias'], token)).toBeNull();
    const resumed = await restarted(names, token);
    expect(resumed).not.toBeNull();
    try {
      resumed!.complete(token);
      // Releasing the barrier never releases an executing process's lease early.
      expect(await restarted(['durable-source'])).toBeNull();
    } finally { await resumed!(); }
    const next = await restarted(['durable-alias']);
    expect(next).not.toBeNull();
    await next!();
  });

  it('excludes independent callers through the shared lock file, preserving case-folded alias locks', async () => {
    const first = await acquireSharedSkillMutationLease(['source', 'Alias']);
    expect(first).not.toBeNull();
    try {
      // This layer has no in-process holder map: exclusion is the filesystem protocol.
      expect(await acquireSharedSkillMutationLease(['ALIAS'])).toBeNull();
      const other = await acquireSharedSkillMutationLease(['unrelated']);
      expect(other).not.toBeNull();
      await other!();
    } finally { await first!(); }
    const next = await acquireSharedSkillMutationLease(['alias', 'ALIAS']);
    expect(next).not.toBeNull();
    await first!(); // Late release must not remove the successor's file.
    try { expect(await acquireSharedSkillMutationLease(['alias'])).toBeNull(); }
    finally { await next!(); }
  });

  it('releases earlier names if a later name is busy', async () => {
    const held = await acquireSharedSkillMutationLease(['z-busy']);
    try {
      expect(await acquireSharedSkillMutationLease(['a-free', 'z-busy'])).toBeNull();
      const free = await acquireSharedSkillMutationLease(['a-free']);
      expect(free).not.toBeNull();
      await free!();
    } finally { await held!(); }
  });
});
