/**
 * 测试价值
 * - 生产入口与可观察结果：recordModelGroupDecision / readModelGroupDecisions——设置页「最近的选择」列出的条目、
 *   顺序与条数，以及落盘文件里只有组与模型信息。
 * - Bug／规则依据：docs/product-rules/model-groups.md 总览「最近的选择」；docs/dev-rules/credentials-and-local-storage.md
 *   （按账号存放、有上限、损坏不阻断）。
 * - 现有覆盖缺口：pick.test.ts 只覆盖选谁，不覆盖选完后的记录。
 * - 最小失败输入：连记 51 次（第 1 条应被挤掉、最新在前）；文件内容不是 JSON；组已被删除（missing）；
 *   旧版经模式留下的条目（2026-11-11 模式并入路线）；选中另一台电脑上的来源时漏记运行位置。
 * - tier：unit，临时目录里的真实文件读写，账号目录经 mock 指过去。
 * - 实测耗时：单独运行约 1.2 秒（pnpm exec vitest run src/main/model-groups/__tests__/decisionLog.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelGroupResolveResult } from '../../../shared/modelGroups.js';

const paths = vi.hoisted(() => ({ file: '' }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../ownerContext.js', () => ({
  activeDataOwnerId: () => 'owner-1',
  ownerScopedPath: () => paths.file,
}));

import { readModelGroupDecisions, recordModelGroupDecision } from '../decisionLog.js';

const routed = (n: number): ModelGroupResolveResult => ({
  outcome: 'routed',
  groupName: `路线 ${n}`,
  route: { agentKind: 'codex', providerId: 'chatgpt-work', model: 'gpt-5.6', effort: 'high' },
  modelName: 'GPT-5.6',
  sourceName: 'ChatGPT Plus',
  why: 'expiring',
  quota: { usedPercent: 39, resetAtMs: 1_000, windowMs: 7 * 86_400_000 },
  trace: [],
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-group-decisions-'));
  paths.file = path.join(dir, 'model-group-decisions.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('model group decision log', () => {
  it('keeps the 50 newest picks, newest first, with only group and model facts on disk', () => {
    for (let n = 1; n <= 51; n += 1) recordModelGroupDecision({ type: 'route', id: `r${n}` }, routed(n), n);
    const decisions = readModelGroupDecisions();
    expect(decisions).toHaveLength(50);
    expect(decisions[0]).toEqual({
      at: 51, groupType: 'route', groupId: 'r51', groupName: '路线 51', outcome: 'routed',
      agentKind: 'codex', providerId: 'chatgpt-work', model: 'gpt-5.6', modelName: 'GPT-5.6', sourceName: 'ChatGPT Plus',
      effort: 'high', why: 'expiring', quota: { usedPercent: 39, resetAtMs: 1_000, windowMs: 7 * 86_400_000 },
    });
    expect(decisions.at(-1)?.groupId).toBe('r2');
  });

  it('records unavailable but not a deleted group, drops entries left by old modes, and treats a corrupt file as no history', () => {
    recordModelGroupDecision({ type: 'route', id: 'gone' }, { outcome: 'missing', groupName: '旧路线', trace: [] }, 1);
    expect(fs.existsSync(paths.file)).toBe(false);

    fs.writeFileSync(paths.file, JSON.stringify({ decisions: [{ at: 1, groupType: 'mode', groupId: 'm1', groupName: '深入', outcome: 'unavailable' }] }));
    recordModelGroupDecision({ type: 'route', id: 'r9' }, { outcome: 'unavailable', groupName: '省着用', trace: [] }, 2);
    expect(readModelGroupDecisions()).toEqual([{ at: 2, groupType: 'route', groupId: 'r9', groupName: '省着用', outcome: 'unavailable' }]);

    fs.writeFileSync(paths.file, '{not json');
    expect(readModelGroupDecisions()).toEqual([]);
    recordModelGroupDecision({ type: 'route', id: 'r1' }, routed(1), 3);
    expect(readModelGroupDecisions().map((item) => item.groupId)).toEqual(['r1']);
  });

  it('keeps where a picked source runs when it is on another computer', () => {
    const remote = routed(1);
    if (remote.outcome === 'routed') remote.route = { ...remote.route, agentDeviceId: 'dev-2' };
    recordModelGroupDecision({ type: 'route', id: 'r1' }, remote, 1);
    expect(readModelGroupDecisions()[0]).toMatchObject({ providerId: 'chatgpt-work', agentDeviceId: 'dev-2' });
  });
});
