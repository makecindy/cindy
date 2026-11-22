/**
 * plugin-engine-prefs-store — what the user set for a plugin engine in Settings → Model providers.
 *
 * 测试价值
 * - 生产入口与可观察结果：register.ts 注入给 pluginEnginesIpc 的 readPluginEnginePrefs / updatePluginEnginePrefs /
 *   onPluginEnginePrefsChanged；看写入后读到的值、账号目录里的文件与变更通知次数。写入通道与列表投影由
 *   maker-ipc/__tests__/pluginEnginesIpc.test.ts 覆盖，这里只看存储自己的边界。
 * - 规则依据：credentials-and-local-storage.md 的账号隔离与「损坏按默认读取」；plugin-security-and-authoring.md §5
 *   「用户什么都不做，插件照旧能用」(读不了的文件不能把引擎读成已停用)；engineering-conventions.md §8.2
 *   内容没变不写盘不通知。
 * - 现有覆盖缺口：新文件；pluginEnginesIpc.test 走的都是合法请求和同一个账号，覆盖不到坏文件、换账号与上限。
 * - 最小失败输入：另一个账号读到本账号的设置；手改成乱码或形状不对的文件让引擎读成已停用或抛错；
 *   重复写同样的值也通知(引擎列表会被重复推给窗口)；超过上限的模型被静默丢掉一部分。
 * - tier：unit(真实文件读写在临时目录，账号目录由替身给出)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-engine-prefs-test-'));
const host = vi.hoisted(() => ({ owner: 'first' }));

vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpDir, 'never-used-here') } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../ownerContext.js', () => ({
  ownerScopedPath: (name: string) => path.join(tmpDir, host.owner, name),
}));

import {
  __testing,
  onPluginEnginePrefsChanged,
  readPluginEnginePrefs,
  updatePluginEnginePrefs,
} from '../plugin-engine-prefs-store.js';

const KEY = 'dsh-plugin:dsh';
const prefsFile = () => path.join(tmpDir, host.owner, 'plugin-engine-prefs.json');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('plugin engine settings store', () => {
  it('keeps each account’s settings apart', async () => {
    host.owner = 'account-a';
    await updatePluginEnginePrefs(KEY, { name: 'Work DeepSeek', suspended: true });
    host.owner = 'account-b';
    expect(readPluginEnginePrefs(KEY)).toEqual({});
    await updatePluginEnginePrefs(KEY, { hidden: true });
    expect(readPluginEnginePrefs(KEY)).toEqual({ hidden: true });
    host.owner = 'account-a';
    expect(readPluginEnginePrefs(KEY)).toEqual({ name: 'Work DeepSeek', suspended: true });
  });

  it.each([
    ['not JSON', '{ engines: '],
    ['the wrong shape', JSON.stringify({ engines: ['dsh-plugin:dsh'] })],
    ['values that are not explicit choices', JSON.stringify({
      engines: {
        [KEY]: { name: 7, hidden: 'yes', suspended: 1, disabledModels: 'all' },
        'no-harness-id': { suspended: true },
      },
    })],
  ])('reads a file that is %s as no settings, never as a turned-off engine', (label, content) => {
    host.owner = `damaged-${label.length}`;
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), content);
    expect(readPluginEnginePrefs(KEY)).toEqual({});
    expect(readPluginEnginePrefs('no-harness-id')).toEqual({});
  });

  it('keeps only well-formed entries of a hand-edited file', () => {
    expect(__testing.normalize({
      engines: {
        [KEY]: { name: '  Work  ', hidden: true, suspended: false, disabledModels: ['a', 'a', '', 3, 'b'], extra: 1 },
        'other-plugin:engine': { name: 'x'.repeat(65) },
      },
    })).toEqual({ engines: { [KEY]: { name: 'Work', hidden: true, disabledModels: ['a', 'b'] } } });
  });

  it('writes and notifies only when a setting actually changes', async () => {
    host.owner = 'notify';
    const changes: number[] = [];
    const off = onPluginEnginePrefsChanged(() => changes.push(changes.length));
    await updatePluginEnginePrefs(KEY, { hidden: true });
    const written = fs.statSync(prefsFile(), { bigint: true }).mtimeNs;
    await updatePluginEnginePrefs(KEY, { hidden: true });
    await updatePluginEnginePrefs(KEY, { suspended: false });
    await updatePluginEnginePrefs(KEY, { models: { ids: ['m1'], disabled: false } });
    expect(changes).toHaveLength(1);
    expect(fs.statSync(prefsFile(), { bigint: true }).mtimeNs).toBe(written);
    off();
    await updatePluginEnginePrefs(KEY, { hidden: false });
    expect(changes).toHaveLength(1);
    expect(fs.existsSync(prefsFile())).toBe(false);
  });

  it('refuses what it could not keep in full instead of dropping part of it', async () => {
    host.owner = 'bounds';
    const models = Array.from({ length: 200 }, (_, index) => `model-${index}`);
    await updatePluginEnginePrefs(KEY, { models: { ids: models, disabled: true } });
    await expect(updatePluginEnginePrefs(KEY, { models: { ids: ['one-more'], disabled: true } })).rejects.toThrow('Too many');
    await expect(updatePluginEnginePrefs(KEY, { name: 'x'.repeat(65) })).rejects.toThrow('Invalid plugin engine name');
    await expect(updatePluginEnginePrefs('no-harness-id', { hidden: true })).rejects.toThrow('Unknown plugin engine');
    expect(readPluginEnginePrefs(KEY).disabledModels).toEqual(models);
    // Turning some back on makes room again.
    await updatePluginEnginePrefs(KEY, { models: { ids: ['model-0'], disabled: false } });
    await updatePluginEnginePrefs(KEY, { models: { ids: ['one-more'], disabled: true } });
    expect(readPluginEnginePrefs(KEY).disabledModels).toHaveLength(200);
  });
});
