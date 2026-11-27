import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOfflineInboxIntentStore } from '../offlineInboxIntentStore';

/**
 * 测试价值
 * - 生产入口与可观察结果：createOfflineInboxIntentStore 的落盘读写、按 (deviceId, sessionId) 覆盖、
 *   逐项撤销、按设备清理、登出清空及非法入参拒绝。
 * - Bug／规则依据：docs/dev-rules/engineering-conventions.md §3（main 侧业务逻辑默认带测试）与
 *   docs/dev-rules/credentials-and-local-storage.md（owner 作用域落盘与登出清理）。
 * - 现有覆盖缺口：新增 Main 侧持久化存储，无既有单测覆盖。
 * - 最小失败输入：传入非法 snoozedUntil 或空 deviceId 被写入盘；或登出 clearAll 后重启仍读出旧账号意图。
 * - tier：unit（node 环境 + 唯一 mkdtemp 临时目录，单文件 <1s）。
 */
describe('createOfflineInboxIntentStore', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-offline-inbox-'));
  });

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists, replaces by (deviceId, sessionId), removes, clears device, and clears all', async () => {
    const filePath = path.join(tmpDir, 'owner-a', 'offline-inbox-intents.json');
    const store = createOfflineInboxIntentStore(() => filePath);

    expect(await store.list()).toEqual([]);

    const snooze = {
      deviceId: 'dev-1',
      sessionId: 'sess-1',
      kind: 'snooze' as const,
      snoozedUntil: '2026-11-27T09:00:00.000Z',
      createdAt: '2026-11-26T10:00:00.000Z',
      basedOnActivityAt: '2026-11-26T09:50:00.000Z',
      basedOnUserSendAt: '2026-11-26T09:50:00.000Z',
      sessionTitle: 'Release notes',
    };
    await store.upsert(snooze);
    await store.upsert({
      deviceId: 'dev-2',
      sessionId: 'sess-2',
      kind: 'complete' as const,
      createdAt: '2026-11-26T10:01:00.000Z',
      basedOnActivityAt: '2026-11-26T09:00:00.000Z',
      basedOnUserSendAt: null,
    });

    // Replace existing (dev-1, sess-1) with complete
    const complete = {
      deviceId: 'dev-1',
      sessionId: 'sess-1',
      kind: 'complete' as const,
      createdAt: '2026-11-26T10:05:00.000Z',
      basedOnActivityAt: '2026-11-26T09:50:00.000Z',
      basedOnUserSendAt: '2026-11-26T09:50:00.000Z',
    };
    const afterReplace = await store.upsert(complete);
    expect(afterReplace).toHaveLength(2);
    expect(afterReplace.find((i) => i.sessionId === 'sess-1')?.kind).toBe('complete');

    // Fresh instance reads persisted state from disk
    const reopened = createOfflineInboxIntentStore(() => filePath);
    expect(await reopened.list()).toHaveLength(2);

    // Remove single entry
    const afterRemove = await reopened.remove('dev-1', 'sess-1');
    expect(afterRemove.map((i) => i.sessionId)).toEqual(['sess-2']);

    // Clear device
    const afterClearDevice = await reopened.clearDevice('dev-2');
    expect(afterClearDevice).toEqual([]);

    // Clear all removes persisted files cleanly
    await reopened.upsert(snooze);
    await reopened.clearAll();
    expect(await reopened.list()).toEqual([]);
  });

  it('rejects malformed payloads with INVALID_PARAMS', async () => {
    const filePath = path.join(tmpDir, 'owner-b', 'offline-inbox-intents.json');
    const store = createOfflineInboxIntentStore(() => filePath);

    await expect(
      store.upsert({ deviceId: '', sessionId: 'sess-1', kind: 'complete', createdAt: '2026-11-26T10:00:00.000Z' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      store.upsert({
        deviceId: 'dev-1',
        sessionId: 'sess-1',
        kind: 'snooze',
        snoozedUntil: 'bad-date',
        createdAt: '2026-11-26T10:00:00.000Z',
      }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(store.remove('', 'sess-1')).rejects.toThrow(/INVALID_PARAMS/);
    await expect(store.clearDevice('   ')).rejects.toThrow(/INVALID_PARAMS/);
  });
});
