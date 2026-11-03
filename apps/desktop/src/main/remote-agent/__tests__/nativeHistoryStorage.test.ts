import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeHistoryStorage } from '../nativeHistoryStorage';
import { nativeHistoryDigest, type NativeHistoryManifest } from '../nativeHistoryTransfer';

const mocks = vi.hoisted(() => ({ root: '', find: vi.fn(), dump: vi.fn(), importThread: vi.fn(), removeThread: vi.fn() }));
vi.mock('@cindy/maker-core', () => ({ findClaudeSessionJsonl: mocks.find, sanitizeClaudeProjectKey: () => '-target-project' }));
vi.mock('../../maker-orchestration/claudeTranscriptAnchors', () => ({ defaultClaudeConfigDirCandidates: () => [mocks.root] }));
vi.mock('../controller/projectFiles', () => ({ claudeConfigDir: () => mocks.root }));
vi.mock('../../maker-host/codex-thread-storage', () => ({ readCodexThreadStorageReadOnly: async () => undefined }));
vi.mock('../../maker-host/codex-local-sessions', () => ({ dumpCodexThreadStateRows: mocks.dump, importSharedCodexThread: mocks.importThread, removeSharedCodexThread: mocks.removeThread }));
const nativeId = '11111111-1111-4111-8111-111111111111';
beforeEach(async () => { vi.clearAllMocks(); mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-storage-test-')); });
afterEach(async () => { await fs.rm(mocks.root, { recursive: true, force: true }); });
async function fixture(kind: NativeHistoryManifest['kind'], content: string): Promise<{ file: string; manifest: NativeHistoryManifest }> {
  const file = path.join(mocks.root, 'source.jsonl');
  await fs.writeFile(file, content);
  return { file, manifest: { kind, nativeId, bytes: Buffer.byteLength(content), sha256: await nativeHistoryDigest(file) } };
}

it('restores Claude messages, compaction and tool output under a new native identity without changing the source', async () => {
  const rows = [
    { type: 'user', sessionId: nativeId, uuid: 'user-message', message: { content: 'Keep the exact original requirements' } },
    { type: 'system', sessionId: nativeId, subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } },
    { type: 'user', sessionId: nativeId, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ALL OUTPUT\n'.repeat(10000) }] } },
  ];
  const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const { file, manifest } = await fixture('claude-code', content);
  mocks.find.mockResolvedValue(file);
  const storage = nativeHistoryStorage(mocks.root);
  expect(await storage.locate('claude-code', nativeId)).toEqual({ file });
  const restored = await storage.restore(file, manifest, '/target/project', () => {});
  expect(restored).not.toBe(nativeId);
  const written = await fs.readFile(path.join(mocks.root, 'projects', '-target-project', `${restored}.jsonl`), 'utf8');
  expect(written.trim().split('\n').map(line => JSON.parse(line))).toEqual(rows.map(row => ({ ...row, sessionId: restored })));
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});

it('restores all Codex rollout records and rewrites the native state identity together', async () => {
  const content = JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: '/old/project' } }) + '\n'
    + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'full result'.repeat(2000) } }) + '\n'
    + JSON.stringify({ type: 'compacted', payload: { message: 'native summary', replacement_history: [] } }) + '\n';
  const { file, manifest } = await fixture('codex', content);
  manifest.state = { threads: [{ id: nativeId }], threadDynamicTools: [{ thread_id: nativeId, name: 'tool' }], threadSpawnEdges: [] };
  const target = path.join(mocks.root, 'codex', 'rollout.jsonl');
  mocks.importThread.mockImplementation(async input => { await input.writeRollout(target); return { rolloutPath: target, statePresent: true }; });
  const restored = await nativeHistoryStorage(mocks.root).restore(file, manifest, '/target/project', () => {});
  expect(restored).not.toBe(nativeId);
  expect(await fs.readFile(target, 'utf8')).toBe(content.replace(nativeId, restored));
  // Real app-server thread/resume rejects noncanonical names even when the state row exists.
  const filename = mocks.importThread.mock.calls[0][0].rolloutFilename;
  expect(filename).toMatch(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9-]{36}\.jsonl$/);
  expect(filename.endsWith(`-${restored}.jsonl`)).toBe(true);
  expect(mocks.importThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: restored, newCwd: '/target/project', stateRows: {
    threads: [{ id: restored }], threadDynamicTools: [{ thread_id: restored, name: 'tool' }], threadSpawnEdges: [],
  } }));
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});

it('relocates the Pi header while preserving history and refusing source paths outside its native home', async () => {
  const storage = nativeHistoryStorage(mocks.root);
  const content = '{"type":"session","id":"pi-original","cwd":"/source-only/project"}\n{"type":"compaction","summary":"kept"}\n';
  const { file, manifest } = await fixture('pi', content);
  await fs.mkdir(path.join(mocks.root, 'pi-agent-home'), { recursive: true });
  await expect(storage.locate('pi', file)).rejects.toThrow('NATIVE_HISTORY_INVALID_ID');
  const restored = await storage.restore(file, manifest, '/target/project', () => {});
  expect(await storage.locate('pi', restored)).toEqual({ file: await fs.realpath(restored) });
  const written = await fs.readFile(restored, 'utf8');
  const header = JSON.parse(written.split('\n')[0]);
  expect(header).toEqual({ type: 'session', id: expect.any(String), cwd: '/target/project' });
  expect(header.id).not.toBe('pi-original');
  expect(path.basename(restored)).toBe(`relocated-${header.id}.jsonl`);
  expect(written.slice(written.indexOf('\n'))).toBe(content.slice(content.indexOf('\n')));
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});


it('does not claim complete Codex restoration when the native state could not be installed', async () => {
  const { file, manifest } = await fixture('codex', '{"type":"session_meta"}\n');
  manifest.state = { threads: [{ id: nativeId }], threadDynamicTools: [], threadSpawnEdges: [] };
  const receipt = { rolloutPath: '/test/rollout', statePresent: false };
  mocks.importThread.mockResolvedValue(receipt);
  await expect(nativeHistoryStorage(mocks.root).restore(file, manifest, '/target', () => {})).rejects.toThrow('NATIVE_HISTORY_INCOMPLETE');
  expect(mocks.removeThread).toHaveBeenCalledWith(expect.any(String), receipt);
});
