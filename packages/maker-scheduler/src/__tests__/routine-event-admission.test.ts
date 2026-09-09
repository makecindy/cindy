import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { RoutineEventAdmission, ROUTINE_EVENT_LIMITS as limits, addRoutineReceipt, compactRoutineReceipts } from '../routine-event-admission.js';

it('enforces global frequency and pending limits across distinct authenticated sources', () => {
  const admission = new RoutineEventAdmission();
  const releases = Array.from({ length: limits.pendingGlobal }, (_, i) => admission.acquire(`source-${i}`, 1000));
  expect(() => admission.acquire('another', 1000)).toThrow('busy');
  releases.forEach((release) => release());
  for (let i = releases.length; i < limits.global; i++) admission.acquire(`source-${i}`, 1000)();
  expect(() => admission.acquire('another', 1000)).toThrow('rate limit');
  expect(() => admission.acquire('another', 1000 + limits.windowMs)()).not.toThrow();
});

it('migrates oversized legacy receipts by UTF-8 bytes, including source caps and TTL', () => {
  const now = limits.receiptTtlMs + 10000;
  const legacy: Record<string, number> = {};
  for (let source = 0; source < 12; source++) {
    for (let i = 0; i < 400; i++) legacy[JSON.stringify([`source-${source}`, `${'界'.repeat(250)}${i}`])] = now - i;
  }
  legacy[JSON.stringify(['expired', 'old'])] = now - limits.receiptTtlMs;
  const compact = compactRoutineReceipts(legacy, now);
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(limits.receiptBytesGlobal);
  expect(compact[JSON.stringify(['expired', 'old'])]).toBeUndefined();
  for (let source = 0; source < 12; source++) {
    const own = Object.fromEntries(Object.entries(compact).filter(([key]) => JSON.parse(key)[0] === `source-${source}`));
    expect(Buffer.byteLength(JSON.stringify(own))).toBeLessThanOrEqual(limits.receiptBytesPerSource);
  }
  expect(Object.keys(compact).length).toBeLessThan(Object.keys(legacy).length);
  expect(compact[JSON.stringify(['source-0', `${'界'.repeat(250)}0`])]).toBe(now);
});

it('rejects new receipts at capacity without evicting live deduplication, then admits after expiry', () => {
  const now = 1000;
  const receipts: Record<string, number> = {};
  let i = 0;
  const key = () => JSON.stringify(['source', `${'界'.repeat(250)}${i++}`]);
  try { while (true) addRoutineReceipt(receipts, 'source', key(), now); } catch (error) {
    expect(String(error)).toContain('storage is full');
  }
  const saved = JSON.stringify(receipts);
  expect(() => addRoutineReceipt(receipts, 'source', key(), now)).toThrow('storage is full');
  expect(JSON.stringify(receipts)).toBe(saved);
  addRoutineReceipt(receipts, 'another', JSON.stringify(['another', 'independent']), now);
  addRoutineReceipt(receipts, 'source', key(), now + limits.receiptTtlMs);
  expect(Object.keys(receipts)).toHaveLength(1);
});
