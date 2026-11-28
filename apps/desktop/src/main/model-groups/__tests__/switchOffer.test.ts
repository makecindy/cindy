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
import type { ProviderView } from '@cindy/model-providers';
import type { ModelGroupCandidateFacts } from '../pick.js';
import { createModelGroupResolver, modelGroupQuotaKey } from '../resolver.js';
import { computeModelGroupSwitchOffer, isModelGroupRecoverySource, type ModelGroupSwitchOfferSessionRow } from '../switchOffer.js';

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
  clearModelGroupSessionState,
  isModelGroupSessionDetached,
  isModelGroupSessionDetachedForDispatch,
  MODEL_GROUP_SESSION_BINDINGS_MAX,
  modelGroupBindingMatchesTarget,
  projectModelGroupSessionBinding,
  readModelGroupSessionBinding,
  readActiveModelGroupBindingForDispatch,
  readModelGroupBindingForDispatch,
  readModelGroupRoutedAccount,
  unbindModelGroupSession,
} from '../sessionBindings.js';
import { createModelGroupHandlers } from '../handlersCore.js';
import { runModelGroupBeforeSend, type RunModelGroupBeforeSendSessionRow } from '../applyTurnRouting.js';
import { evaluateModelGroupBeforeSend } from '../turnRouting.js';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  projectPendingModelGroupTarget,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../../maker-ipc/sessionAgentSwitchHandler.js';

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
    readSession: vi.fn(async () => ({ ...ROW, ...overrides.row })),
    isShared: () => overrides.shared === true,
    hasGoal: async () => overrides.goal === true,
    config: () => overrides.config ?? { routes: [route('order')] },
    candidateFacts: vi.fn(async (_route: ModelGroupRoute) => overrides.facts ?? FACTS),
    now: () => NOW,
  };
}

describe('computeModelGroupSwitchOffer', () => {
  // §4.5 / #12440, unit: a mode can be switched off after dispatch; the automatic
  // candidate lookup must decline while a manual banner can still offer the same source.
  it('honors a disabled group during recovery and keeps the manual switch offer', async () => {
    const d = deps({ config: { routes: [{ ...route('order'), autoSwitch: false }] } });
    expect(await computeModelGroupSwitchOffer(d, 's1', {
      current: CANDIDATES[0], visited: new Set(), accountUnavailable: true, recordUnavailable: vi.fn(),
    })).toBeNull();
    expect(await computeModelGroupSwitchOffer(d, 's1')).toMatchObject({ providerId: 'anthropic' });
  });

  it.each(['high', undefined])('keeps the route effort only when the fallback supports it: %s', async effort => {
    const d = deps({
      config: { routes: [{ ...route('order'), effort: 'high' }] },
      facts: FACTS.map(fact => ({ ...fact, effort })),
    });
    const offer = await computeModelGroupSwitchOffer(d, 's1', {
      current: CANDIDATES[0], visited: new Set(), accountUnavailable: false, recordUnavailable: vi.fn(),
    });
    expect(offer?.providerId).toBe('acct-a');
    expect(offer?.effort).toBe(effort);
  });

  it('replays an image turn on the next vision candidate when the route has an image exception', async () => {
    const d = deps({
      config: { routes: [{ ...route('order'), exceptions: [{ when: { type: 'image' }, use: 'vision' }] }] },
      facts: FACTS.map((fact, index) => ({ ...fact, acceptsImage: index === 0 || index === 3 })),
    });
    const offer = await computeModelGroupSwitchOffer(d, 's1', {
      current: CANDIDATES[0], visited: new Set(), accountUnavailable: false, hasImages: true, recordUnavailable: vi.fn(),
    });
    expect(offer).toMatchObject({ providerId: 'acct-b', model: 'gpt' });
  });

  // Unit: after the initially bound account fails, a second failure must advance
  // past both visited routes, even when the session row still holds the baseline.
  it('advances an automatic recovery past both failed candidates', async () => {
    const visited = new Set<string>();
    const recover = (index: number, accountUnavailable: boolean) => computeModelGroupSwitchOffer(deps(), 's1', {
      current: CANDIDATES[index], accountUnavailable, visited,
      recordUnavailable: candidate => visited.add(modelGroupCandidateKey(candidate)),
    });
    // The activity line names the source it moved away from (model-groups.md §4.6).
    // Same engine first (model-groups.md §4.2): the other Codex account, then Claude once no Codex source is left.
    expect(await recover(0, true)).toMatchObject({ providerId: 'acct-b', crossEngine: false, fromLabel: 'M · A' });
    expect(await recover(3, false)).toMatchObject({ providerId: 'anthropic', crossEngine: true, fromLabel: 'M · B' });
    expect(await recover(2, false)).toBeNull();
    visited.clear();
    // Crosses engines only when no source on the same engine is usable.
    const crossDeps = deps({ facts: [FACTS[0], FACTS[1], FACTS[2], fact('B', used(100))] });
    expect(await computeModelGroupSwitchOffer(crossDeps, 's1', {
      current: CANDIDATES[0], accountUnavailable: true, visited: new Set(), recordUnavailable: vi.fn(),
    })).toMatchObject({ providerId: 'anthropic', crossEngine: true });
    expect(await recover(0, false)).toMatchObject({ providerId: 'acct-a', model: 'gpt-mini' });
  });

  it.each([
    // The banner offer follows the route's own order (§6.1); only automatic takeover prefers the same engine.
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

  it('prefers the same location first, then falls back to sources on another computer or share', async () => {
    // 1 在另一台电脑上、还有配额；2 在本机也有配额：优先同位置 2，避免无谓跨机。
    const remote: ModelGroupCandidate = { agentKind: 'codex', providerId: 'acct-c', model: 'gpt', agentDeviceId: 'dev-2' };
    const candidates = [CANDIDATES[0], remote, CANDIDATES[3]];
    const d = deps({ config: { routes: [{ ...route('order'), candidates }] }, facts: [FACTS[0], fact('C', used(10)), FACTS[3]] });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toMatchObject({ providerId: 'acct-b', crossEngine: false });
    // 同位置已无可用来源时，跨位置交接到另一台电脑或分享来源(2026-11-27 全面接替)。
    const onlyRemote = deps({ config: { routes: [{ ...route('order'), candidates: [CANDIDATES[0], remote] }] }, facts: [FACTS[0], fact('C', used(10))] });
    expect(await computeModelGroupSwitchOffer(onlyRemote, 's1')).toMatchObject({
      providerId: 'acct-c',
      agentDeviceId: 'dev-2',
      crossLocation: true,
    });
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
    ['a locked review task', { row: { source: 'review' } }],
  ] as const)('offers nothing for %s', async (_name, input) => {
    const d = deps(input as Parameters<typeof deps>[0]);
    expect(await computeModelGroupSwitchOffer(d, 's1')).toBeNull();
  });

  // 2026-11-27 用户裁决：智能路由在任务中间与所有任务形态统一接替(含目标、共享任务、IM、伙伴、协同、远程 Agent、SSH)。
  it.each([
    ['a goal task', { goal: true }],
    ['a shared task', { shared: true }],
    ['an IM task', { row: { source: 'feishu' } }],
    ['a companion', { row: { source: 'bot' } }],
    ['a collaboration lead', { row: { orcaRole: 'lead' } }],
    ['an automation task', { row: { source: 'scheduler' } }],
  ] as const)('offers recovery for %s', async (_name, input) => {
    const d = deps(input as Parameters<typeof deps>[0]);
    expect(await computeModelGroupSwitchOffer(d, 's1')).toMatchObject({ providerId: 'anthropic' });
    expect(isModelGroupRecoverySource('scheduler')).toBe(true);
    expect(isModelGroupRecoverySource('bot')).toBe(true);
    expect(isModelGroupRecoverySource('review')).toBe(false);
  });

  it('keeps SSH tasks on local/SSH-compatible sources and blocks cross-device candidates', async () => {
    const remote: ModelGroupCandidate = { agentKind: 'codex', providerId: 'acct-c', model: 'gpt', agentDeviceId: 'dev-2' };
    const d = deps({
      row: { remoteHostId: 'host-1' },
      config: { routes: [{ ...route('order'), candidates: [CANDIDATES[0], remote, CANDIDATES[3]] }] },
      facts: [FACTS[0], fact('C', used(10)), FACTS[3]],
    });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toMatchObject({ providerId: 'acct-b' });
    expect(d.candidateFacts).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: expect.arrayContaining([expect.objectContaining({ agentDeviceId: 'dev-2', off: true })]) }),
      undefined,
      { sshHostId: 'host-1' },
    );
  });

  it('recovers a task currently running on another computer back to a healthy local or remote source', async () => {
    const remoteCurrent: ModelGroupCandidate = { agentKind: 'codex', providerId: 'acct-a', model: 'gpt', agentDeviceId: 'dev-2' };
    const localBackup: ModelGroupCandidate = { agentKind: 'codex', providerId: 'acct-b', model: 'gpt' };
    const d = deps({
      row: { agentDeviceId: 'dev-2' },
      pickedKey: modelGroupCandidateKey(remoteCurrent),
      config: { routes: [{ ...route('order'), candidates: [remoteCurrent, localBackup] }] },
      facts: [fact('A · dev-2', used(100)), fact('B', used(10))],
    });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toMatchObject({
      providerId: 'acct-b',
      crossLocation: true,
    });
  });

  it('offers nothing without a record and does not read the task', async () => {
    const d = deps({ pickedKey: null });
    expect(await computeModelGroupSwitchOffer(d, 's1')).toBeNull();
    expect(d.readSession).not.toHaveBeenCalled();
  });

  it('offers nothing while the task is on another model, and offers again once it is on the recorded one', async () => {
    // 跨引擎的换模型只登记了「下一条消息再换」时，任务行还是旧模型；记录不能因此丢掉。
    const elsewhere = deps({ row: { providerId: 'acct-b' } });
    expect(await computeModelGroupSwitchOffer(elsewhere, 's1')).toBeNull();
    expect(elsewhere.candidateFacts).not.toHaveBeenCalled();
    expect(await computeModelGroupSwitchOffer(deps(), 's1')).not.toBeNull();
  });

  // 生产入口与可观察结果：computeModelGroupSwitchOffer 在插件引擎候选间判断同引擎 vs 跨引擎切换。
  // 规则依据：2026-11-27 模型组支持 acp 插件引擎候选；同一插件引擎换模型为同引擎(crossEngine=false)，
  // 不同插件引擎(providerId 不同)或插件↔内置为跨引擎(crossEngine=true)。
  // 覆盖缺口：此前 isModelGroupAgentKind 拒绝 'acp'，且 isSameEngine 只比较 agentKind 未区分不同插件 providerId。
  // 最小失败输入与 tier：unit，两个不同 acp-plugin providerId 的候选在自动接替与横幅提议中互相切换。
  it('treats distinct plugin engines as cross-engine and same plugin engine models as same-engine', async () => {
    const dshA: ModelGroupCandidate = { agentKind: 'acp', providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-v4' };
    const dshB: ModelGroupCandidate = { agentKind: 'acp', providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-r1' };
    const agy: ModelGroupCandidate = { agentKind: 'acp', providerId: 'acp-plugin:agy:agy', model: 'gemini-3-pro' };
    const acpRoute: ModelGroupRoute = {
      id: 'r1',
      name: '插件主力',
      strategy: 'order',
      candidates: [dshA, agy, dshB],
    };
    const acpDeps = deps({
      config: { routes: [acpRoute] },
      row: { agentKind: 'acp', providerId: dshA.providerId, model: dshA.model },
      pickedKey: modelGroupCandidateKey(dshA),
      facts: [fact('DSH', used(100)), fact('AGY', used(20)), fact('DSH', used(20))],
    });
    // Manual banner skips same account (dshA & dshB share providerId) and offers agy as crossEngine=true.
    const bannerOffer = await computeModelGroupSwitchOffer(acpDeps, 's1');
    expect(bannerOffer).toMatchObject({
      agentKind: 'acp',
      providerId: agy.providerId,
      model: agy.model,
      crossEngine: true,
    });
    // Non-account-wide recovery prefers same plugin engine (dshB, crossEngine=false) before crossing to agy.
    const sameEngineRecovery = await computeModelGroupSwitchOffer(acpDeps, 's1', {
      current: dshA,
      visited: new Set(),
      accountUnavailable: false,
      recordUnavailable: vi.fn(),
    });
    expect(sameEngineRecovery).toMatchObject({
      agentKind: 'acp',
      providerId: dshB.providerId,
      model: dshB.model,
      crossEngine: false,
    });
  });
});

function bindPendingRoute(
  registry: ReturnType<typeof createPendingAgentSwitchRegistry>,
  sessionId: string,
  route: { agentKind: 'codex'; providerId: string; model: string; agentDeviceId?: string },
) {
  const handlers = createModelGroupHandlers({
    isDeviceLink: () => false,
    deviceLinkOrigin: () => undefined,
    markPendingModelGroupPick: registry.markModelGroupPick,
  } as Parameters<typeof createModelGroupHandlers>[0]);
  handlers.bindSession({ sessionId, selection: { type: 'route', id: 'r1' }, route }, () => {});
}

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

  it('loads a cold backup for dispatch, caches misses, and publishes writes only to the matching owner', async () => {
    const entry = { selection: { type: 'route' as const, id: 'r1' }, pickedKey: CURRENT, at: 1 };
    fs.writeFileSync(paths.file + '.bak', JSON.stringify({ bindings: { task: entry } }));
    expect(await readModelGroupBindingForDispatch('task')).toEqual(entry);
    fs.unlinkSync(paths.file + '.bak');
    expect(await readModelGroupBindingForDispatch('task')).toEqual(entry);
    expect(await readModelGroupBindingForDispatch('other')).toBeNull();
    bindModelGroupSession('other', entry.selection, CURRENT, 2);
    expect(await readModelGroupBindingForDispatch('other')).toMatchObject({ at: 2 });
    paths.owner = 'owner-2';
    paths.file = path.join(dir, 'other-owner.json');
    expect(await readModelGroupBindingForDispatch('other')).toBeNull();
  });

  it('neither reads nor writes before an account is signed in', () => {
    paths.owner = null;
    bindModelGroupSession('s1', { type: 'route', id: 'r1' }, CURRENT, 5);
    expect(fs.existsSync(paths.file)).toBe(false);
    expect(readModelGroupSessionBinding('s1')).toBeNull();
  });

  it('unbinds a session binding and projects active route metadata only when current model matches', () => {
    bindModelGroupSession('s1', { type: 'route', id: 'r1' }, CURRENT, 5);
    const stored = readModelGroupSessionBinding('s1');
    expect(projectModelGroupSessionBinding({
      binding: stored,
      config: { routes: [route('order')] },
      current: { agentKind: 'codex', providerId: 'acct-a', model: 'gpt' },
    })).toEqual({
      selection: { type: 'route', id: 'r1' },
      routeName: '主力编程',
      autoSwitch: true,
    });
    expect(projectModelGroupSessionBinding({
      binding: stored,
      config: { routes: [route('order')] },
      current: { agentKind: 'codex', providerId: 'acct-b', model: 'gpt' },
    })).toBeNull();
    expect(unbindModelGroupSession('s1')).toBe(true);
    expect(readModelGroupSessionBinding('s1')).toBeNull();
    expect(isModelGroupSessionDetached('s1')).toBe(true);
    expect(unbindModelGroupSession('s1')).toBe(false);
    clearModelGroupSessionState('s1');
    expect(isModelGroupSessionDetached('s1')).toBe(false);
  });

  // 2026-11-27 回归：进行中任务在 ACP 与智能路由间切换时，pending 目标必须覆盖 current 判断。
  // 生产入口：projectModelGroupSessionBinding / modelGroupBindingMatchesTarget；最小失败输入：
  // 1) 从 ACP 切入智能路由成员(current=acp, pending=codex 成员)应返回 pendingSwitch:true；
  // 2) 从智能路由成员手动改切 ACP(current=codex 成员, pending=acp)不得继续按 current 返回托管态。
  it('uses pending switch target to project managed state across ACP and smart-route transitions', () => {
    bindModelGroupSession('s-pending', { type: 'route', id: 'r1' }, CURRENT, 10);
    const stored = readModelGroupSessionBinding('s-pending');
    const config = { routes: [route('order')] };
    const acpTarget = { agentKind: 'acp', providerId: 'acp-plugin:echo:echo', model: 'default' };
    const codexMember = { agentKind: 'codex', providerId: 'acct-a', model: 'gpt' };

    expect(projectModelGroupSessionBinding({
      binding: stored,
      config,
      current: acpTarget,
      pending: codexMember,
    })).toEqual({
      selection: { type: 'route', id: 'r1' },
      routeName: '主力编程',
      autoSwitch: true,
      pendingSwitch: true,
    });

    expect(projectModelGroupSessionBinding({
      binding: stored,
      config,
      current: codexMember,
      pending: acpTarget,
    })).toBeNull();

    expect(modelGroupBindingMatchesTarget('s-pending', codexMember)).toBe(true);
    expect(modelGroupBindingMatchesTarget('s-pending', acpTarget)).toBe(false);
  });

  // 2026-11-27 回归：
  // 1) 从智能路由成员手动登记切到 ACP(applyNow=false)时，必须立即解绑智能路由并通知刷新；
  // 2) 从 ACP 切入智能路由成员后，下一条消息落地(applyPendingAgentSwitchIfIdle)必须保留绑定而非误解绑。
  it('unbinds on manual pending switch to ACP and preserves binding when landing a routed switch from ACP', async () => {
    const pendingSwitches = createPendingAgentSwitchRegistry();
    let row: {
      id: string;
      agentKind: 'cc' | 'codex' | 'pi' | 'acp';
      model: string;
      providerId: string | null;
      status: 'active';
      remoteHostId: null;
      orcaRole: null;
      sdkSessionId: string | null;
    } = {
      id: 's-switch',
      agentKind: 'codex',
      model: 'gpt',
      providerId: 'acct-a',
      status: 'active',
      remoteHostId: null,
      orcaRole: null,
      sdkSessionId: null,
    };
    const deps: MakerSessionAgentSwitchHandlerDeps = {
      getSessionRow: async () => row,
      getLiveSession: () => null,
      closeSession: async () => {},
      listMessagesForHandoff: async () => [],
      findParkedEngineSession: async () => null,
      applyAgentSwitchToDb: async (_sid, patch) => {
        row = {
          ...row,
          agentKind: patch.agentKind,
          model: patch.model,
          providerId: patch.providerId ?? null,
        };
      },
      setSessionProvider: () => {},
      insertBoundaryMessage: async () => 'boundary-1',
      applyResumeFallbackAtomically: async () => {},
      setPendingHandoff: () => {},
      readPendingHandoffGeneration: () => 0,
      bootstrapSwitchedSession: async () => {},
      withCloseSuppressed: async (_sid, fn) => fn(),
      admitPluginEngineTarget: (input) => ({
        engineKey: 'echo:echo',
        engineName: 'Echo ACP',
        providerId: input.providerId,
        model: input.model || 'default',
        effort: '',
        permissionMode: 'auto',
      }),
      pendingSwitches,
      log: { info: vi.fn(), warn: vi.fn() },
    };

    // 1) 手动从已托管的 Codex 切到 ACP（仅登记意图，未发送）→ 立即解绑。
    bindModelGroupSession('s-switch', { type: 'route', id: 'r1' }, CURRENT, 20);
    expect(readModelGroupSessionBinding('s-switch')).not.toBeNull();
    await performSessionAgentSwitch(deps, {
      sessionId: 's-switch',
      targetAgentKind: 'acp',
      providerId: 'acp-plugin:echo:echo',
      model: 'default',
    });
    expect(readModelGroupSessionBinding('s-switch')).toBeNull();

    // 2) 落地切到 ACP 后，再经智能路由切回 Codex（先登记意图 + 写绑定，再随下一条消息落地）→ 保留绑定。
    await applyPendingAgentSwitchIfIdle(deps, 's-switch');
    expect(row.agentKind).toBe('acp');
    await performSessionAgentSwitch(deps, {
      sessionId: 's-switch',
      targetAgentKind: 'codex',
      providerId: 'acct-a',
      model: 'gpt',
    });
    bindPendingRoute(pendingSwitches, 's-switch', { agentKind: 'codex', providerId: 'acct-a', model: 'gpt' });
    await applyPendingAgentSwitchIfIdle(deps, 's-switch');
    expect(row.agentKind).toBe('codex');
    expect(readModelGroupSessionBinding('s-switch')).toMatchObject({
      selection: { type: 'route', id: 'r1' },
      pickedKey: CURRENT,
    });
  });

  // Unit, model-groups.md §4.4: the first send after selecting an already running
  // remote member must distinguish a direct pick from an explicit smart route bind.
  it.each([
    { agentDeviceId: undefined, routed: false },
    { agentDeviceId: 'computer-a', routed: true },
  ])('lands a same-model selection with $agentDeviceId (routed=$routed)', async ({ agentDeviceId, routed }) => {
    const sessionId = 's-remote';
    const current = { agentKind: 'codex' as const, providerId: 'acct-a', model: 'gpt', agentDeviceId };
    const selection = { type: 'route' as const, id: 'r1' };
    const pickedKey = modelGroupCandidateKey(current);
    bindModelGroupSession(sessionId, selection, pickedKey);
    const pendingSwitches = createPendingAgentSwitchRegistry();
    pendingSwitches.set(sessionId, {
      targetAgentKind: 'codex', providerId: current.providerId, model: current.model, sameAgentSelection: true,
    });
    if (routed) bindPendingRoute(pendingSwitches, sessionId, current);
    expect(Boolean(projectModelGroupSessionBinding({
      binding: readModelGroupSessionBinding(sessionId),
      config: { routes: [route('order')] },
      current,
      pending: projectPendingModelGroupTarget(pendingSwitches.get(sessionId)),
    }))).toBe(routed);
    const deps: MakerSessionAgentSwitchHandlerDeps = {
      pendingSwitches,
      getSessionRow: async () => ({
        id: sessionId, ...current, status: 'active', remoteHostId: null, orcaRole: null, sdkSessionId: null,
      }),
      getLiveSession: () => null,
      closeSession: async () => {},
      listMessagesForHandoff: async () => [],
      applyAgentSwitchToDb: async () => {},
      setSessionProvider: () => {},
      insertBoundaryMessage: async () => 'boundary-1',
      applyResumeFallbackAtomically: async () => {},
      setPendingHandoff: () => {},
      bootstrapSwitchedSession: async () => {},
      withCloseSuppressed: async (_id, run) => run(),
      selectSameAgentModel: async (_id, intent) => {
        if (!intent.preserveModelGroupBinding) unbindModelGroupSession(sessionId);
        return { deferred: false };
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    await applyPendingAgentSwitchIfIdle(deps, sessionId);
    expect(Boolean(readModelGroupSessionBinding(sessionId))).toBe(routed);
  });

  // #13658 review (unit): the task row has only the base route, but recovery needs
  // to recognize the binding and preserve the suffix when the provider has several accounts.
  it('keeps the selected account when matching an ordinary task for recovery', async () => {
    const pickedKey = modelGroupCandidateKey({ ...CANDIDATES[0]!, accountId: 'first' });
    const selection = { type: 'route', id: 'r1' } as const;
    bindModelGroupSession('ordinary', selection, pickedKey, 10);
    expect(await readActiveModelGroupBindingForDispatch('ordinary', ROW)).toEqual({ selection, pickedKey, at: 10 });
    expect(await readActiveModelGroupBindingForDispatch('ordinary', { ...ROW, agentDeviceId: 'other-device' })).toBeNull();
    expect(await readActiveModelGroupBindingForDispatch('ordinary', { ...ROW, model: 'gpt-mini' })).toBeNull();
  });

  // #13658 review (unit): during pre-send account handoff, the production dispatch lookup
  // must see the target account inside eager bootstrap, while a rejected switch keeps the old one.
  it.each([false, true])('publishes the account at the pre-send switch commit (committed=%s)', async committed => {
    const sessionId = 'presend-account';
    const selection = { type: 'route', id: 'r1' } as const;
    bindModelGroupSession(sessionId, selection, modelGroupCandidateKey({ ...CANDIDATES[0]!, accountId: 'first' }), 10);
    const bootstrapAccount = vi.fn();
    const result = await runModelGroupBeforeSend({
      readSession: async () => ROW,
      evaluateTurnRouting: async () => ({
        action: 'switch', selection, groupName: 'OpenAI', cause: 'preflight-unavailable',
        target: { ...CANDIDATES[0]!, accountId: 'second', agentDeviceId: null },
        fromLabel: 'first', toLabel: 'second', crossEngine: false, crossLocation: false, crossAccount: true,
      }),
      applySameEngineRoute: vi.fn(async () => ({})),
      performCrossSwitch: async ({ commitLocalRoute, skipBootstrap }) => {
        expect(skipBootstrap).toBe(false);
        if (committed) {
          commitLocalRoute?.();
          bootstrapAccount(await readModelGroupRoutedAccount(sessionId, ROW.providerId!));
        }
        return { switched: committed };
      },
    }, sessionId, { bootstrapAfterSwitch: true });
    expect(result.switched).toBe(committed);
    expect(bootstrapAccount.mock.calls).toEqual(committed ? [['second']] : []);
    expect(await readModelGroupRoutedAccount(sessionId, ROW.providerId!)).toBe(committed ? 'second' : 'first');
  });

  // 本机新任务首发不能把已归并旧 ID 当接手来源；只有原生线程已有轮次时才能保留当前旧来源。
  // unit，实际 resolver → 持久路由绑定 → 发送前执行器；最小输入是 A 可选、B 关闭、B 的旧入口仍打开。
  it.each(['saved', 'auto:openai'])('respects account switches at first dispatch of %s', async (id) => {
    const a = { agentKind: 'codex', providerId: 'openai', accountId: 'a', model: 'gpt' } as const;
    const oldB = { agentKind: 'codex', providerId: 'old-b', model: 'gpt' } as const;
    const group: ModelGroupRoute = {
      id, name: 'OpenAI', strategy: 'order',
      candidates: [oldB, { ...a, accountId: 'b', off: true }, a],
    };
    const config = () => ({ routes: [group] });
    const view = (providerId: string) => ({
      id: providerId, name: providerId, connected: true, source: 'user', agents: ['codex'],
      routing: { codex: { enabled: true } },
      models: { codex: [{ id: 'gpt', name: 'GPT', efforts: [] }] },
    }) as unknown as ProviderView;
    const resolver = createModelGroupResolver({
      config,
      views: async () => [view('openai'), { ...view('old-b'), subscriptionPoolAlias: true }],
      agents: () => ['codex'], harnessInstalled: async () => true,
      localAccount: (_id, accountId) => ({ available: true, label: accountId }),
      // 发前可能读到不同的 cached quota；即使 A 触发预检，也不能以关闭的 B 为后备。
      quotaWindows: async (options) => new Map([
        [modelGroupQuotaKey(undefined, 'openai', 'a'), used(options?.cached ? 100 : 10)],
      ]),
      scope: () => 'owner', now: () => NOW,
    });
    const selection = { type: 'route', id } as const;
    const resolved = await resolver.resolve({ selection });
    expect(resolved).toMatchObject({ outcome: 'routed', route: a });
    if (resolved.outcome !== 'routed') throw new Error('Expected initial route');
    bindModelGroupSession('new', selection, modelGroupCandidateKey(resolved.route), NOW);
    bindModelGroupSession('old', selection, modelGroupCandidateKey(oldB), NOW - HOUR);
    const applySameEngineRoute = vi.fn(async () => ({ persistedRoute: true }));
    const performCrossSwitch = vi.fn(async () => ({ switched: true }));
    const pinLocalSource = vi.fn();
    const run = (sessionId: string, row: RunModelGroupBeforeSendSessionRow) =>
      runModelGroupBeforeSend({
        readSession: async () => row,
        evaluateTurnRouting: (sid, current, turn) => evaluateModelGroupBeforeSend({
          readBinding: readModelGroupBindingForDispatch, config,
          candidateFacts: resolver.candidateFacts, now: () => NOW,
        }, sid, current, turn),
        applySameEngineRoute, performCrossSwitch, pinLocalSource,
      }, sessionId);
    expect(await run('new', { ...a, sdkSessionId: 'bootstrap-without-turn' })).toEqual({ switched: false });
    expect(await readModelGroupRoutedAccount('new', 'openai')).toBe('a');
    expect(pinLocalSource).not.toHaveBeenCalled();
    expect(applySameEngineRoute).not.toHaveBeenCalled();
    expect(performCrossSwitch).not.toHaveBeenCalled();

    // 已执行的同线程旧绑定继续可用，即使 A 现在可接手。
    const historyDeps: Parameters<typeof evaluateModelGroupBeforeSend>[0] = {
      readBinding: readModelGroupBindingForDispatch, config,
      candidateFacts: (route: ModelGroupRoute, context, options) => resolver.candidateFacts(route, context, { ...options, cachedQuota: false }),
      now: () => NOW,
    };
    expect(await evaluateModelGroupBeforeSend(historyDeps, 'old', {
      ...oldB, sdkSessionId: 'existing-thread', lastTurnEndedAt: NOW - 1,
    })).toEqual({ action: 'keep', reason: 'cache-warm' });
    expect(await evaluateModelGroupBeforeSend(historyDeps, 'old', {
      ...oldB, sdkSessionId: 'bootstrap-without-turn',
    })).toMatchObject({ action: 'switch', target: a });
    // 同账号远程明确开放的当前入口不是新的接手目标，首轮照样能使用。
    expect(await evaluateModelGroupBeforeSend(historyDeps, 'old', {
      ...oldB, sdkSessionId: 'bootstrap-without-turn',
    }, { currentRemoteSourceAdmitted: true })).toEqual({ action: 'keep', reason: 'cache-warm' });
  });

  it('persists detached state for companion sessions so bot profile modelGroup does not re-manage them', async () => {
    // Companion session had no explicit session binding (implicitly managed by bot profile).
    expect(await isModelGroupSessionDetachedForDispatch('bot-s1')).toBe(false);
    const readBotProfileModelGroup = vi.fn(async () => ({ type: 'route' as const, id: 'r1' }));
    const evaluateTurnRouting = vi.fn(async () => ({ action: 'keep' as const, reason: 'current-optimal' as const }));
    const run = () => runModelGroupBeforeSend({
      readSession: async () => ({ source: 'bot', agentKind: 'codex', providerId: 'acct-a', model: 'gpt' }),
      readBotProfileModelGroup,
      evaluateTurnRouting,
      applySameEngineRoute: vi.fn(async () => ({})),
      performCrossSwitch: vi.fn(async () => ({ switched: false })),
    }, 'bot-s1');

    await run();
    expect(readBotProfileModelGroup).toHaveBeenCalledTimes(1);
    expect(evaluateTurnRouting).toHaveBeenLastCalledWith(
      'bot-s1',
      expect.anything(),
      expect.objectContaining({ overrideSelection: { type: 'route', id: 'r1' } }),
    );

    // Detaching records a persistent tombstone even when no explicit binding existed.
    expect(unbindModelGroupSession('bot-s1')).toBe(false);
    expect(await isModelGroupSessionDetachedForDispatch('bot-s1')).toBe(true);
    await run();
    expect(readBotProfileModelGroup).toHaveBeenCalledTimes(1);
    expect(evaluateTurnRouting).toHaveBeenLastCalledWith(
      'bot-s1',
      expect.anything(),
      expect.objectContaining({ overrideSelection: null }),
    );

    // Explicitly re-binding clears the detached tombstone.
    bindModelGroupSession('bot-s1', { type: 'route', id: 'r1' }, CURRENT, 10);
    expect(await isModelGroupSessionDetachedForDispatch('bot-s1')).toBe(false);
  });
});

describe('evaluateModelGroupBeforeSend', () => {
  const turnDeps = (overrides: Parameters<typeof deps>[0] = {}) => {
    const base = deps(overrides);
    return {
      readBinding: base.readBinding,
      config: base.config,
      candidateFacts: base.candidateFacts,
      now: base.now,
    };
  };

  it('switches before send when the bound source is exhausted or unavailable (preflight)', async () => {
    const decision = await evaluateModelGroupBeforeSend(turnDeps(), 's1', {
      source: 'desktop', agentKind: 'codex', providerId: 'acct-a', model: 'gpt',
    }, { hasImages: false });
    expect(decision).toMatchObject({
      action: 'switch',
      cause: 'preflight-unavailable',
      crossEngine: false,
      target: { agentKind: 'codex', providerId: 'acct-b', model: 'gpt' },
    });
  });

  it('switches to a vision-capable source on an image turn when current source lacks vision', async () => {
    const d = turnDeps({
      facts: [
        { ...fact('A', used(10)), acceptsImage: false },
        { ...fact('A', used(10)), acceptsImage: false },
        { ...fact('Claude', used(10)), acceptsImage: true },
        { ...fact('B', used(10)), acceptsImage: true },
      ],
    });
    const decision = await evaluateModelGroupBeforeSend(d, 's1', {
      source: 'desktop', agentKind: 'codex', providerId: 'acct-a', model: 'gpt',
    }, { hasImages: true });
    expect(decision).toMatchObject({
      action: 'switch',
      cause: 'image-input',
      crossEngine: false,
      target: { providerId: 'acct-b', model: 'gpt' },
    });
  });

  it('protects warm prompt cache and re-evaluates only after cache expires', async () => {
    const healthyFacts = [
      { ...fact('A', used(80)), providerType: 'openai' },
      { ...fact('A', used(80)), providerType: 'openai' },
      { ...fact('Claude', used(30)), providerType: 'anthropic' },
      { ...fact('B', used(10)), providerType: 'openai' },
    ];
    const d = turnDeps({
      config: { routes: [route('headroom')] },
      facts: healthyFacts,
    });
    // 2 minutes since last turn -> cache still warm -> stay on current source
    expect(await evaluateModelGroupBeforeSend(d, 's1', {
      source: 'desktop', agentKind: 'codex', providerId: 'acct-a', model: 'gpt',
      lastTurnEndedAt: NOW - 2 * 60_000,
    }, { hasImages: false })).toEqual({ action: 'keep', reason: 'cache-warm' });
    // 6 minutes since last turn -> cache expired -> re-evaluate and pick higher remaining quota
    expect(await evaluateModelGroupBeforeSend(d, 's1', {
      source: 'desktop', agentKind: 'codex', providerId: 'acct-a', model: 'gpt',
      lastTurnEndedAt: NOW - 6 * 60_000,
    }, { hasImages: false })).toMatchObject({
      action: 'switch',
      cause: 'cache-expired',
      target: { providerId: 'acct-b' },
    });
  });

  it('prefers a candidate whose contextWindow fits current contextTokens', async () => {
    const d = turnDeps({
      facts: [
        { ...fact('A', used(100)), contextWindow: 200_000 },
        { ...fact('A', used(100)), contextWindow: 200_000 },
        { ...fact('Claude', used(10)), contextWindow: 200_000 },
        { ...fact('B', used(10)), contextWindow: 64_000 },
      ],
    });
    const decision = await evaluateModelGroupBeforeSend(d, 's1', {
      source: 'desktop', agentKind: 'codex', providerId: 'acct-a', model: 'gpt',
      contextTokens: 100_000,
    }, { hasImages: false });
    // Should prefer Claude (200k window fits 100k context) over B (64k window doesn't fit)
    expect(decision).toMatchObject({
      action: 'switch',
      cause: 'preflight-unavailable',
      target: { providerId: 'anthropic' },
    });
  });

  // 2026-11-28 回归：本机多账号拆平后，账号 1 撞配额时能从 DB 会话行（无 accountId 列）匹配账号后缀绑定，
  // 并直接提议/切换到同供应商下的账号 2，不再把同 providerId 的其余账号一并判成同一份已满配额。
  it('fails over from an exhausted flat local account to the sibling account on the same provider', async () => {
    const flatRoute: ModelGroupRoute = {
      id: 'src:openai-gpt',
      name: 'GPT-6.2',
      strategy: 'order',
      parent: { id: 'auto:openai', name: 'OpenAI' },
      candidates: [
        { agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2' },
        { agentKind: 'codex', providerId: 'openai', accountId: 'second', model: 'gpt-6.2' },
      ],
    };
    const pickedAccount1 = modelGroupCandidateKey({
      agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2',
    });
    const offer = await computeModelGroupSwitchOffer({
      readBinding: () => ({ selection: { type: 'route', id: 'src:openai-gpt' }, pickedKey: pickedAccount1, at: NOW }),
      readSession: async () => ({ source: 'desktop', agentKind: 'codex', providerId: 'openai', model: 'gpt-6.2' }),
      isShared: () => false,
      hasGoal: async () => false,
      config: () => ({ routes: [flatRoute] }),
      candidateFacts: async () => [
        { available: true, modelName: 'GPT-6.2', sourceName: 'OpenAI · first@example.com', windows: [{ usedPercent: 100, resetAtMs: NOW + 60_000, windowMs: 18_000_000 }] },
        { available: true, modelName: 'GPT-6.2', sourceName: 'OpenAI · second@example.com', windows: [{ usedPercent: 15, resetAtMs: NOW + 60_000, windowMs: 18_000_000 }] },
      ],
      now: () => NOW,
    }, 's-flat-1');
    expect(offer).toMatchObject({
      providerId: 'openai',
      accountId: 'second',
      sourceName: 'OpenAI · second@example.com',
      crossEngine: false,
    });
  });
});
