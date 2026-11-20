import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import {
  __resetHelperSurfaceLedger,
  classifyHelperSurface,
  resolveHelperSurface,
  resolveHelperSurfaceForTools,
} from '../helperSurface.js';

describe('classifyHelperSurface', () => {
  it.each([
    ['bot', true],
    ['bot', false],
    [null, true],
    ['user', true],
  ] as const)('treats source=%s link=%s as a Bot', (source, hasBotLink) => {
    expect(classifyHelperSurface(source, hasBotLink)).toBe('bot');
  });

  it('gives only a local, active Bot main task the full gated surface', () => {
    const main = { role: 'canonical', status: 'active', remoteHostId: null };
    expect(classifyHelperSurface('bot', true, main)).toBe('bot-main');
    for (const [source, link, patch] of [
      ['bot', true, { role: 'group' }],
      ['bot', true, { role: 'history' }],
      ['bot', true, { role: null }],
      ['bot', true, { status: 'archived' }],
      ['bot', true, { remoteHostId: 'ssh-1' }],
      ['bot', false, {}],
      ['user', true, {}],
    ] as const) {
      expect(classifyHelperSurface(source, link, { ...main, ...patch })).toBe('bot');
    }
    expect(classifyHelperSurface('user', false, main)).toBe('default');
  });

  it('leaves ordinary tasks on the default surface', () => {
    expect(classifyHelperSurface('user', false)).toBe('default');
    expect(classifyHelperSurface(null, false)).toBe('default');
    expect(classifyHelperSurface(undefined, false)).toBe('default');
  });
});


describe('resolveHelperSurface', () => {
  const ordinary = { source: 'user', botId: null, botRole: null, status: 'active', remoteHostId: null, pluginOwned: 0, retainedPlugin: 0, isWorker: 0 };
  function db(row: typeof ordinary) {
    return { queryOne: vi.fn().mockResolvedValue(row) } as unknown as Pick<DbClient, 'queryOne'>;
  }
  it.each([0, 1])('gives plugin-owned tasks and their Workers the default surface (worker=%s)', async (isWorker) => {
    await expect(resolveHelperSurface(db({ ...ordinary, pluginOwned: 1, retainedPlugin: 1, isWorker }), 'session')).resolves.toBe('default');
  });
  it('uses the ordinary surface for a Worker even after its creating plugin loses control', async () => {
    await expect(resolveHelperSurface(db({ ...ordinary, retainedPlugin: 1, isWorker: 1 }), 'worker')).resolves.toBe('default');
  });
  it('does not exclude ordinary user Workers or automation', async () => {
    await expect(resolveHelperSurface(db({ ...ordinary, isWorker: 1 }), 'worker')).resolves.toBe('default');
    await expect(resolveHelperSurface(db(ordinary), 'scheduled')).resolves.toBe('default');
  });
});

describe('resolveHelperSurfaceForTools', () => {
  const ordinary = { source: 'user', botId: null, botRole: null, status: 'active', remoteHostId: null };

  beforeEach(() => {
    __resetHelperSurfaceLedger();
  });

  it('waits for the session row so a task created from another computer keeps its tools', async () => {
    // 远程控制新建会话:agent 先起、库里的会话行后写。首份工具清单正好落在这个
    // 窗口里 —— 修复前查不到行就判成 restricted，整轮少了 ask_user_question_async
    // 等工具(#11671)。
    let rows = 0;
    const db = {
      queryOne: vi.fn(async () => (rows++ < 3 ? null : ordinary)),
    } as unknown as Pick<DbClient, 'queryOne'>;
    const sleep = vi.fn(async () => {});

    await expect(resolveHelperSurfaceForTools(db, 'created-elsewhere', { sleep }))
      .resolves.toBe('default');
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('keeps the surface restricted when the row never shows up, and reports the reason once', async () => {
    const db = { queryOne: vi.fn().mockResolvedValue(null) } as unknown as Pick<DbClient, 'queryOne'>;
    const onRestricted = vi.fn();
    const sleep = vi.fn(async () => {});

    await expect(resolveHelperSurfaceForTools(db, 'missing', { sleep, onRestricted, waitMs: 100, pollMs: 50 }))
      .resolves.toBe('restricted');
    expect(onRestricted).toHaveBeenCalledExactlyOnceWith('row-missing');

    // 同一会话只等一次:之后的调用不该再白等一轮。
    await expect(resolveHelperSurfaceForTools(db, 'missing', { sleep, onRestricted, waitMs: 100, pollMs: 50 }))
      .resolves.toBe('restricted');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRestricted).toHaveBeenCalledTimes(1);
  });

  // Unit regression for PR #11819: the resolver must distinguish a failed read
  // from a missing row, including when the first successful read was empty.
  it.each([false, true])('reports a query failure once and stops retrying (initial miss: %s)', async (initialMiss) => {
    const queryOne = vi.fn().mockRejectedValue(new Error('db busy'));
    if (initialMiss) queryOne.mockResolvedValueOnce(undefined);
    const db = { queryOne } as unknown as Pick<DbClient, 'queryOne'>;
    const onRestricted = vi.fn();
    const sleep = vi.fn(async () => {});
    const options = { sleep, onRestricted, waitMs: 200, pollMs: 100 };

    await expect(resolveHelperSurfaceForTools(db, 'broken', options)).resolves.toBe('restricted');
    await expect(resolveHelperSurfaceForTools(db, 'broken', options)).resolves.toBe('restricted');
    expect(onRestricted).toHaveBeenCalledExactlyOnceWith('query-failed');
    expect(sleep).toHaveBeenCalledTimes(initialMiss ? 1 : 0);
  });

  it('resolves an existing row without waiting', async () => {
    const db = { queryOne: vi.fn().mockResolvedValue(ordinary) } as unknown as Pick<DbClient, 'queryOne'>;
    const sleep = vi.fn(async () => {});

    await expect(resolveHelperSurfaceForTools(db, 'ready', { sleep })).resolves.toBe('default');
    expect(sleep).not.toHaveBeenCalled();
  });
});
