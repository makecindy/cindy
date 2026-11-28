import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '' }));

vi.mock('../../appSessionState.js', async () => {
  const nodePath = await import('node:path');
  return {
    ownerScopedUserDataPath: (...parts: string[]) => nodePath.join(h.root, ...parts),
    activeOwnerScopeKey: () => 'owner-a',
  };
});
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { info: () => {}, warn: () => {} },
}));

import {
  consumeSourceSwitch,
  matchesSourceSwitch,
  normalizeSourceSwitchFile,
  recordSourceSwitch,
  recordSourceSwitchBestEffort,
} from '../sourceSwitchStore.js';

const file = () => path.join(h.root, 'codex-source-switch.json');
const readFile = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as {
  switches: Record<string, { providerId: string }>;
};

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-switch-'));
});

afterEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe('codex source switch record', () => {
  // 用户换源后重启进程，下一次发送仍要能认出「这个任务换了来源」。
  it('keeps the accepted switch on disk until the handoff consumes it', async () => {
    await recordSourceSwitch('task-a', 'openai');
    expect(matchesSourceSwitch('task-a', 'openai')).toBe(true);
    expect(matchesSourceSwitch('task-a', 'openai-legacy')).toBe(false);
    expect(matchesSourceSwitch('task-b', 'openai')).toBe(false);
    // 记录在文件里，不是进程内存：重启后由同一条读取路径拿回。
    expect(readFile().switches['task-a']?.providerId).toBe('openai');

    await consumeSourceSwitch('task-a');
    expect(matchesSourceSwitch('task-a', 'openai')).toBe(false);
    // 没有记录时文件被清掉（或留空），两条读路径都只看得出「没有记录」。
    const remaining = fs.existsSync(file()) ? readFile().switches : {};
    expect(remaining).toEqual({});
  });

  it('replaces the previous record when the user picks again', async () => {
    await recordSourceSwitch('task-a', 'openai');
    await recordSourceSwitch('task-a', 'openai-legacy');
    expect(matchesSourceSwitch('task-a', 'openai-legacy')).toBe(true);
    expect(matchesSourceSwitch('task-a', 'openai')).toBe(false);
  });

  it('rejects identifiers the file could not safely hold', async () => {
    await recordSourceSwitch('bad id', 'openai');
    await recordSourceSwitch('task-a', 'bad provider');
    await recordSourceSwitch('task-a', null);
    expect(matchesSourceSwitch('task-a', null)).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('never throws on a damaged or unreadable record', async () => {
    fs.writeFileSync(file(), '{ not json');
    expect(matchesSourceSwitch('task-a', 'openai')).toBe(false);
    await recordSourceSwitch('task-a', 'openai');
    expect(matchesSourceSwitch('task-a', 'openai')).toBe(true);
  });

  // 写入失败只记日志：已提交的换源不能被一条记录文件判成失败。
  it('keeps a committed selection when the record cannot be written', async () => {
    fs.mkdirSync(file());
    await expect(recordSourceSwitchBestEffort('task-a', 'openai')).resolves.toBeUndefined();
    expect(matchesSourceSwitch('task-a', 'openai')).toBe(false);
  });

  it('drops expired entries and bounds the record', () => {
    const now = Date.now();
    const expired = now - 31 * 24 * 60 * 60 * 1000;
    const normalized = normalizeSourceSwitchFile({
      switches: {
        'fresh-task': { providerId: 'openai', atMs: now },
        'old-task': { providerId: 'openai', atMs: expired },
        'bad-provider': { providerId: 'open ai', atMs: now },
      },
    });
    expect(Object.keys(normalized.switches)).toEqual(['fresh-task']);
  });
});
