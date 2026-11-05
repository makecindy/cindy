/**
 * 测试价值
 * - 生产入口与可观察结果：diagnoseScheduleHookPlugin + withPreRunHookDiagnosis +
 *   formatPreRunHookFailure；定时任务失败记录里写明缺哪个插件，而不是只有退出码。
 * - Bug 依据：卸载 GitHub 插件后，PR 跟进的检查脚本随技能目录一起消失，失败只显示
 *   "pre-run hook failed with exit code 1"，看不出原因。
 * - 现有覆盖缺口：preRunHook.test.ts 只覆盖进程退出语义，不识别脚本所属插件。
 * - 最小失败输入：命令引用 <skills>/cindy-github--pr/… 而该目录不存在。
 * - tier：unit（真实临时目录，无网络）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { diagnoseScheduleHookPlugin } from '../scheduleHookPluginDiagnosis';
import { formatPreRunHookFailure, type PreRunHookResult } from '../../scheduler-host/pre-run-hook';
import { withPreRunHookDiagnosis } from '../../scheduler-host/pre-run-hook-diagnosis';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-hook-plugin-diagnosis-'));
const skillsRoot = path.join(root, 'Application Support', 'agent-skills', 'skills');
fs.mkdirSync(path.join(skillsRoot, '_ns__xd__present--pr', 'scripts'), { recursive: true });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const command = (link: string) =>
  `node '${path.join(skillsRoot, link, 'scripts', 'gate.mjs')}' https://github.com/o/r/pull/1`;
const blocked: PreRunHookResult = {
  status: 'failed', decision: 'block', exitCode: 1, durationMs: 1, stdout: '', stderr: 'MODULE_NOT_FOUND',
  stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false,
};

describe('schedule check blocked by an unavailable plugin', () => {
  it.each([
    {
      link: 'cindy-github--pr', installed: null, market: { pluginId: 'p1', name: 'GitHub' },
      expected: { ghostId: 'cindy-github', pluginId: 'p1', name: 'GitHub' },
      message: 'plugin "GitHub" (cindy-github) is not installed',
    },
    {
      link: 'cindy-github--pr', installed: { name: 'GitHub', enabled: false }, market: null,
      expected: { ghostId: 'cindy-github', name: 'GitHub', installed: true },
      message: 'plugin "GitHub" (cindy-github) is not enabled',
    },
  ])('names the plugin: $message', async ({ link, installed, market, expected, message }) => {
    const diagnose = (cmd: string) => diagnoseScheduleHookPlugin(cmd, {
      skillsRoot,
      findInstalled: () => installed,
      lookupMarket: async () => market,
    });
    const hook = await withPreRunHookDiagnosis(blocked, command(link), diagnose);
    expect(hook.missingPlugin).toEqual(expected);
    expect(formatPreRunHookFailure(hook)).toContain(message);
  });

  // Review (#8957): an enabled plugin whose skill was dropped by an update must not be reported
  // as "not enabled"; an aborted check must not wait for the market lookup.
  it('keeps the original error for an enabled plugin and skips diagnosis for aborted checks', async () => {
    let lookups = 0;
    const deps = {
      skillsRoot,
      findInstalled: () => ({ name: 'GitHub', enabled: true }),
      lookupMarket: async () => { lookups += 1; return null; },
    };
    expect(await diagnoseScheduleHookPlugin(command('cindy-github--pr'), deps)).toBeUndefined();
    const aborted = { ...blocked, status: 'aborted' as const, aborted: true };
    const diagnose = async () => { lookups += 1; return { ghostId: 'cindy-github' }; };
    expect(await withPreRunHookDiagnosis(aborted, command('cindy-github--pr'), diagnose)).toBe(aborted);
    expect(lookups).toBe(0);
  });

  it('leaves failures alone when the plugin skill is present or the script is unrelated', async () => {
    const deps = { skillsRoot, findInstalled: () => null, lookupMarket: async () => null };
    expect(await diagnoseScheduleHookPlugin(command('_ns__xd__present--pr'), deps)).toBeUndefined();
    expect(await diagnoseScheduleHookPlugin('node /elsewhere/check.mjs', deps)).toBeUndefined();
    expect(formatPreRunHookFailure(blocked)).toBe('pre-run hook failed with exit code 1');
  });
});
