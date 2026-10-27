import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { classifyHelperSurface, resolveHelperSurface } from '../helperSurface.js';

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


describe('personal author tools reuse the helper surface', () => {
  const ordinary = { source: 'user', botId: null, botRole: null, status: 'active', remoteHostId: null, pluginOwned: 0, retainedPlugin: 0, isWorker: 0 };
  function db(row: typeof ordinary) {
    return { queryOne: vi.fn().mockResolvedValue(row) } as unknown as Pick<DbClient, 'queryOne' | 'drizzle'>;
  }
  it.each([0, 1])('restricts plugin-owned tasks and their Workers (worker=%s)', async (isWorker) => {
    await expect(resolveHelperSurface(db({ ...ordinary, pluginOwned: 1, retainedPlugin: 1, isWorker }), 'session', () => ({ executing: true, input: { clientId: 'plugin-task:request', originKind: 'plugin' } }))).resolves.toBe('restricted');
  });
  it('keeps revoked-but-still-executing plugin input restricted', async () => {
    await expect(resolveHelperSurface(db({ ...ordinary, retainedPlugin: 1, isWorker: 1 }), 'worker', () => ({ executing: true, input: { clientId: 'plugin-task:request', originKind: 'orca' } }))).resolves.toBe('restricted');
  });
  it('does not exclude ordinary user Workers or automation', async () => {
    await expect(resolveHelperSurface(db({ ...ordinary, isWorker: 1 }), 'worker', () => ({ executing: true, input: { clientId: 'orca-input', originKind: 'orca' } }))).resolves.toBe('default');
    await expect(resolveHelperSurface(db(ordinary), 'scheduled', () => ({ executing: true, input: { clientId: 'automation-input', autoResume: true } }))).resolves.toBe('default');
  });
});
