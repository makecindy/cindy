/**
 * Plugin engine model list kept across restarts (docs/plans/acp-plugin-bridge.md).
 *
 * 测试价值
 * - 生产入口与可观察结果：acp-host 在引擎报告模型时调用的 rememberPluginHarnessModels，与模型
 *   选择器经 pluginEnginesIpc 读取的 getCachedPluginHarnessModels；看清空内存(等同重启)后
 *   读到的列表与账号目录里的文件。
 * - 规则依据：设计「模型列表在任务启动后从配置项获得，按插件 Agent + 账号缓存，下次直接显示」；
 *   credentials-and-local-storage.md 的账号隔离、原子写入、损坏按空读取。
 * - 现有覆盖缺口：2026-11-18 实机重启开发版后 DSH 的模型列表消失(只缓存在内存)。
 * - 最小失败输入：报告过模型后清空内存读到空列表；另一个账号读到本账号的列表；损坏文件抛错。
 * - tier：unit(真实文件读写在临时目录，账号目录由替身给出)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '', owner: 'owner-a' }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', h.owner, ...parts),
}));

import * as cache from '../pluginEngineModelCache.js';
const KEY = '_ns__local__dsh-acp:dsh';
const offered = [
  { id: '["deepseek-official","deepseek-v4-flash"]', displayName: 'deepseek-v4-flash', contextWindow: 0, efforts: [] },
  { id: 'v4-pro', displayName: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding', group: 'DeepSeek' },
];

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-models-'));
  h.owner = 'owner-a';
  cache.resetPluginHarnessModelCacheForTests();
});
afterEach(() => fs.rmSync(h.root, { recursive: true, force: true }));

describe('plugin engine model list', () => {
  it('survives a restart, keeps only display fields and stays per account', () => {
    cache.rememberPluginHarnessModels(KEY, offered);
    const expected = [
      { id: '["deepseek-official","deepseek-v4-flash"]', displayName: 'deepseek-v4-flash' },
      { id: 'v4-pro', displayName: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding', group: 'DeepSeek' },
    ];
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual(expected);

    cache.resetPluginHarnessModelCacheForTests(); // a restart: nothing in memory
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual(expected);

    h.owner = 'owner-b';
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual([]);
    h.owner = 'owner-a';
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual(expected);
    expect(fs.existsSync(path.join(h.root, 'owners', 'owner-b', 'plugin-engine-models.json'))).toBe(false);
  });

  it('reads an unreadable file as empty and replaces it with the next report', () => {
    const file = path.join(h.root, 'owners', 'owner-a', 'plugin-engine-models.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual([]);
    cache.rememberPluginHarnessModels(KEY, offered.slice(1));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).harnesses[KEY]).toEqual([
      { id: 'v4-pro', displayName: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding', group: 'DeepSeek' },
    ]);
  });

  it('notifies only when an engine’s list actually changes', () => {
    const listener = vi.fn();
    cache.onPluginHarnessModelsChanged(listener);
    cache.rememberPluginHarnessModels(KEY, offered);
    cache.rememberPluginHarnessModels(KEY, offered);
    expect(listener).toHaveBeenCalledTimes(1);
    cache.rememberPluginHarnessModels(KEY, []);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual([]);
  });

  // 2026-11-19:思考深度只对当前选中的模型可知(其余标 effortsUnknown),换模型后不能把已知档位抹掉。
  it('keeps the levels last seen for a model while a report marks them unknown', () => {
    const flash = { id: 'flash', displayName: 'Flash' };
    const pro = { id: 'pro', displayName: 'Pro' };
    cache.rememberPluginHarnessModels(KEY, [
      { ...flash, efforts: ['high', 'low', 'max'] },
      { ...pro, efforts: [], effortsUnknown: true },
    ]);
    cache.rememberPluginHarnessModels(KEY, [
      { ...flash, efforts: [], effortsUnknown: true },
      { ...pro, efforts: ['low', 'high'] },
    ]);
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual([
      { ...flash, efforts: ['low', 'high', 'max'] },
      { ...pro, efforts: ['low', 'high'] },
    ]);
    // A report that knows the model has no levels clears them.
    cache.rememberPluginHarnessModels(KEY, [{ ...flash, efforts: [] }, { ...pro, efforts: [], effortsUnknown: true }]);
    expect(cache.getCachedPluginHarnessModels(KEY)).toEqual([flash, { ...pro, efforts: ['low', 'high'] }]);
  });
});
