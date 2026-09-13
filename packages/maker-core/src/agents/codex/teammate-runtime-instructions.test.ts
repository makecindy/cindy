import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hasCurrentTeammateInstructions, teammateRuntimeInstructionItem } from './teammate-runtime-instructions';
let root: string;
let file: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'teammate-runtime-context-')); file = join(root, 'rollout.jsonl'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const entry = (text: string) => JSON.stringify({ type: 'response_item', payload: teammateRuntimeInstructionItem(text).item }) + '\n';
it('requires delivery for an old thread whose historical prompt has no baseline', async () => {
  await writeFile(file, JSON.stringify({ type: 'response_item', payload: { role: 'developer', content: [{ text: 'OLD PERSONA ONLY' }] } }) + '\n');
  expect(await hasCurrentTeammateInstructions(file, teammateRuntimeInstructionItem('CURRENT BASELINE').marker)).toBe(false);
});
it('deduplicates the same generation but refreshes changed instructions', async () => {
  await writeFile(file, entry('BASELINE A'));
  expect(await hasCurrentTeammateInstructions(file, teammateRuntimeInstructionItem('BASELINE A').marker)).toBe(true);
  expect(await hasCurrentTeammateInstructions(file, teammateRuntimeInstructionItem('BASELINE B').marker)).toBe(false);
  await writeFile(file, entry('BASELINE A') + entry('BASELINE B'));
  expect(await hasCurrentTeammateInstructions(file, teammateRuntimeInstructionItem('BASELINE A').marker)).toBe(false);
});
it('does not trust a user or tool echo as a delivery receipt', async () => {
  const item = teammateRuntimeInstructionItem('BASELINE').item;
  await writeFile(file, JSON.stringify({ type: 'response_item', payload: { ...item, role: 'user' } }) + '\n');
  expect(await hasCurrentTeammateInstructions(file, teammateRuntimeInstructionItem('BASELINE').marker)).toBe(false);
});
it('re-delivers when the proof is absent, compacted or outside the bounded tail', async () => {
  const marker = teammateRuntimeInstructionItem('BASELINE').marker;
  expect(await hasCurrentTeammateInstructions(undefined, marker)).toBe(false);
  expect(await hasCurrentTeammateInstructions(file, marker)).toBe(false);
  await writeFile(file, entry('BASELINE') + JSON.stringify({ type: 'compacted', payload: { message: 'x'.repeat(300000) } }) + '\n');
  expect(await hasCurrentTeammateInstructions(file, marker)).toBe(false);
});

it('does not accept a delivery marker from before a compaction boundary', async () => {
  const marker = teammateRuntimeInstructionItem('BASELINE').marker;
  await writeFile(file, entry('BASELINE') + JSON.stringify({ type: 'compacted', payload: { message: 'brief summary' } }) + '\n');
  expect(await hasCurrentTeammateInstructions(file, marker)).toBe(false);
  await writeFile(file, JSON.stringify({ type: 'compacted', payload: { message: 'brief summary' } }) + '\n' + entry('BASELINE'));
  expect(await hasCurrentTeammateInstructions(file, marker)).toBe(true);
});

it('reads remote history again after reconnect, while respecting updates and compaction', async () => {
  let history = entry('BASELINE A');
  const readFileTail = vi.fn(async () => history);
  const marker = teammateRuntimeInstructionItem('BASELINE A').marker;
  expect(await hasCurrentTeammateInstructions('/remote/rollout.jsonl', marker, { readFileTail })).toBe(true);
  expect(await hasCurrentTeammateInstructions('/remote/rollout.jsonl', marker, { readFileTail })).toBe(true);
  expect(readFileTail).toHaveBeenCalledWith('/remote/rollout.jsonl', 256 * 1024);
  history += entry('BASELINE B');
  expect(await hasCurrentTeammateInstructions('/remote/rollout.jsonl', marker, { readFileTail })).toBe(false);
  history += JSON.stringify({ type: 'compacted' }) + '\n';
  expect(await hasCurrentTeammateInstructions('/remote/rollout.jsonl', teammateRuntimeInstructionItem('BASELINE B').marker, { readFileTail })).toBe(false);
});
it('never uses local history for a missing, incompatible or failed remote reader', async () => {
  await writeFile(file, entry('BASELINE'));
  const marker = teammateRuntimeInstructionItem('BASELINE').marker;
  expect(await hasCurrentTeammateInstructions(file, marker, {})).toBe(false);
  expect(await hasCurrentTeammateInstructions(file, marker, { readFileTail: async () => { throw new Error('SSH disconnected'); } })).toBe(false);
});
