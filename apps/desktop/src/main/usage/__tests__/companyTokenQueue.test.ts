import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanyTokenQueue, projectUsage } from '../companyTokenQueue';
const files: string[] = [];
afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const policy = { owner: 'example-member', orgRevision: 1, memberRevision: 2 };
const counts = { input: 11, output: 2, cacheRead: 1, cacheWrite: 3 };
const models = new Set(['gpt-5']);
const day = '2026-11-18';
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'company-token-test-'));
  files.push(dir);
  const file = path.join(dir, 'queue');
  return { file, queue: new CompanyTokenQueue(file) };
}
it('projects only catalog models and four nonnegative counters before storage', () => {
  const privateData = { ...counts, sessionId: 'sensitive', costUsd: 5, prompt: 'private' };
  expect(projectUsage(models, day, 'private model', privateData)).toBeNull();
  expect(projectUsage(models, day, 'gpt-5', { ...counts, input: -1 })).toBeNull();
  const row = projectUsage(models, day, 'gpt-5', privateData)!;
  expect(row).toEqual({ model: 'gpt-5', day, ...counts });
  const { file, queue } = fixture();
  queue.add(policy, row);
  expect(readFileSync(file, 'utf8')).not.toMatch(/sessionId|sensitive|prompt|private|costUsd/);
});
it('replays an immutable batch after losing its receipt and preserves later deltas', () => {
  const { file, queue } = fixture();
  const row = projectUsage(models, day, 'gpt-5', counts)!;
  queue.add(policy, row);
  queue.add(policy, row);
  expect(queue.next(policy, '2026-11-17')).toBeNull();
  const first = queue.next(policy, day)!;
  expect(first.rows[0].input).toBe(22);
  const restarted = new CompanyTokenQueue(file);
  restarted.add(policy, row);
  expect(restarted.next(policy, day)).toEqual(first);
  restarted.acknowledge(policy, first.batchId);
  const next = restarted.next(policy, day)!;
  expect(next.rows).toEqual([row]);
  expect(next.batchId).not.toBe(first.batchId);
  restarted.acknowledge(policy, next.batchId);
  expect(existsSync(file)).toBe(false);
});
it('discards a sealed batch on a member or company policy revision change', () => {
  const { queue } = fixture();
  queue.add(policy, projectUsage(models, day, 'gpt-5', counts)!);
  expect(queue.next(policy, day)).not.toBeNull();
  expect(queue.next({ ...policy, memberRevision: 3 }, day)).toBeNull();
});
