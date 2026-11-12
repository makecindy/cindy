/**
 * 测试价值
 * - 生产入口与可观察结果：computeModelGroupSwitchOffer(model-groups:switch-offer 的实现)——撞配额横幅里提议换到谁，
 *   或不提议；以及 sessionBindings 落盘后读回的记录。
 * - 规则依据：docs/product-rules/model-groups.md §6.1；docs/dev-rules/credentials-and-local-storage.md「模型组任务记录」
 *   (按账号存放、有上限、损坏不阻断)。
 * - 现有覆盖缺口：pick.test.ts 只覆盖新任务选谁，不覆盖「排除正在用的账号后还剩谁」与哪些任务不该提议。
 * - 最小失败输入：同一供应商连接的另一个模型(同一份配额)被提议；配额已用完、停用或不可选的被提议；
 *   用户已自己换过模型仍提议；目标 / 定时 / 远程 / 共享任务被提议；另一台电脑上的来源被提议(会把运行中的任务挪走)；
 *   记录文件不是 JSON；旧版经模式留下的记录；第 2001 条记录。
 * - tier：unit，注入依赖的纯函数；记录用临时目录里的真实文件，账号目录经 mock 指过去。
 * - 实测耗时：单独运行约 1 秒（pnpm exec vitest run src/main/model-groups/__tests__/switchOffer.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  modelGroupCandidateKey,
  type ModelGroupCandidate,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupTraceQuota,
} from '../../../shared/modelGroups.js';
import type { ModelGroupCandidateFacts } from '../pick.js';
import { computeModelGroupSwitchOffer, type ModelGroupSwitchOfferSessionRow } from '../switchOffer.js';

const paths = vi.hoisted(() => ({ file: '', owner: 'owner-1' as string | null }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../ownerContext.js', () => ({
  activeDataOwnerId: () => paths.owner,
  ownerScopedPath: () => paths.file,
}));

import {
  bindModelGroupSession,
  MODEL_GROUP_SESSION_BINDINGS_MAX,
  readModelGroupSessionBinding,
} from '../sessionBindings.js';

const NOW = Date.UTC(2026, 10, 11, 4);
const HOUR = 3_600_000;
const used = (usedPercent: number): ModelGroupTraceQuota[] =>
  [{ usedPercent, resetAtMs: NOW + 20 * HOUR, windowMs: 7 * 24 * HOUR }];

/** 0 正在用；1 同一个连接的另一个模型；2 另一个引擎的订阅；3 同引擎另一个账号。 */
const CANDIDATES: ModelGroupCandidate[] = [
  { agentKind: 'codex', providerId: 'acct-a', model: 'gpt' },
  { agentKind: 'codex', providerId: 'acct-a', model: 'gpt-mini' },
  { agentKind: 'cc', providerId: 'anthropic', model: 'opus' },
  { agentKind: 'codex', providerId: 'acct-b', model: 'gpt' },
];
const route = (strategy: ModelGroupRoute['strategy'], off: number[] = []): ModelGroupRoute => ({
  id: 'r1', name: '主力编程', strategy,
  candidates: CANDIDATES.map((candidate, index) => (off.includes(index) ? { ...candidate, off: true } : candidate)),
});
const fact = (sourceName: string, windows: ModelGroupTraceQuota[] | null, available = true): ModelGroupCandidateFacts =>
  ({ available, modelName: 'M', sourceName, windows });
/** 正在用的 0 撞了上限；1 同一个连接、额度窗口没读到(按选法本会排在前面)；2、3 都还有配额。 */
const FACTS = [fact('A', used(100)), fact('A', null), fact('Claude', used(10)), fact('B', used(30))];

const ROW: ModelGroupSwitchOfferSessionRow = {
  source: 'desktop', agentKind: 'codex', providerId: 'acct-a', model: 'gpt',
  remoteHostId: null, agentDeviceId: null, orcaRole: null,
};
const CURRENT = modelGroupCandidateKey({ agentKind: 'codex', providerId: 'acct-a', model: 'gpt' });

function deps(overrides: {
  config?: ModelGroupsConfig;
  facts?: ModelGroupCandidateFacts[];
  row?: Partial<ModelGroupSwitchOfferSessionRow>;
  pickedKey?: string | null;
  shared?: boolean;
  goal?: boolean;
} = {}) {
  const pickedKey = overrides.pickedKey === undefined ? CURRENT : overrides.pickedKey;
  return {
    readBinding: vi.fn(() => (pickedKey ? { selection: { type: 'route' as const, id: 'r1' }, pickedKey, at: 1 } : null)),
    clearBinding: vi.fn(),
    readSession: vi.fn(async () => ({ ...ROW, ...overrides.row })),
    isShared: () => overrides.shared === true,
    hasGoal: async () => overrides.goal === true,
    config: () => overrides.config ?? { routes: [route('order')] },
    candidateFacts: vi.fn(async (_route: ModelGroupRoute) => overrides.facts ?? FACTS),
    now: () => NOW,
  };
}

describe('computeModelGroupSwitchOffer', () => {
  it.each([
    ['skips the same account and offers the next source, across engines', {}, { providerId: 'anthropic', agentKind: 'cc', crossEngine: true, sourceName: 'Claude' }],
    ['skips a source whose quota is used up', { facts: [FACTS[0], FACTS[1], fact('Claude', used(100)), FACTS[3]] }, { providerId: 'acct-b', crossEngine: false }],
    ['skips a source the route has turned off', { config: { routes: [route('order', [2])] } }, { providerId: 'acct-b' }],
    ['skips a source that cannot be picked now', { facts: [FACTS[0], FACTS[1], fact('Claude', null, false), FACTS[3]] }, { providerId: 'acct-b' }],
    ['rotate counts on from the source in use', {
      config: { routes: [route('rotate')] }, row: { providerId: 'anthropic', agentKind: 'cc', model: 'opus' },
      pickedKey: modelGroupCandidateKey({ agentKind: 'cc', providerId: 'anthropic', model: 'opus' }),
      facts: [fact('A', used(10)), fact('A', used(10)), fact('Claude', used(100)), fact('B', used(10))],
    }, { providerId: 'acct-b', crossEngine: true }],
  ] as const)('%s', async (_name, input, expected) => {
    const offer = await computeModelGroupSwitchOffer(deps(input as Parameters<typeof deps>[0]), 's1');
    expect(offer).toMatchObject({ groupName: '主力编程', selection: { type: 'route', id: 'r1' }, ...expected });
  });

  it('silently skips sources that run on another computer and does not read their catalogs', async () => {
    // 1 在另一台电脑上、还有配额，按顺序本该先提议它。
    const remote: ModelGroupCandidate = { agentKind: 'codex', providerId: 'acct-c', model: 'gpt', agentDeviceId: 'dev-2' };
    const candidates = [CANDIDATES[0], remote, CANDIDATES[3]];
    const d = deps({ config: { routes: [{ ...route('order'), candidates }] }, facts: [FACTS[0], fact('C', used(10)), FACTS[3]] });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toMatchObject({ providerId: 'acct-b', crossEngine: false });
    expect(d.candidateFacts.mock.calls[0]?.[0]?.candidates[1]).toMatchObject({ agentDeviceId: 'dev-2', off: true });
    const onlyRemote = deps({ config: { routes: [{ ...route('order'), candidates: [CANDIDATES[0], remote] }] }, facts: [FACTS[0], fact('C', used(10))] });
    expect(await computeModelGroupSwitchOffer(onlyRemote, 's1')).toBeNull();
  });

  it('gives the same answer when asked again (no rotate cursor or decision is advanced)', async () => {
    const d = deps({ config: { routes: [route('rotate')] } });
    const first = await computeModelGroupSwitchOffer(d, 's1');
    expect(await computeModelGroupSwitchOffer(d, 's1')).toEqual(first);
    expect(first).toMatchObject({ providerId: 'anthropic' });
  });

  it.each([
    ['every other source is used up or the same account', { facts: [FACTS[0], FACTS[1], fact('Claude', used(100)), fact('B', used(100))] }],
    ['the route was deleted', { config: { routes: [] } }],
    ['a goal task', { goal: true }],
    ['a shared task', { shared: true }],
    ['a scheduled run', { row: { source: 'scheduler' } }],
    ['a companion', { row: { source: 'bot' } }],
    ['an SSH task', { row: { remoteHostId: 'host-1' } }],
    ['an Agent running on another computer', { row: { agentDeviceId: 'dev-2' } }],
    ['a collaboration lead', { row: { orcaRole: 'lead' } }],
  ] as const)('offers nothing for %s and keeps the record', async (_name, input) => {
    const d = deps(input as Parameters<typeof deps>[0]);
    expect(await computeModelGroupSwitchOffer(d, 's1')).toBeNull();
    expect(d.clearBinding).not.toHaveBeenCalled();
  });

  it('offers nothing without a record and does not read the task', async () => {
    const d = deps({ pickedKey: null });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toBeNull();
    expect(d.readSession).not.toHaveBeenCalled();
  });

  it('drops the record once the task model was changed some other way', async () => {
    const d = deps({ row: { providerId: 'acct-b' } });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toBeNull();
    expect(d.clearBinding).toHaveBeenCalledWith('s1');
    expect(d.candidateFacts).not.toHaveBeenCalled();
  });
});

describe('model group session bindings', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-group-bindings-'));
    paths.file = path.join(dir, 'model-group-session-bindings.json');
    paths.owner = 'owner-1';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps only the newest records', () => {
    const bindings = Object.fromEntries(Array.from({ length: MODEL_GROUP_SESSION_BINDINGS_MAX }, (_, n) =>
      [`s${n}`, { selection: { type: 'route', id: 'r1' }, pickedKey: CURRENT, at: n + 1 }]));
    fs.writeFileSync(paths.file, JSON.stringify({ bindings }));
    bindModelGroupSession('new', { type: 'route', id: 'r2' }, CURRENT, 10_000);
    const saved = JSON.parse(fs.readFileSync(paths.file, 'utf8')) as { bindings: Record<string, unknown> };
    expect(Object.keys(saved.bindings)).toHaveLength(MODEL_GROUP_SESSION_BINDINGS_MAX);
    expect(readModelGroupSessionBinding('s0')).toBeNull();
    expect(readModelGroupSessionBinding('new')).toEqual({ selection: { type: 'route', id: 'r2' }, pickedKey: CURRENT, at: 10_000 });
  });

  it('reads a damaged file or a record left by an old mode as no record, and overwrites it on the next write', () => {
    fs.writeFileSync(paths.file, JSON.stringify({ bindings: { s1: { selection: { type: 'mode', id: 'm1' }, pickedKey: CURRENT, at: 1 } } }));
    expect(readModelGroupSessionBinding('s1')).toBeNull();
    fs.writeFileSync(paths.file, '{not json');
    expect(readModelGroupSessionBinding('s1')).toBeNull();
    bindModelGroupSession('s1', { type: 'route', id: 'r1' }, CURRENT, 5);
    expect(readModelGroupSessionBinding('s1')).toMatchObject({ pickedKey: CURRENT });
  });

  it('neither reads nor writes before an account is signed in', () => {
    paths.owner = null;
    bindModelGroupSession('s1', { type: 'route', id: 'r1' }, CURRENT, 5);
    expect(fs.existsSync(paths.file)).toBe(false);
    expect(readModelGroupSessionBinding('s1')).toBeNull();
  });
});
