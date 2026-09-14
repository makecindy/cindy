/**
 * messagePersistBroadcasterToolResultCap.test.ts
 * ---------------------------------------------------------------------------
 * tool_result 落库 8KB 截断(chat-data perf):
 *   - DB 只落有界内容(create / eager / orphan / 增长 update / full 覆盖全部入口);
 *   - 返回给 renderer 的 resolvedContent 仍是全文(在途显示不受影响);
 *   - 截断前对原文扫媒体 URL 挂账(被截掉的尾部可能含首次出现的 blob URL);
 *   - 截断后内容不变的重复增长不再重复 UPDATE。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../localDb/ipc/messages.js', () => ({
  broadcastMessageAgentMetaUpdate: vi.fn(async () => true),
  broadcastMessageRow: vi.fn(),
  createMessage: vi.fn(async () => ({}) as unknown),
  findVisibleToolUseMessageByAliases: vi.fn(async () => null),
  patchMessageAgentMetaWithResult: vi.fn(async () => ({ previous: {}, next: {} })),
  updateMessageContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('../localDb/subagentRuns.js', () => ({
  getSubagentRunDetail: vi.fn(async () => null),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../cindy-media/chatAttachments.js', () => ({
  commitMessageMediaRefs: vi.fn(async () => null),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  isDataOwnerBroadcastScopeCurrent: vi.fn(() => true),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));

import { createMessage, updateMessageContent } from '../localDb/ipc/messages.js';
import { commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import {
  clearSessionPersistState,
  flushOrphanToolResults,
  onToolResultEvent,
  onToolResultFullEvent,
  onToolUseEvent,
} from '../messagePersistBroadcaster.js';
import {
  TOOL_RESULT_PERSIST_CONTENT_LIMIT,
  TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX,
} from '../../shared/toolResultPersistCap.js';

const SESSION = 'sess-cap';
const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 0));

type CreateBody = { role: string; content: unknown; clientId: string };

function createdToolResultBodies(): CreateBody[] {
  return vi
    .mocked(createMessage)
    .mock.calls.map(([, body]) => body as CreateBody)
    .filter((body) => body.role === 'tool_result');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionPersistState(SESSION);
});

describe('tool_result persistence cap', () => {
  it('persists an under-cap result verbatim without a pre-truncation media scan', async () => {
    onToolUseEvent(SESSION, { toolUseId: 't0', toolName: 'Bash', input: {} }, null);
    const r = onToolResultEvent(SESSION, { summary: 'small output', toolUseIds: ['t0'] }, null);
    expect(r?.content).toBe('small output');
    await flushWrites();

    expect(createdToolResultBodies()[0]?.content).toBe('small output');
    expect(commitMessageMediaRefs).not.toHaveBeenCalled();
  });

  it('caps an oversized summary on create while returning the full text for display', async () => {
    onToolUseEvent(SESSION, { toolUseId: 't1', toolName: 'Bash', input: {} }, null);
    const bigText = 'a'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);
    const r = onToolResultEvent(SESSION, { summary: bigText, toolUseIds: ['t1'] }, null);
    expect(r?.content).toBe(bigText);
    await flushWrites();

    const persisted = createdToolResultBodies()[0]?.content as string;
    expect(persisted.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(persisted.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(commitMessageMediaRefs).toHaveBeenCalledWith({
      sessionId: SESSION,
      role: 'tool_result',
      content: bigText,
    });
  });

  it('scans the full original text for media refs before truncating a full update', async () => {
    onToolUseEvent(SESSION, { toolUseId: 't2', toolName: 'Bash', input: {} }, null);
    onToolResultEvent(SESSION, { summary: 'short', toolUseIds: ['t2'] }, null);
    const url = 'cindy-media://blobs/0123456789abcdef.png';
    const fullText = `${'b'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT + 100)}${url}`;
    const r = onToolResultFullEvent(SESSION, { toolUseId: 't2', fullText }, null);
    expect(r?.content).toBe(fullText);
    await flushWrites();

    expect(updateMessageContent).toHaveBeenCalledTimes(1);
    const capped = vi.mocked(updateMessageContent).mock.calls[0][2] as string;
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capped).not.toContain(url);
    expect(commitMessageMediaRefs).toHaveBeenCalledWith({
      sessionId: SESSION,
      role: 'tool_result',
      content: fullText,
    });
  });

  it('skips redundant UPDATEs once growth happens entirely beyond the cap', async () => {
    onToolUseEvent(SESSION, { toolUseId: 't3', toolName: 'Bash', input: {} }, null);
    onToolResultEvent(SESSION, { summary: 'seed', toolUseIds: ['t3'] }, null);
    const base = 'c'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);
    onToolResultFullEvent(SESSION, { toolUseId: 't3', fullText: base }, null);
    const grown = onToolResultFullEvent(
      SESSION,
      { toolUseId: 't3', fullText: `${base} plus a tail far beyond the cap` },
      null,
    );
    await flushWrites();

    expect(grown?.content).toBe(`${base} plus a tail far beyond the cap`);
    expect(updateMessageContent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitMessageMediaRefs).mock.calls.length).toBe(2);
  });

  it('caps the eager-create path (full text arrives before any summary)', async () => {
    onToolUseEvent(SESSION, { toolUseId: 't4', toolName: 'Read', input: {} }, null);
    const fullText = 'd'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT + 500);
    const r = onToolResultFullEvent(SESSION, { toolUseId: 't4', fullText }, null);
    expect(r?.content).toBe(fullText);
    await flushWrites();

    const persisted = createdToolResultBodies()[0]?.content as string;
    expect(persisted.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(persisted.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('caps orphan flush of a buffered full text whose summary never arrived', async () => {
    const fullText = 'e'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT + 500);
    expect(onToolResultFullEvent(SESSION, { toolUseId: 'unknown-tu', fullText }, null)).toBeNull();
    flushOrphanToolResults(SESSION, null);
    await flushWrites();

    const persisted = createdToolResultBodies()[0]?.content as string;
    expect(persisted.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(persisted.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });
});
