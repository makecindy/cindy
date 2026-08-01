import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir),
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  __testing,
  readAgentResourceSettings,
  writeAgentResourceSetting,
} from '../maker-host/agent-resource-settings-store';

describe('agent resource settings store', () => {
  it('defaults to unlimited concurrency (0)', () => {
    expect(__testing.normalize(undefined).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize({}).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize(null).maxConcurrentCommands).toBe(0);
  });

  it('preserves zero as the unlimited value', () => {
    expect(__testing.normalize({ maxConcurrentCommands: 0 }).maxConcurrentCommands).toBe(0);
  });

  it('floors and clamps the concurrency limit', () => {
    expect(__testing.normalize({ maxConcurrentCommands: 4.9 }).maxConcurrentCommands).toBe(4);
    expect(__testing.normalize({ maxConcurrentCommands: -3 }).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize({ maxConcurrentCommands: 9999 }).maxConcurrentCommands).toBe(64);
  });

  it('falls back to default on non-numeric values', () => {
    expect(__testing.normalize({ maxConcurrentCommands: '5' }).maxConcurrentCommands).toBe(0);
    expect(__testing.normalize({ maxConcurrentCommands: Number.NaN }).maxConcurrentCommands).toBe(0);
    expect(
      __testing.normalize({ maxConcurrentCommands: Number.POSITIVE_INFINITY }).maxConcurrentCommands,
    ).toBe(0);
  });

  it('defaults process priority to normal and only accepts known tiers', () => {
    expect(__testing.normalize({}).processPriority).toBe('normal');
    expect(__testing.normalize({ processPriority: 'low' }).processPriority).toBe('low');
    expect(__testing.normalize({ processPriority: 'lowest' }).processPriority).toBe('lowest');
    expect(__testing.normalize({ processPriority: 'turbo' }).processPriority).toBe('normal');
    expect(__testing.normalize({ processPriority: 19 }).processPriority).toBe('normal');
  });

  it('defaults toolchain thread cap to off and only accepts literal true', () => {
    expect(__testing.normalize({}).capToolchainThreads).toBe(false);
    expect(__testing.normalize({ capToolchainThreads: true }).capToolchainThreads).toBe(true);
    expect(__testing.normalize({ capToolchainThreads: 'yes' }).capToolchainThreads).toBe(false);
    expect(__testing.normalize({ capToolchainThreads: 1 }).capToolchainThreads).toBe(false);
  });

  it('does not clobber out-of-process file edits when writing another key', () => {
    // 隐藏配置约定:直接改文件也是正式入口。写路径必须先按 mtime 失效缓存,
    // 否则 writePatch 基于旧 overrides 计算,把手改的其它 key 静默覆盖回去。
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-resource-store-'));
    const file = path.join(electronMock.userDataDir, 'agent-resource-settings.json');
    try {
      writeAgentResourceSetting('maxConcurrentCommands', 5); // 建立缓存
      // 进程外手改:补一个 processPriority override,并保证 mtime 前进
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...onDisk, processPriority: 'low' }, null, 2));
      const bumped = new Date(Date.now() + 5_000);
      fs.utimesSync(file, bumped, bumped);

      writeAgentResourceSetting('capToolchainThreads', true);

      const finalOnDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      expect(finalOnDisk.processPriority).toBe('low'); // 手改不被覆盖
      expect(finalOnDisk.maxConcurrentCommands).toBe(5);
      expect(finalOnDisk.capToolchainThreads).toBe(true);
      expect(readAgentResourceSettings()).toEqual({
        maxConcurrentCommands: 5,
        processPriority: 'low',
        capToolchainThreads: true,
      });
    } finally {
      fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
      electronMock.userDataDir = '';
    }
  });
});
