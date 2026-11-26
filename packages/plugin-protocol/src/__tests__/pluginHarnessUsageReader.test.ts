/*
 * 测试价值
 * - 生产入口与可观察结果：createPluginHarnessUsageReader 的 read / retainReportingEngines（桌面
 *   hooks/pluginEngineUsage.ts 与手机 session/pluginEngines.ts 共用）；看引擎列表刷新后，正在进行的读取
 *   是否仍交回用量。
 * - Bug／规则依据：#12242 评审：多账号插件引擎按任务读用量（键 `<engine>|task:<id>`），引擎列表刷新时
 *   按引擎键精确匹配，把任务的读取当成已移除的引擎删掉，输入框用量随之消失。
 * - 现有覆盖缺口：这个读取器此前没有单测。
 * - 最小失败输入：一个仍在上报用量的引擎，一个读到一半的任务用量；引擎列表刷新。
 * - tier：unit（内存对象，无计时器推进）。
 */
import { describe, expect, it } from 'vitest';
import { createPluginHarnessUsageReader } from '../pluginHarnessUsageReader.js';
import { parseGhostHarnessUsage } from '../pluginHarnesses.js';

const ENGINE = 'dsh-plugin:dsh';
const usage = { updatedAt: 1, balances: [{ currency: 'CNY', amount: '1.00' }] };

describe('plugin engine usage reads', () => {
  it('keeps a task read of an engine that still reports usage, and drops it when the engine stops', async () => {
    const reader = createPluginHarnessUsageReader();
    const owner = {};
    let answer!: (value: unknown) => void;
    const kept = reader.read(owner, null, `${ENGINE}|task:t1`, () => new Promise((resolve) => { answer = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reader.retainReportingEngines(owner, null, [{ key: ENGINE, reportsUsage: true }]);
    answer(usage);
    expect(await kept.result).toEqual(usage);

    let late!: (value: unknown) => void;
    const dropped = reader.read(owner, null, `${ENGINE}|task:t2`, () => new Promise((resolve) => { late = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reader.retainReportingEngines(owner, null, [{ key: ENGINE }]);
    late(usage);
    expect(await dropped.result).toBeNull();
  });
});

// #12709: keep optional pool labels across the worker/IPC boundary, with the same whole-report
// rejection as other display fields. The reader's cache test only exercises a currency balance.
describe('plugin usage window pool labels', () => {
  const window = { label: 'Gemini Models · 5h', remainingPercent: 97 };
  const report = (fields: Record<string, unknown>) => ({
    updatedAt: 1,
    windows: [window, { ...window, ...fields }],
  });

  it('preserves a valid full name and short name alongside ungrouped windows', () => {
    const value = report({ group: 'Gemini Models', groupShort: 'Gemini' });
    expect(parseGhostHarnessUsage(value)).toEqual(value);
  });

  it.each([
    { group: 'g'.repeat(61) }, { groupShort: 's'.repeat(25) },
    { group: 'a\nb' }, { groupShort: 'a\tb' },
    { group: '' }, { groupShort: ' ' },
  ])('rejects the entire report when a name is invalid: %o', (fields) => {
    expect(parseGhostHarnessUsage(report(fields))).toBeUndefined();
  });
});
