// 回归:执行模式默认(P1-D)+ 私人数据强制 local-only(P1-6)。
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/cindy-execmode-test'),
  },
}));

vi.mock('./logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'test-owner', generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join('/tmp/cindy-execmode-test', ...parts),
}));

const dir = '/tmp/cindy-execmode-test';
const file = path.join(dir, 'subagent-model-execution-settings.json');

async function freshStore() {
  vi.resetModules();
  return import('../subagent-model-execution-settings-store.js');
}

beforeEach(() => fs.mkdirSync(dir, { recursive: true }));
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe('subagent model execution settings', () => {
  it('defaults to development: free allow-listed executes, unlicensed paid denied', async () => {
    const { DEFAULT_EXECUTION_MODE, readSubagentModelExecutionSettings } = await freshStore();
    // P1-D:开发模式默认 development,不再默认 approved-paid。
    expect(DEFAULT_EXECUTION_MODE).toBe('development');
    const settings = await readSubagentModelExecutionSettings({ rootPath: dir });
    expect(settings.mode).toBe('development');
  });

  it('reads an explicit user-chosen mode from disk', async () => {
    const { readSubagentModelExecutionSettings } = await freshStore();
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'approved-paid' }));
    const settings = await readSubagentModelExecutionSettings({ rootPath: dir });
    expect(settings.mode).toBe('approved-paid');
  });

  it('normalizes an invalid mode back to development', async () => {
    const { readSubagentModelExecutionSettings } = await freshStore();
    fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'everything-allowed' }));
    const settings = await readSubagentModelExecutionSettings({ rootPath: dir });
    expect(settings.mode).toBe('development');
  });

  it('normalizes trusted LAN only when provider, endpoint and models are all explicit', async () => {
    const { readSubagentModelExecutionSettings } = await freshStore();
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      trustedLan: [
        { provider: 'omlx-studio', endpoint: 'http://192.168.50.4:8000/', models: ['Qwen'] },
        { provider: 'missing-models', endpoint: 'http://192.168.50.5:8000', models: [] },
        { provider: 'bad-endpoint', endpoint: 'not-a-url', models: ['Qwen'] },
        { provider: 'bad-scheme', endpoint: 'ftp://192.168.50.6:8000', models: ['Qwen'] },
      ],
    }));
    const settings = await readSubagentModelExecutionSettings({ rootPath: dir });
    expect(settings.trustedLan).toEqual([
      { provider: 'omlx-studio', endpoint: 'http://192.168.50.4:8000', models: ['Qwen'] },
    ]);
  });

  it('forces local-only for private-data sessions/projects', async () => {
    const { isSessionForcedLocalOnly, readSubagentModelExecutionSettings } = await freshStore();
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      mode: 'approved-paid',
      privateData: { sessionIds: ['sess-private'], projectRoots: ['/work/private'] },
    }));
    const settings = await readSubagentModelExecutionSettings({ rootPath: dir });
    expect(isSessionForcedLocalOnly(settings, {
      sessionId: 'sess-private', projectRoot: '/work/private/sub',
    })).toBe(true);
    expect(isSessionForcedLocalOnly(settings, {
      sessionId: 'sess-other', projectRoot: '/work/public',
    })).toBe(false);
  });
});
