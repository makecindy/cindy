/**
 * 测试价值
 * - 生产入口与可观察结果：project.ts 的 readProjectValues（主力电脑上传）与 applyProjectRules /
 *   applyProjectAutomations（接管时写入）。主力电脑上传的规则与自动化到了新电脑，项目里得到同样的
 *   AGENTS.md（记一个版本）、同样的自动化与暂停状态；再到达一次什么都不重写；墓碑删除同一条。
 * - 规则依据：cloud-companions.md §2.1（规则与自动化随行、项目文件留在主力电脑、按 configId 幂等、
 *   带别的电脑检查命令的先暂停、读不出来不墓碑）。
 * - 现有覆盖缺口：新增的两个云端键此前不存在；materialize.test.ts 只覆盖把行交给宿主。
 * - 最小失败输入：一条暂停的自动化、一条带检查命令、一条运行位置指向接手电脑；自动化文件读失败。
 * - tier：unit（内存 fake 的文件与调度器，无 Electron）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyProjectAutomations, applyProjectCarryover, applyProjectRules, readProjectValues, type CompanionProjectIo, type ProjectAutomationEntry,
} from '../project.js';

function fakeProject(input: { rules?: string | null; carryover?: string | null; automations?: ProjectAutomationEntry[]; isProject?: boolean } = {}) {
  let rules = input.rules ?? null;
  let carryover = input.carryover ?? null;
  const automations = new Map((input.automations ?? []).map(entry => [entry.config.id, structuredClone(entry)]));
  const io = {
    projectDir: vi.fn(async () => (input.isProject === false ? null : '/project')),
    prepareProject: vi.fn(async () => '/project'),
    readRules: vi.fn(async () => rules),
    writeRules: vi.fn(async (_dir: string, content: string) => { rules = content; }),
    readCarryover: vi.fn(async () => carryover),
    writeCarryover: vi.fn(async (_dir: string, content: string) => { carryover = content; }),
    snapshot: vi.fn(async () => undefined),
    automations: vi.fn(async () => [...automations.values()].map(entry => structuredClone(entry))),
    upsertAutomation: vi.fn(async (_dir: string, config: Record<string, unknown>) => {
      if (typeof config.cronExpr !== 'string') throw Object.assign(new Error('invalid project schedule config'), { code: 'INVALID_PARAMS' });
      const id = config.id as string;
      automations.set(id, { config: config as ProjectAutomationEntry['config'], paused: automations.get(id)?.paused ?? false });
    }),
    removeAutomation: vi.fn(async (_dir: string, id: string) => { automations.delete(id); }),
    setAutomationPaused: vi.fn(async (_dir: string, id: string, paused: boolean) => { automations.get(id)!.paused = paused; }),
  } satisfies CompanionProjectIo;
  return { io, rules: () => rules, carryover: () => carryover, automations };
}

const daily = { id: 'daily-report', name: 'Daily report', prompt: 'Write it', cronExpr: '0 9 * * *', agentDeviceId: 'desk', model: 'm' };
const check = { id: 'watch-repo', name: 'Watch', prompt: 'Look', cronExpr: '*/30 * * * *', preRunHook: { command: 'node check.mjs' } };
const review = { id: 'teammate-memory-review', name: 'Review', prompt: 'Keep', cronExpr: '30 3 * * *' };

/** What the home uploads, as the rows the new computer reads back. */
async function upload(home: ReturnType<typeof fakeProject>) {
  const values = await readProjectValues('bot_mia', home.io, 'laptop');
  return { values, rules: values.find(v => v.key === 'companion.project-rules.v1')?.value as { content: string } | undefined,
    rows: values.filter(v => v.key.startsWith('companion.automation.v1:')).map(v => ({ id: v.key.slice('companion.automation.v1:'.length), value: v.value })) };
}

describe('teammate project setup through the cloud', () => {
  it('arrives with the same rules and automations, paused alike, and a second arrival rewrites nothing', async () => {
    const home = fakeProject({ rules: '# Mia · project rules\n- Be brief\n', automations: [
      { config: daily, paused: true }, { config: check, paused: false }, { config: review, paused: false }] });
    const sent = await upload(home);
    expect(sent.values.map(v => v.key).sort()).toEqual(['companion.automation.v1:daily-report', 'companion.automation.v1:teammate-memory-review',
      'companion.automation.v1:watch-repo', 'companion.project-rules.v1']);

    // The new main computer ("desk") already made its own memory review during the upgrade.
    const here = fakeProject({ rules: '# template\n', automations: [{ config: review, paused: false }] });
    const assertCurrent = vi.fn();
    await applyProjectRules({ botId: 'bot_mia', content: sent.rules!.content, io: here.io, assertCurrent });
    await applyProjectAutomations({ botId: 'bot_mia', rows: sent.rows, io: here.io, selfDeviceId: 'desk', assertCurrent });

    expect(here.rules()).toBe('# Mia · project rules\n- Be brief\n');
    expect(here.io.snapshot).toHaveBeenCalledOnce();
    // "Run on desk" from the old home is this computer now; the check saved on the laptop arrives paused.
    expect(Object.fromEntries([...here.automations].map(([id, entry]) => [id, entry]))).toEqual({
      'teammate-memory-review': { config: review, paused: false },
      'daily-report': { config: { ...daily, agentDeviceId: undefined }, paused: true },
      'watch-repo': { config: check, paused: true },
    });
    expect(here.io.upsertAutomation.mock.calls.map(([, config]) => config.id)).toEqual(['daily-report', 'watch-repo']);
    expect(here.io.prepareProject).toHaveBeenCalledWith('bot_mia', assertCurrent);

    vi.clearAllMocks();
    await applyProjectRules({ botId: 'bot_mia', content: sent.rules!.content, io: here.io, assertCurrent });
    await applyProjectAutomations({ botId: 'bot_mia', rows: sent.rows, io: here.io, selfDeviceId: 'desk', assertCurrent });
    expect(here.io.writeRules).not.toHaveBeenCalled();
    expect(here.io.snapshot).not.toHaveBeenCalled();
    expect(here.io.upsertAutomation).not.toHaveBeenCalled();
    expect(here.io.setAutomationPaused).not.toHaveBeenCalled();
  });

  it('removes a deleted automation, keeps ones only this computer has, and skips an invalid definition', async () => {
    const here = fakeProject({ automations: [{ config: daily, paused: false }, { config: review, paused: false }] });
    const log = { warn: vi.fn(), info: vi.fn() };
    await applyProjectAutomations({ botId: 'bot_mia', selfDeviceId: 'desk', assertCurrent: () => undefined, io: here.io, log, rows: [
      { id: 'daily-report', value: null },
      { id: 'broken', value: { config: { id: 'broken', name: 'x', prompt: 'x' }, paused: false } },
      { id: 'mismatch', value: { config: { ...check, id: 'other' }, paused: false } },
    ] });
    expect([...here.automations.keys()]).toEqual(['teammate-memory-review']);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the cloud values of a part it cannot read, and sends nothing for a teammate that is not a project', async () => {
    const home = fakeProject({ rules: 'rules' });
    home.io.automations.mockRejectedValueOnce(new Error('AUTOMATIONS_UNREADABLE'));
    expect(await readProjectValues('bot_mia', home.io, 'laptop')).toEqual([
      { key: 'companion.project-rules.v1', value: { content: 'rules' } },
      { key: 'companion.automation.v1:', value: null, unread: true },
    ]);
    expect(await readProjectValues('bot_mia', fakeProject({ rules: 'rules', isProject: false }).io, 'laptop')).toEqual([]);
  });

  // PR #9314 review: the upgrade left unfinished V1 work in CARRYOVER.md and pointed the rules at it,
  // but only the rules travelled: on the next main computer the rules pointed to a missing file.
  it('takes the unfinished V1 work along with the rules', async () => {
    const home = fakeProject({ rules: '# rules\nSee CARRYOVER.md\n', carryover: '# Carried over\n- [ ] Ship the fix\n' });
    const sent = await readProjectValues('bot_mia', home.io, 'laptop');
    const value = sent.find(v => v.key === 'companion.project-carryover.v1')?.value as { content: string } | undefined;
    expect(value?.content).toBe('# Carried over\n- [ ] Ship the fix\n');
    const here = fakeProject();
    await applyProjectCarryover({ botId: 'bot_mia', content: value!.content, io: here.io, assertCurrent: vi.fn() });
    expect(here.carryover()).toBe(value!.content);
    await applyProjectCarryover({ botId: 'bot_mia', content: value!.content, io: here.io, assertCurrent: vi.fn() });
    expect(here.io.writeCarryover).toHaveBeenCalledTimes(1);
  });
});
