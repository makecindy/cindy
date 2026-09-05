import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import type { MobileModelOption } from '@/session/agentCapabilities';
import {
  DEFAULT_NEW_SESSION_DRAFT,
  NEW_SESSION_AGENT_OPTIONS,
  availableNewSessionAgentOptions,
  buildNewSessionCreatePreview,
  buildRecentWorkspaceOptions,
  buildRemoteCreateSessionOptions,
  filterRemoteDirectoryEntries,
  defaultPermissionModeForNewSessionAgent,
  normalizeCreateSessionResult,
  parseNewSessionDeviceOptions,
  parseExtraDirsInput,
  pickAgentDefaultRuntime,
  pickInitialNewSessionWorkspace,
  pickMostRecentSessionRuntime,
  pickNewSessionDefaultDevice,
  resolveNewSessionAutoDefault,
  resolveRecentModelAndProvider,
  resolveSubmitGuardCatalog,
  resolveStartedDowngradeOrCommit,
  sessionFromCreateResult,
  compensatePrecreatedWorktree,
  reconcileEffortAfterFallback,
  serializeNewSessionDeviceOptions,
  summarizeNewSessionDraft,
  validateModelProviderId,
  validateNewSessionDraft,
  withAgentDefaults,
} from '@/session/newSession';
import type { DeviceProvidersPayload } from '@/device-link/deviceProvidersCache';
import type { ProviderModelRow } from '@/session/providerModelSections';
import type { RemoteSession } from '@/session/types';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function modelRow(
  id: string,
  efforts: readonly string[] = [],
  defaultEffort: string | null = null,
  newSessionDefault?: readonly ('claude-code' | 'codex' | 'pi')[],
): ProviderModelRow {
  return {
    provider: { id: `prov-${id}`, name: id } as ProviderModelRow['provider'],
    model: {
      id,
      displayName: id,
      efforts: efforts as ProviderModelRow['model']['efforts'],
      defaultEffort: defaultEffort as ProviderModelRow['model']['defaultEffort'],
      contextWindow: 0,
      ...(newSessionDefault ? { newSessionDefault: [...newSessionDefault] } : {}),
    },
  };
}

function remoteSession(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id,
    userId: 'u1',
    title: id,
    workingDir: '/repo/app',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

// 异步时序测试工具(文件级,供多个 describe 共用)。
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};

describe('pickMostRecentSessionRuntime', () => {
  it('picks the most recent session runtime (agent+model+effort), cc → claude-code', () => {
    const runtime = pickMostRecentSessionRuntime([
      remoteSession('old', { model: 'claude-opus-4-8', effort: 'high', userSendAt: '2026-01-01T00:00:01.000Z' }),
      remoteSession('new', { model: 'gpt-5.4', effort: 'low', agentKind: 'codex', userSendAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low', providerId: null });
  });

  it('carries the recent session providerId (null = default route when unset)', () => {
    const runtime = pickMostRecentSessionRuntime([
      remoteSession('bound', { model: 'deepseek-v4-flash', providerId: 'deepseek', userSendAt: '2026-01-02T00:00:00.000Z' }),
      remoteSession('unbound', { model: 'gpt-5.4', agentKind: 'codex', userSendAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'deepseek-v4-flash', effort: 'medium', providerId: 'deepseek' });
  });

  it('maps cc agentKind to claude-code', () => {
    const runtime = pickMostRecentSessionRuntime([remoteSession('a', { agentKind: 'cc', model: 'claude-sonnet-4-6' })]);
    expect(runtime?.agentKind).toBe('claude-code');
  });

  it('sorts by activity time = userSendAt ?? updatedAt ?? createdAt (desc)', () => {
    const runtime = pickMostRecentSessionRuntime([
      remoteSession('viaUpdated', { model: 'm-updated', userSendAt: null, updatedAt: '2026-01-03T00:00:00.000Z' }),
      remoteSession('viaSend', { model: 'm-send', userSendAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(runtime?.model).toBe('m-updated'); // updatedAt 2026-01-03 > userSendAt 2026-01-02
  });

  it('excludes deleted sessions and sessions without a model', () => {
    expect(pickMostRecentSessionRuntime([
      remoteSession('del', { status: 'deleted', model: 'x', userSendAt: '2026-09-09T00:00:00.000Z' }),
      remoteSession('nomodel', { model: '   ', userSendAt: '2026-09-09T00:00:00.000Z' }),
      remoteSession('ok', { model: 'kept', userSendAt: '2026-01-01T00:00:00.000Z' }),
    ])?.model).toBe('kept');
  });

  it('filters by deviceId (only sessions on the target device; sessions without deviceId are not excluded)', () => {
    const sessions = [
      remoteSession('other', { model: 'other-dev', deviceLinkDeviceId: 'devB', userSendAt: '2026-05-05T00:00:00.000Z' }),
      remoteSession('target', { model: 'target-dev', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(pickMostRecentSessionRuntime(sessions, { deviceId: 'devA' })?.model).toBe('target-dev');
  });

  it('filters by agentKind', () => {
    const sessions = [
      remoteSession('cc1', { model: 'claude-x', agentKind: 'cc', userSendAt: '2026-05-05T00:00:00.000Z' }),
      remoteSession('codex1', { model: 'gpt-x', agentKind: 'codex', userSendAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(pickMostRecentSessionRuntime(sessions, { agentKind: 'codex' })?.model).toBe('gpt-x');
  });

  it('returns null when no session matches', () => {
    expect(pickMostRecentSessionRuntime([])).toBeNull();
    expect(pickMostRecentSessionRuntime([remoteSession('del', { status: 'deleted' })])).toBeNull();
  });
});

describe('reconcileEffortAfterFallback', () => {
  it('keeps the base effort when the fallback model supports it', () => {
    const rows = [modelRow('claude-sonnet-4-6', ['low', 'medium', 'high'], 'medium')];
    expect(reconcileEffortAfterFallback(rows, { model: 'claude-sonnet-4-6', providerId: 'prov-claude-sonnet-4-6' }, 'high')).toBe('high');
  });

  it('drops to the fallback model default when the base effort is unsupported (codex P2)', () => {
    const rows = [modelRow('claude-haiku', ['low'], 'low')];
    expect(reconcileEffortAfterFallback(rows, { model: 'claude-haiku', providerId: 'prov-claude-haiku' }, 'xhigh')).toBe('low');
  });

  it('omits effort when no catalog row matches (built-in default fallback, Codex P2: 不沿用旧模型档位)', () => {
    expect(reconcileEffortAfterFallback([], { model: 'claude-sonnet-4-6', providerId: null }, 'high')).toBe('');
  });
});

describe('validateModelProviderId', () => {
  const rows = [modelRow('deepseek-v4-flash', ['low', 'medium'], 'medium')];

  it('null / undefined providerId → null', () => {
    expect(validateModelProviderId(rows, null, 'deepseek-v4-flash', true)).toBeNull();
    expect(validateModelProviderId(rows, undefined, 'deepseek-v4-flash', true)).toBeNull();
  });

  it('catalog not ready → trust the binding as-is (terminal truth is the controlled end)', () => {
    expect(validateModelProviderId([], 'deepseek', 'deepseek-v4-flash', false)).toBe('deepseek');
    expect(validateModelProviderId(rows, 'prov-anything', 'm', false)).toBe('prov-anything');
  });

  it('catalog ready + matching (provider, model) row → keep', () => {
    expect(validateModelProviderId(rows, 'prov-deepseek-v4-flash', 'deepseek-v4-flash', true)).toBe('prov-deepseek-v4-flash');
  });

  it('catalog ready + no matching row → clear to default route (incl. loaded-but-empty)', () => {
    expect(validateModelProviderId(rows, 'prov-gone', 'deepseek-v4-flash', true)).toBeNull();
    expect(validateModelProviderId([], 'deepseek', 'deepseek-v4-flash', true)).toBeNull();
    // provider 仍在但不再提供该模型 → 同样清空(不匹配 modelId)
    expect(validateModelProviderId(rows, 'prov-deepseek-v4-flash', 'other-model', true)).toBeNull();
  });
});

describe('resolveSubmitGuardCatalog —— 提交终检目录取信(代际安全,独立 review P1-1)', () => {
  const rowsOf = (id: string) => [modelRow(id, ['low'], 'low')];
  type TestPayload = { id: string; providers: never[] };
  const payload = (id: string): TestPayload => ({ id, providers: [] });
  const baseArgs = {
    gen: () => 1,
    cached: () => undefined as TestPayload | undefined,
    fetch: () => Promise.resolve(payload('fetched')),
    buildRows: (pl: DeviceProvidersPayload) => rowsOf((pl as TestPayload).id),
  };

  it('缓存命中 → join fetch revalidate,成功用新目录(工作站已换 provider,codex review P1)', async () => {
    const fetchSpy = vi.fn(baseArgs.fetch);
    const res = await resolveSubmitGuardCatalog({
      ...baseArgs,
      cached: () => payload('cached'),
      fetch: fetchSpy,
    });
    // 缓存命中不再直接采信:与新鲜响应 revalidate(缓存层 inflight 去重),成功用新目录
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ rows: rowsOf('fetched'), catalogKnown: true });
  });

  it('缓存命中 + fetch 失败 → 回退缓存命中(历史知识优于未知,保持 fail-open)', async () => {
    const res = await resolveSubmitGuardCatalog({
      ...baseArgs,
      cached: () => payload('cached'),
      fetch: () => Promise.reject(new Error('revalidate down')),
    });
    expect(res).toMatchObject({ rows: rowsOf('cached'), catalogKnown: true });
  });

  it('冷启动(gen=0)+ 无缓存 → join 首轮拉取(不重复发请求),成功按新目录校验(Codex P2)', async () => {
    const fetchSpy = vi.fn(baseArgs.fetch);
    const res = await resolveSubmitGuardCatalog({ ...baseArgs, gen: () => 0, fetch: fetchSpy });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ rows: rowsOf('fetched'), catalogKnown: true });
  });

  it('冷启动(gen=0)+ 首轮拉取失败 → 未知 → 信任(fail-open 语义保持)', async () => {
    const res = await resolveSubmitGuardCatalog({
      ...baseArgs,
      gen: () => 0,
      fetch: () => Promise.reject(new Error('first load down')),
    });
    expect(res).toMatchObject({ rows: [], catalogKnown: false });
  });

  it('曾驱逐(gen>0)+ 无缓存 → join 在途重拉,代际稳定时采信新 payload', async () => {
    const res = await resolveSubmitGuardCatalog(baseArgs);
    expect(res).toMatchObject({ rows: rowsOf('fetched'), catalogKnown: true });
  });

  it('await 期间二次驱逐(gen g1→g2)→ 弃用 g1 旧 promise 返回值,join 新代第二次 fetch', async () => {
    // 独立 review P1-1 窗口:缓存层只拒绝旧响应回写、仍 resolve 旧 payload——
    // 调用方不得消费它;必须核对代际后 join 新代。
    let gen = 1;
    const d1 = deferred<TestPayload>();
    const fetchSpy = vi.fn(() => {
      const g = gen;
      return g === 1 ? d1.promise : Promise.resolve(payload('g2'));
    });
    const pending = resolveSubmitGuardCatalog({ ...baseArgs, gen: () => gen, fetch: fetchSpy });
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    gen = 2; // 二次驱逐
    d1.resolve(payload('g1')); // g1 最后才 resolve → 返回值必须被弃用
    const res = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ rows: rowsOf('g2'), catalogKnown: true });
  });

  it('fetch 失败且代际稳定 → catalogKnown=false(unknown fail-open 信任)', async () => {
    const res = await resolveSubmitGuardCatalog({
      ...baseArgs,
      fetch: () => Promise.reject(new Error('boom')),
    });
    expect(res).toMatchObject({ rows: [], catalogKnown: false });
  });

  it('fetch 失败但期间换代 → 重试 join 新代;第二次成功则采信', async () => {
    let gen = 1;
    const d1 = deferred<TestPayload>();
    const fetchSpy = vi.fn(() => (gen === 1 ? d1.promise : Promise.resolve(payload('g2'))));
    const pending = resolveSubmitGuardCatalog({ ...baseArgs, gen: () => gen, fetch: fetchSpy });
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    gen = 2; // 换代后再失败 → 旧代失败不终止,重试新代
    d1.reject(new Error('boom'));
    const res = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ rows: rowsOf('g2'), catalogKnown: true });
  });

  it('代际持续抖动(循环上限)→ 放弃校验,catalogKnown=false(信任既有绑定)', async () => {
    let gen = 1;
    const d = deferred<TestPayload>();
    const fetchSpy = vi.fn(() => {
      gen += 1; // 每次 await 期间都换代
      return d.promise;
    });
    const pending = resolveSubmitGuardCatalog({ ...baseArgs, gen: () => gen, fetch: fetchSpy });
    await flush();
    d.resolve(payload('stale'));
    const res = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 循环上限 3
    expect(res).toMatchObject({ rows: [], catalogKnown: false });
  });
});

describe('pickAgentDefaultRuntime', () => {
  it('follows the target agent\'s most recent session model + effort (reconciled)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [
        remoteSession('cc', { agentKind: 'cc', model: 'claude-opus-4-8', userSendAt: '2026-02-02T00:00:00.000Z' }),
        remoteSession('cx', { agentKind: 'codex', model: 'gpt-5.4', effort: 'high', userSendAt: '2026-01-01T00:00:00.000Z' }),
      ],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium', 'high'], 'medium')],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 历史坏数据自愈(copilot P2):providerId 空但目录有同名行 → 补全为该行 provider
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'high', providerId: 'prov-gpt-5.4' });
  });

  it('reconciles the recent effort down to the model default when unsupported', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-5.4', effort: 'xhigh', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 历史坏数据自愈(copilot P2):providerId 空但目录有同名行 → 补全为该行 provider
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low', providerId: 'prov-gpt-5.4' });
  });

  it('omits the effort when the catalog is ready but the model has no row (delisted → omit, codex P2)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-legacy', effort: 'high', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 目录就绪且无匹配行 → 省略 effort(旧自定义档位对内置默认无效,由被控端取默认)
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-legacy', effort: '', providerId: null });
  });

  it('keeps the recent effort while the catalog is not ready (no authoritative section model yet)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-legacy', effort: 'high', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [],
      currentEffort: 'medium',
      catalogReady: false,
    });
    // 目录未就绪 → 保留最近任务 effort(未知不得省略,信任既有绑定)
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-legacy', effort: 'high', providerId: null });
  });

  it('inherits the recent session providerId when that provider still offers the model (#1898)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', providerId: 'prov-deepseek-v4-flash', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('deepseek-v4-flash', ['low', 'medium'], 'medium')],
      currentEffort: 'medium',
      catalogReady: true,
    });
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'deepseek-v4-flash', effort: 'medium', providerId: 'prov-deepseek-v4-flash' });
  });

  it('reroutes to another connected provider offering the same model when the recent provider is gone (codex P1)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', providerId: 'prov-deleted', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('deepseek-v4-flash', ['low', 'medium'], 'medium')],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 来源失效但仍有其他来源提供同模型 → 顶替为该来源,模型照用(不留裸模型回落默认网关)
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'deepseek-v4-flash', effort: 'medium', providerId: 'prov-deepseek-v4-flash' });
  });

  it('reroutes by agent default rule when the recent provider is gone and multiple sources offer the model (codex P2)', () => {
    // 显式来源失效 + 同名模型多来源:不得取目录首行(custom 排前面)——按 agent
    // 默认规则解析(effectiveSourceIdForModel,codex 优先 openai 其次 xd),与
    // null 分支/模型面板高亮同口径,避免悄然改用另一套凭证/计费/Fast 语义。
    const fullRow = (providerId: string, connected = true): ProviderModelRow => ({
      provider: {
        id: providerId,
        name: providerId,
        agents: ['codex'],
        routing: { codex: {} },
        connected,
        models: { codex: [{ id: 'gpt-5.4', name: 'gpt-5.4' }] },
      } as unknown as ProviderModelRow['provider'],
      model: {
        id: 'gpt-5.4',
        displayName: 'gpt-5.4',
        efforts: ['low', 'medium'],
        defaultEffort: 'medium',
        contextWindow: 0,
      },
    });
    expect(
      resolveRecentModelAndProvider(
        [fullRow('custom'), fullRow('xd')],
        { model: 'gpt-5.4', providerId: 'prov-deleted' },
        'codex',
        true,
      ),
    ).toEqual({ model: 'gpt-5.4', providerId: 'xd' });
    // 全部来源不可路由(未连接)→ 解析不到 → 落目录首项(整体回退)
    expect(
      resolveRecentModelAndProvider(
        [fullRow('custom', false), fullRow('xd', false)],
        { model: 'gpt-5.4', providerId: 'prov-deleted' },
        'codex',
        true,
      ),
    ).toEqual({ model: 'gpt-5.4', providerId: 'custom' });
  });

  it('falls back to the catalog top row (with its provider) when no provider offers the recent model', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'delisted-model', providerId: 'prov-deleted', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'low'), modelRow('claude-haiku', ['low'], 'low')],
      currentEffort: 'high',
      catalogReady: true,
    });
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'claude-sonnet-4-6', effort: 'medium', providerId: 'prov-claude-sonnet-4-6' });
  });

  it('falls back to DEFAULT_MODELS + default route when the catalog is ready but empty and the provider is gone', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('ds', { agentKind: 'codex', model: 'delisted-model', providerId: 'prov-deleted', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 回退内置默认且目录为空 → 省略 effort(codex P2:旧自定义档位对内置模型无效)
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: '', providerId: null });
  });

  it('trusts the recent providerId while modelRows are still loading (empty)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', providerId: 'deepseek', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [],
      currentEffort: 'medium',
      catalogReady: false,
    });
    expect(runtime.providerId).toBe('deepseek');
  });

  it('falls back the model together when the catalog is ready but empty (loaded ≠ loading, codex P1)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', providerId: 'deepseek', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 目录就绪但为空:来源失效且无人能提供该模型 → model 一并回退内置默认(不留裸模型)
    // + 省略 effort(codex P2:旧自定义档位对内置模型无效)
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'claude-sonnet-4-6', effort: '', providerId: null });
  });

  it('reconciles effort with the exact (providerId, modelId) row when multiple providers offer the same model (Copilot)', () => {
    const shared = (providerId: string, efforts: readonly string[], defaultEffort: string): ProviderModelRow => ({
      provider: { id: providerId, name: providerId } as ProviderModelRow['provider'],
      model: {
        id: 'shared-model',
        displayName: 'shared-model',
        efforts: efforts as ProviderModelRow['model']['efforts'],
        defaultEffort: defaultEffort as ProviderModelRow['model']['defaultEffort'],
        contextWindow: 0,
      },
    });
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('s', { agentKind: 'cc', model: 'shared-model', providerId: 'provB', effort: 'xhigh', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [shared('provA', ['low'], 'low'), shared('provB', ['high', 'xhigh'], 'high')],
      currentEffort: 'medium',
      catalogReady: true,
    });
    // 若误用 provA 的 SectionModel,xhigh 会被降档为 low;精确匹配 provB 行则保留
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'shared-model', effort: 'xhigh', providerId: 'provB' });
  });

  it('keeps the recent effort untouched when the catalog is not ready and only a stale same-model row exists (codex P2)', () => {
    const shared = (providerId: string, efforts: readonly string[], defaultEffort: string): ProviderModelRow => ({
      provider: { id: providerId, name: providerId } as ProviderModelRow['provider'],
      model: {
        id: 'shared-model',
        displayName: 'shared-model',
        efforts: efforts as ProviderModelRow['model']['efforts'],
        defaultEffort: defaultEffort as ProviderModelRow['model']['defaultEffort'],
        contextWindow: 0,
      },
    });
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [remoteSession('s', { agentKind: 'cc', model: 'shared-model', providerId: 'provB', effort: 'xhigh', userSendAt: '2026-01-01T00:00:00.000Z' })],
      // 目录未就绪时的残留行:只有 provA 提供同 modelId,provB 不在其中
      modelRows: [shared('provA', ['low'], 'low')],
      currentEffort: 'medium',
      catalogReady: false,
    });
    // 目录未知 → 不得用残留 provA 行的档位表把 xhigh 降档;保留最近任务的 effort
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'shared-model', effort: 'xhigh', providerId: 'provB' });
  });

  it('falls back to the top of the target agent\'s model list when it has no recent session', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cc', { agentKind: 'cc', model: 'claude-opus-4-8', userSendAt: '2026-02-02T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low'), modelRow('gpt-mini', ['low'], 'low')],
      currentEffort: 'high', // 不被目标模型支持 → reconcile 到默认 'low'
      catalogReady: true,
    });
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low', providerId: 'prov-gpt-5.4' });
  });

  it('uses the regional default before the top row, including the explicit Pi v3 marker', () => {
    const rows = [
      modelRow('top', ['low'], 'low'),
      modelRow('cc-regional', ['medium'], 'medium', ['claude-code']),
      modelRow('pi-regional', ['high'], 'high', ['pi']),
    ];
    // 区域默认来自 provider 行 → 携带该行 provider(#1898 语义,merge main 后适配)
    expect(pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [],
      modelRows: rows,
      currentEffort: 'high',
      catalogReady: true,
    })).toEqual({ agentKind: 'claude-code', model: 'cc-regional', effort: 'medium', providerId: 'prov-cc-regional' });
    expect(pickAgentDefaultRuntime({
      agentKind: 'pi',
      sessions: [],
      modelRows: rows,
      currentEffort: 'high',
      catalogReady: true,
    })).toEqual({ agentKind: 'pi', model: 'pi-regional', effort: 'high', providerId: 'prov-pi-regional' });
  });

  it('uses only the explicit Pi regional default marker', () => {
    expect(pickAgentDefaultRuntime({
      agentKind: 'pi',
      sessions: [],
      modelRows: [
        modelRow('top', ['low'], 'low'),
        modelRow('pi-regional', ['high'], 'high', ['pi']),
      ],
      currentEffort: 'medium',
      catalogReady: true,
    })).toEqual({
      agentKind: 'pi',
      model: 'pi-regional',
      effort: 'high',
      providerId: 'prov-pi-regional',
    });
  });

  it('keeps the marked provider row when another provider offers the same modelId earlier (codex P2)', () => {
    const shared = (providerId: string, marked: boolean, efforts: readonly string[], defaultEffort: string): ProviderModelRow => ({
      provider: { id: providerId, name: providerId } as ProviderModelRow['provider'],
      model: {
        id: 'shared-model',
        displayName: 'shared-model',
        efforts: efforts as ProviderModelRow['model']['efforts'],
        defaultEffort: defaultEffort as ProviderModelRow['model']['defaultEffort'],
        contextWindow: 0,
        ...(marked ? { newSessionDefault: ['claude-code'] } : {}),
      },
    });
    // [A/foo(无标记), B/foo(标记)]:必须在行层面选中 B,携带 B 的来源并按其档位表校准
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [],
      modelRows: [shared('provA', false, ['low'], 'low'), shared('provB', true, ['high', 'xhigh'], 'high')],
      currentEffort: 'high',
      catalogReady: true,
    });
    expect(runtime).toEqual({ agentKind: 'claude-code', model: 'shared-model', effort: 'high', providerId: 'provB' });
  });

  it('falls back to DEFAULT_MODELS and omits effort when the catalog is ready but empty (codex P2)', () => {
    expect(pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [],
      modelRows: [],
      currentEffort: 'medium',
      catalogReady: true,
    })).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: '', providerId: null });
    expect(pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [],
      modelRows: [],
      currentEffort: 'high',
      catalogReady: true,
    })).toEqual({ agentKind: 'claude-code', model: 'claude-sonnet-4-6', effort: '', providerId: null });
  });

  it('skips the top-row branch while the catalog is not ready (stale rows from the previous device, codex P1)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
      catalogReady: false,
    });
    // 目录未就绪 → 不抄残留目录的首项,落内置默认 + 默认路由
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'medium', providerId: null });
    expect(runtime.providerId).toBeNull();
  });

  it('scopes the recent lookup to the selected device', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [
        remoteSession('other', { agentKind: 'codex', model: 'gpt-other', deviceLinkDeviceId: 'devB', userSendAt: '2026-05-05T00:00:00.000Z' }),
        remoteSession('target', { agentKind: 'codex', model: 'gpt-5.4', effort: 'low', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' }),
      ],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
      deviceId: 'devA',
      catalogReady: true,
    });
    // 历史坏数据自愈(copilot P2):providerId 空但目录有同名行 → 补全为该行 provider
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low', providerId: 'prov-gpt-5.4' });
  });

  it('never inherits a provider across devices (device filter wins before provider carry)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [
        remoteSession('onB', { agentKind: 'codex', model: 'gpt-5.4', providerId: 'prov-b', deviceLinkDeviceId: 'devB', userSendAt: '2026-05-05T00:00:00.000Z' }),
      ],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
      deviceId: 'devA',
      catalogReady: true,
    });
    // devB 的会话被设备过滤排除 → 落到列表首项分支,来源取该行的 provider,不串 devB 的 prov-b
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'medium', providerId: 'prov-gpt-5.4' });
  });

  it('resolves the default source by agent rule for a null providerId offered by multiple sources (codex review P2)', () => {
    // 同名模型由多个来源提供时,不得取目录首行(anthropic 在前)——被控端默认路由
    // 按 agent 解析(effectiveSourceIdForModel,codex 优先 openai 其次 xd),UI 高亮与
    // 创建路由必须一致;解析不到时保留 null 默认路由。
    const fullRow = (providerId: string, connected = true): ProviderModelRow => ({
      provider: {
        id: providerId,
        name: providerId,
        agents: ['codex'],
        routing: { codex: {} },
        connected,
        models: { codex: [{ id: 'gpt-5.4', name: 'gpt-5.4' }] },
      } as unknown as ProviderModelRow['provider'],
      model: {
        id: 'gpt-5.4',
        displayName: 'gpt-5.4',
        efforts: ['low', 'medium'],
        defaultEffort: 'medium',
        contextWindow: 0,
      },
    });
    expect(
      resolveRecentModelAndProvider(
        [fullRow('anthropic'), fullRow('xd')],
        { model: 'gpt-5.4', providerId: null },
        'codex',
        true,
      ),
    ).toEqual({ model: 'gpt-5.4', providerId: 'xd' });
    // 全部来源不可路由(未连接)→ 解析不到 → 保留 null 默认路由,不固化任何来源
    expect(
      resolveRecentModelAndProvider(
        [fullRow('anthropic', false), fullRow('xd', false)],
        { model: 'gpt-5.4', providerId: null },
        'codex',
        true,
      ),
    ).toEqual({ model: 'gpt-5.4', providerId: null });
  });
});

describe('resolveNewSessionAutoDefault', () => {
  const baseInput = {
    userTouched: false,
    appliedDeviceId: null as string | null,
    selectedDeviceId: 'devA',
    sessions: [] as RemoteSession[],
    modelRows: [] as ProviderModelRow[],
    rowsAgentKind: 'claude-code' as const,
    catalogReady: true,
    availableModels: [],
    currentEffort: 'medium',
  };

  it('intent ①: follows the most recent session as a whole runtime (agent+model+effort reconciled)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-5.4', effort: 'high', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium', 'high'], 'medium')],
    });
    expect(result).toEqual({
      appliedDeviceId: 'devA',
      patch: {
        agentKind: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        permissionMode: 'auto',
        providerId: null,
      },
    });
  });

  it('intent ①+: inherits the recent session providerId when the provider still offers the model (#1898)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', providerId: 'prov-deepseek-v4-flash', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('deepseek-v4-flash', ['low', 'medium', 'high'], 'medium')],
    });
    expect(result?.patch).toMatchObject({
      agentKind: 'claude-code',
      model: 'deepseek-v4-flash',
      providerId: 'prov-deepseek-v4-flash',
    });
  });

  it('intent ①-: reroutes to another provider offering the same model when the recent provider is gone (codex P1)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', providerId: 'prov-gone', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('deepseek-v4-flash', ['low', 'medium', 'high'], 'medium')],
    });
    expect(result?.patch).toMatchObject({
      model: 'deepseek-v4-flash',
      providerId: 'prov-deepseek-v4-flash',
    });
  });

  it('intent ①-fallback: falls back to the catalog top row when no provider offers the recent model', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'delisted-model', providerId: 'prov-gone', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'low')],
    });
    expect(result?.patch).toMatchObject({
      model: 'claude-sonnet-4-6',
      providerId: 'prov-claude-sonnet-4-6',
    });
  });

  it('intent ①x: trusts the recent providerId when it belongs to a different agent than the rows (codex P1)', () => {
    // 目录按 claude-code 构建,最近会话是 codex —— 目录不一致时不做校验,合法来源不被误清
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      rowsAgentKind: 'claude-code',
      catalogReady: true,
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-5.4', providerId: 'prov-codex-only', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'medium')],
    });
    expect(result?.patch).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.4',
      providerId: 'prov-codex-only',
    });
  });

  it('intent ①b: keeps the recent effort when the recent model is not in modelRows (cross-agent / delisted)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-legacy', effort: 'high', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'medium')],
    });
    expect(result?.patch).toEqual({
      agentKind: 'codex',
      model: 'gpt-legacy',
      effort: 'high',
      permissionMode: 'auto',
      providerId: null,
    });
  });

  it('intent ①y: cross-agent follow keeps recent effort verbatim — rows belong to another agent and have no authority over its effort ladder (reviewer P2)', () => {
    // 目录按 claude-code 构建,最近会话是 codex(gpt-5.4 + xhigh);cc 目录里恰好也有
    // 同名 gpt-5.4 但档位表不含 xhigh —— 修复前命中该行,effort 被错 reconcile 成
    // cc 默认档 'medium',随后渲染目录按 codex 重建而 effort 不再复核,错档一路带进创建。
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      rowsAgentKind: 'claude-code',
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-5.4', effort: 'xhigh', providerId: 'prov-codex-only', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'medium')],
    });
    expect(result?.patch).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.4',
      effort: 'xhigh',
      providerId: 'prov-codex-only',
    });
  });

  it('intent ①r: same-agent follow still reconciles effort against the matched row ladder', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [remoteSession('ds', { agentKind: 'cc', model: 'deepseek-v4-flash', effort: 'xhigh', providerId: 'prov-deepseek-v4-flash', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('deepseek-v4-flash', ['low', 'medium'], 'medium')],
    });
    expect(result?.patch).toMatchObject({
      agentKind: 'claude-code',
      model: 'deepseek-v4-flash',
      effort: 'medium', // xhigh 不在该 agent 目录档位表 → reconcile 到模型默认档
      providerId: 'prov-deepseek-v4-flash',
    });
  });

  it('intent ②: no recent session → top of the model list (model + reconciled effort + row provider, agentKind untouched)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      currentEffort: 'high', // 不被首个模型支持 → reconcile 到默认 'low'
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'low'), modelRow('claude-haiku', ['low'], 'low')],
    });
    expect(result).toEqual({
      appliedDeviceId: 'devA',
      patch: { model: 'claude-sonnet-4-6', effort: 'low', providerId: 'prov-claude-sonnet-4-6' },
    });
    expect(result?.patch).not.toHaveProperty('agentKind');
  });

  it('intent ②-wait: catalog not ready → do not copy the (stale) top row, wait for the real catalog (codex P1)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      catalogReady: false,
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'low')],
    });
    expect(result).toBeNull();
  });

  it('intent ②a: no recent session → regional default before the top row (upstream main 移植)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      currentEffort: 'high',
      modelRows: [
        modelRow('top', ['low'], 'low'),
        modelRow('regional', ['medium'], 'medium', ['claude-code']),
      ],
    });
    // 区域默认来自 provider 行 → 携带该行 provider(#1898 语义)
    expect(result?.patch).toEqual({ model: 'regional', effort: 'medium', providerId: 'prov-regional' });
  });

  it('intent ②a: keeps the marked provider row when another provider offers the same modelId earlier (codex P2)', () => {
    const shared = (providerId: string, marked: boolean, efforts: readonly string[], defaultEffort: string): ProviderModelRow => ({
      provider: { id: providerId, name: providerId } as ProviderModelRow['provider'],
      model: {
        id: 'shared-model',
        displayName: 'shared-model',
        efforts: efforts as ProviderModelRow['model']['efforts'],
        defaultEffort: defaultEffort as ProviderModelRow['model']['defaultEffort'],
        contextWindow: 0,
        ...(marked ? { newSessionDefault: ['claude-code'] } : {}),
      },
    });
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      currentEffort: 'high',
      modelRows: [shared('provA', false, ['low'], 'low'), shared('provB', true, ['high', 'xhigh'], 'high')],
    });
    // 同 modelId 多来源时必须在行层面选中带标记的 provB,并按其档位表校准 effort
    expect(result?.patch).toEqual({ model: 'shared-model', effort: 'high', providerId: 'provB' });
  });

  it('intent ②b: provider list unavailable → regional default from normalized capabilities (upstream main 移植)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      currentEffort: 'high',
      availableModels: [
        {
          id: 'regional',
          label: 'Regional',
          efforts: ['medium'],
          effortDisplayNames: {},
          defaultEffort: 'medium',
          supportsFastMode: false,
          newSessionDefault: ['claude-code'],
        },
      ],
    });
    // 扁平列表无 provider 行 → 默认路由
    expect(result?.patch).toEqual({ model: 'regional', effort: 'medium', providerId: null });
  });

  it('intent ③: switching device (not manually touched) recomputes for the new device', () => {
    const sessions = [
      remoteSession('onA', { model: 'model-A', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' }),
      remoteSession('onB', { model: 'model-B', deviceLinkDeviceId: 'devB', userSendAt: '2026-02-02T00:00:00.000Z' }),
    ];
    expect(resolveNewSessionAutoDefault({
      ...baseInput, sessions, appliedDeviceId: 'devA', selectedDeviceId: 'devB',
      modelRows: [modelRow('model-B', ['low'], 'low')],
    })?.patch).toMatchObject({ model: 'model-B' });
  });

  it('intent ④: userTouched → null (never overrides a manual selection)', () => {
    expect(resolveNewSessionAutoDefault({
      ...baseInput,
      userTouched: true,
      sessions: [remoteSession('cx', { model: 'gpt-5.4', deviceLinkDeviceId: 'devA', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low'], 'low')],
    })).toBeNull();
  });

  it('returns null when modelRows are not ready yet and there is no recent session (no premature set)', () => {
    expect(resolveNewSessionAutoDefault({ ...baseInput, sessions: [], modelRows: [] })).toBeNull();
  });

  it('applies the capabilities flat default when the catalog is explicitly unavailable (old host without provider:list, codex P2)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [],
      modelRows: [],
      catalogReady: false,
      providersUnavailable: true,
      availableModels: [
        {
          id: 'flat-default',
          label: 'Flat Default',
          efforts: ['medium'],
          effortDisplayNames: {},
          defaultEffort: 'medium',
          supportsFastMode: false,
          newSessionDefault: ['claude-code'],
        } as MobileModelOption,
      ],
    });
    // 目录明确不可用(旧被控端)→ 放行 capabilities 扁平回退;扁平列表无 provider 结构 → 默认路由
    expect(result).toEqual({
      appliedDeviceId: 'devA',
      patch: {
        model: 'flat-default',
        effort: 'medium',
        providerId: null,
      },
    });
  });

  it('does not fall back to flat defaults while the catalog is merely loading (error is empty, codex P2)', () => {
    expect(resolveNewSessionAutoDefault({
      ...baseInput,
      sessions: [],
      modelRows: [],
      catalogReady: false,
      providersUnavailable: false,
      availableModels: [{
        id: 'flat-default', label: 'Flat Default', efforts: ['medium'], effortDisplayNames: {}, defaultEffort: 'medium', supportsFastMode: false, newSessionDefault: ['claude-code'],
      } as MobileModelOption],
    })).toBeNull();
  });

  it('returns null when this device was already applied, and when no device is selected', () => {
    expect(resolveNewSessionAutoDefault({
      ...baseInput, appliedDeviceId: 'devA', modelRows: [modelRow('m', ['low'], 'low')],
    })).toBeNull();
    expect(resolveNewSessionAutoDefault({ ...baseInput, selectedDeviceId: '' })).toBeNull();
  });
});

describe('pickNewSessionDefaultDevice', () => {
  const devices = [
    { deviceId: 'devA', name: 'Mac A' },
    { deviceId: 'devB', name: 'Mac B' },
  ];

  it('uses the stored device when the route device is only a default candidate', () => {
    expect(pickNewSessionDefaultDevice({
      deviceOptions: devices,
      preferredDeviceId: 'devB',
      routeDevice: devices[0],
      routeDeviceExplicit: false,
    })).toEqual(devices[1]);
  });

  it('keeps an explicit route device over stored preferences', () => {
    expect(pickNewSessionDefaultDevice({
      deviceOptions: devices,
      preferredDeviceId: 'devB',
      routeDevice: devices[0],
      routeDeviceExplicit: true,
    })).toEqual(devices[0]);
  });

  it('falls back to the route device, then the first available device', () => {
    expect(pickNewSessionDefaultDevice({
      deviceOptions: devices,
      preferredDeviceId: 'missing',
      routeDevice: devices[0],
      routeDeviceExplicit: false,
    })).toEqual(devices[0]);

    expect(pickNewSessionDefaultDevice({
      deviceOptions: devices,
      routeDevice: null,
      routeDeviceExplicit: false,
    })).toEqual(devices[0]);
  });
});

// 接线锁(house style 的 source 断言,同下方 composer surface 测试):
// pickNewSessionDefaultDevice 的优先级行为已由上面的纯函数单测覆盖,这里只锁两个屏幕
// 之间 deviceExplicit 路由参数的存在性——用全文件唯一字符串断言,不做函数体切片定位,
// 避免锚点(如 deps 数组)变化时 indexOf 失效产生误导性报错。
describe('new session default device follows the home device filter', () => {
  it('sends the deviceExplicit flag only when the home list is filtered to one device', () => {
    const homeSource = readTextLf(resolve(process.cwd(), 'app/devices/index.tsx'), 'utf8');
    // 筛选某台电脑时带显式标记;"所有任务"(selectedDeviceId=null)不带,保留记忆回落。
    expect(homeSource).toContain("...(selectedDeviceId ? { deviceExplicit: '1' } : {})");
  });

  it('treats the deviceExplicit route flag as an explicit device on the new-session screen', () => {
    const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    expect(newSource).toContain('deviceExplicit?: string;');
    expect(newSource).toContain("readRouteString(params.deviceExplicit) === '1'");
  });
});

describe('new session model', () => {
  it('hides dot directories by default and restores them when enabled', () => {
    const entries = [
      { name: '.config', kind: 'dir' as const, path: '/Users/cindy/.config' },
      { name: '.workspace', kind: 'symlink' as const, path: '/Users/cindy/.workspace' },
      { name: 'Code', kind: 'dir' as const, path: '/Users/cindy/Code' },
    ];

    expect(filterRemoteDirectoryEntries(entries, false).map((entry) => entry.name)).toEqual(['Code']);
    expect(filterRemoteDirectoryEntries(entries, true)).toEqual(entries);
  });

  it('builds device-link create-session args with desktop remote-project semantics', () => {
    expect(buildRemoteCreateSessionOptions({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: ' /repo/xdt-maker ',
      firstMessage: 'hello',
      extraDirs: [' /repo/docs ', '/repo/docs', ''],
    })).toEqual({
      agentKind: 'claude-code',
      workingDir: '/repo/xdt-maker',
      workspaceKind: 'project',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'auto',
      fastMode: false,
      extraDirs: ['/repo/docs'],
    });
  });

  it('builds folderless dialogue create-session args for controlled-side cwd allocation', () => {
    expect(buildRemoteCreateSessionOptions({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workspaceKind: 'dialogue',
      workingDir: ' /repo/should-not-leak ',
      firstMessage: 'hello',
      extraDirs: ['/repo/docs'],
    })).toEqual({
      agentKind: 'claude-code',
      workspaceKind: 'dialogue',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'auto',
      fastMode: false,
    });
  });

  it('omits effort from create-session args when the selected model has no effort control', () => {
    expect(buildRemoteCreateSessionOptions({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo/xdt-maker',
      firstMessage: 'hello',
      model: 'claude-haiku-4-6',
      effort: '',
    })).toEqual({
      agentKind: 'claude-code',
      workingDir: '/repo/xdt-maker',
      workspaceKind: 'project',
      model: 'claude-haiku-4-6',
      permissionMode: 'auto',
      fastMode: false,
    });
  });

  it('preserves a Codex Auto-review draft when creating the session', () => {
    expect(buildRemoteCreateSessionOptions({
      ...DEFAULT_NEW_SESSION_DRAFT,
      agentKind: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'auto',
      workingDir: '/repo/xdt-maker',
    })).toMatchObject({
      agentKind: 'codex',
      permissionMode: 'auto',
    });
  });

  it('switches agent defaults without carrying a Claude model into Codex', () => {
    const codex = withAgentDefaults(DEFAULT_NEW_SESSION_DRAFT, 'codex');
    expect(codex).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.4',
      permissionMode: 'auto',
    });

    const claude = withAgentDefaults({ ...codex, fastMode: true }, 'claude-code');
    expect(claude).toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      fastMode: false,
    });
  });

  it('exposes Pi as a first-class agent and preserves Fast for Pi sessions', () => {
    expect(NEW_SESSION_AGENT_OPTIONS.map((option) => option.kind)).toEqual([
      'claude-code', 'codex', 'pi',
    ]);
    const pi = withAgentDefaults({ ...DEFAULT_NEW_SESSION_DRAFT, fastMode: true }, 'pi');
    expect(pi).toMatchObject({ agentKind: 'pi', model: 'gpt-5.4', fastMode: true });
    expect(buildRemoteCreateSessionOptions({
      ...pi,
      workingDir: '/repo/xdt-maker',
      firstMessage: 'hello',
    })).toMatchObject({ agentKind: 'pi', fastMode: true });
  });

  it('filters the new-session agent options by the controlled device runtime-registered set', () => {
    // null(未拉到)→ fail-open,全部保留。
    expect(availableNewSessionAgentOptions(null).map((o) => o.kind)).toEqual([
      'claude-code', 'codex', 'pi',
    ]);
    // 被控端无 Pi(二进制缺失)→ 隐藏 Pi,避免建出 requireAgent 报 not-registered 的会话。
    expect(
      availableNewSessionAgentOptions(new Set(['claude-code', 'codex'])).map((o) => o.kind),
    ).toEqual(['claude-code', 'codex']);
    // 只有 Pi 注册(理论)→ 只留 Pi。
    expect(availableNewSessionAgentOptions(new Set(['pi'])).map((o) => o.kind)).toEqual(['pi']);
    // 空集(被控端异常)→ 退回至少 Claude,不把入口清空到无法创建。
    expect(availableNewSessionAgentOptions(new Set()).map((o) => o.kind)).toEqual(['claude-code']);
  });

  it('wires the new-session screen to gate agents by list-available-agents and coerce off unavailable', () => {
    const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    // 拉被控端 runtime 注册集合,渲染按可用集过滤,选中不可用时 coerce。
    expect(newSource).toContain('maker.listAvailableAgents()');
    expect(newSource).toContain('onAgentsChanged');
    expect(newSource).toContain('evictAgentCapabilitiesForDevice(deviceId);');
    expect(newSource).toContain('const rosterRecoveryIdentityRef = useRef<');
    expect(newSource).toContain('setAvailableAgentRosterRefreshNonce((value) => value + 1);');
    expect(newSource).toContain('previous.connectionEpoch === connectionEpoch');
    expect(newSource.match(/subscribe\(`new-session:\$\{selectedDeviceId\}`/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(newSource).toContain('availableNewSessionAgentOptions(availableAgentKinds).map');
    expect(newSource).toMatch(/availableAgentKinds\.has\(draft\.agentKind\)/);
    // 传输层 passthrough 到 allowlisted channel。
    const transportSource = readTextLf(
      resolve(process.cwd(), 'src/device-link/mobileMakerTransport.ts'), 'utf8');
    expect(transportSource).toContain("listAvailableAgents: () => call('maker:list-available-agents', [])");
  });

  it('uses safe per-agent permission defaults for new interactive sessions', () => {
    expect(defaultPermissionModeForNewSessionAgent('claude-code')).toBe('auto');
    expect(defaultPermissionModeForNewSessionAgent('codex')).toBe('auto');
  });

  it('validates required path, model and first-message payload', () => {
    expect(validateNewSessionDraft(DEFAULT_NEW_SESSION_DRAFT)).toBe('请输入电脑端项目路径。');
    expect(validateNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workspaceKind: 'dialogue',
    })).toBe('请输入首条消息或添加附件。');
    expect(validateNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo',
      model: '',
    })).toBe('请输入模型。');
    expect(validateNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo',
      firstMessage: '',
    })).toBe('请输入首条消息或添加附件。');
    expect(validateNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo',
      firstMessage: 'run tests',
    })).toBeNull();
    expect(validateNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo',
      firstMessage: '',
    }, { attachmentCount: 1 })).toBeNull();
  });

  it('summarizes the mobile create-session draft for the top overview strip', () => {
    expect(summarizeNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '',
      firstMessage: '',
    })).toMatchObject({
      agentLabel: 'Claude',
      canCreate: false,
      runtimeLabel: 'Claude · claude-sonnet-4-6 · medium',
      scopeLabel: '未选择项目路径',
      validationMessage: '请输入电脑端项目路径。',
      workspaceLabel: '项目',
    });

    expect(summarizeNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo/xdt-maker',
      firstMessage: 'run tests',
      extraDirs: ['/repo/docs', '/repo/docs', ''],
    })).toMatchObject({
      canCreate: true,
      scopeLabel: 'xdt-maker · +1 附加目录',
      validationMessage: null,
    });

    expect(summarizeNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo/xdt-maker',
      firstMessage: '',
    }, { attachmentCount: 2 })).toMatchObject({
      canCreate: true,
      validationMessage: null,
    });

    expect(summarizeNewSessionDraft({
      ...DEFAULT_NEW_SESSION_DRAFT,
      agentKind: 'codex',
      workspaceKind: 'dialogue',
      workingDir: '',
      model: 'gpt-5.4',
      fastMode: true,
      firstMessage: 'review this',
    })).toMatchObject({
      agentLabel: 'Codex',
      canCreate: true,
      runtimeLabel: 'Codex · gpt-5.4 · medium · Fast',
      scopeLabel: '电脑端分配对话目录',
      workspaceLabel: '对话',
    });
  });

  it('builds a final mobile create preview before sending to the controlled computer', () => {
    expect(buildNewSessionCreatePreview({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '',
      firstMessage: '',
    }, 'Carol Mac')).toMatchObject({
      title: '还不能创建',
      subtitle: '请输入电脑端项目路径。',
      details: [
        '设备：Carol Mac',
        '位置：未选择项目路径',
        '运行：Claude · claude-sonnet-4-6 · medium',
        '首条：未填写',
      ],
    });

    expect(buildNewSessionCreatePreview({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workspaceKind: 'dialogue',
      workingDir: '',
      firstMessage: '请帮我总结这个项目，并给出下一步建议。',
      model: 'claude-sonnet-4-6',
    }, 'Carol Mac')).toMatchObject({
      title: '准备创建并发送',
      subtitle: '确认后会在被控设备创建任务，并把首条消息加入队列。',
      details: [
        '设备：Carol Mac',
        '位置：对话工作区',
        '运行：Claude · claude-sonnet-4-6 · medium',
        '首条：请帮我总结这个项目，并给出下一步建议。',
      ],
    });

    expect(buildNewSessionCreatePreview({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo/xdt-maker',
      firstMessage: '',
    }, 'Carol Mac', { attachmentCount: 2 })).toMatchObject({
      title: '准备创建并发送',
      details: [
        '设备：Carol Mac',
        '位置：/repo/xdt-maker',
        '运行：Claude · claude-sonnet-4-6 · medium',
        '首条：仅发送附件',
        '附件：2 个',
      ],
    });
  });

  it('parses extra dirs text the same way create args expect arrays', () => {
    expect(parseExtraDirsInput(' /repo/docs\n/repo/tools, /repo/docs\n\n')).toEqual([
      '/repo/docs',
      '/repo/tools',
    ]);
  });

  it('serializes device candidates for new-session route params', () => {
    const encoded = serializeNewSessionDeviceOptions([
      { deviceId: ' pc ', name: ' PC ' },
      { deviceId: 'mac', name: '' },
      { deviceId: 'pc', name: 'Duplicate' },
    ]);

    expect(parseNewSessionDeviceOptions(encoded)).toEqual([
      { deviceId: 'pc', name: 'PC' },
      { deviceId: 'mac', name: 'mac' },
    ]);
  });

  it('falls back to the route device when candidate params are missing or invalid', () => {
    expect(parseNewSessionDeviceOptions('', { deviceId: 'pc', name: 'PC' })).toEqual([
      { deviceId: 'pc', name: 'PC' },
    ]);
    expect(parseNewSessionDeviceOptions('not-json', { deviceId: 'pc', name: '' })).toEqual([
      { deviceId: 'pc', name: 'pc' },
    ]);
    expect(parseNewSessionDeviceOptions('')).toEqual([]);
  });

  it('builds recent workspace quick picks from mirrored remote sessions', () => {
    const options = buildRecentWorkspaceOptions([
      remoteSession('old', {
        workingDir: '/repo/old',
        userSendAt: '2026-01-01T00:01:00.000Z',
        deviceLinkDeviceId: 'mac-a',
      }),
      remoteSession('latest-a', {
        workingDir: '/repo/app',
        userSendAt: '2026-01-01T00:05:00.000Z',
        deviceLinkDeviceId: 'mac-a',
      }),
      remoteSession('latest-b', {
        workingDir: '/repo/app',
        userSendAt: '2026-01-01T00:06:00.000Z',
        deviceLinkDeviceId: 'mac-a',
      }),
      remoteSession('dialogue', {
        workspaceKind: 'dialogue',
        workingDir: null,
        deviceLinkDeviceId: 'mac-a',
      }),
      remoteSession('other-device', {
        workingDir: '/repo/other',
        userSendAt: '2026-01-01T00:10:00.000Z',
        deviceLinkDeviceId: 'mac-b',
      }),
      remoteSession('deleted', {
        workingDir: '/repo/deleted',
        status: 'deleted',
        deviceLinkDeviceId: 'mac-a',
      }),
    ], 'mac-a');

    expect(options).toEqual([
      {
        workingDir: '/repo/app',
        title: 'app',
        sessionCount: 2,
        lastActivityAt: '2026-01-01T00:06:00.000Z',
      },
      {
        workingDir: '/repo/old',
        title: 'old',
        sessionCount: 1,
        lastActivityAt: '2026-01-01T00:01:00.000Z',
      },
    ]);
  });

  it('folds managed worktree sessions into their base repo project', () => {
    const options = buildRecentWorkspaceOptions([
      remoteSession('base', {
        workingDir: '/repo/app',
        userSendAt: '2026-01-01T00:01:00.000Z',
      }),
      remoteSession('current-worktree', {
        workingDir: '/repo/app/.cindy-worktrees/auto-one',
        worktreePath: '/repo/app/.cindy-worktrees/auto-one',
        userSendAt: '2026-01-01T00:03:00.000Z',
      }),
      remoteSession('legacy-worktree', {
        workingDir: '/repo/app/.xdt-worktrees/auto-two',
        worktreePath: '/repo/app/.xdt-worktrees/auto-two',
        userSendAt: '2026-01-01T00:02:00.000Z',
      }),
    ]);

    expect(options).toEqual([{
      workingDir: '/repo/app',
      title: 'app',
      sessionCount: 3,
      lastActivityAt: '2026-01-01T00:03:00.000Z',
    }]);
    expect(pickInitialNewSessionWorkspace('', options)).toBe('/repo/app');
  });

  it('prefills a blank new session from the most recent workspace only', () => {
    const recentWorkspaces = buildRecentWorkspaceOptions([
      remoteSession('old', {
        workingDir: '/repo/old',
        userSendAt: '2026-01-01T00:01:00.000Z',
      }),
      remoteSession('latest', {
        workingDir: '/repo/latest',
        userSendAt: '2026-01-01T00:10:00.000Z',
      }),
    ]);

    expect(pickInitialNewSessionWorkspace('', recentWorkspaces)).toBe('/repo/latest');
    expect(pickInitialNewSessionWorkspace(' /repo/from-route ', recentWorkspaces)).toBeNull();
    expect(pickInitialNewSessionWorkspace('', [])).toBeNull();
  });

  it('normalizes create results and can synthesize a fallback session row', () => {
    const result = normalizeCreateSessionResult({
      sessionId: 's-new',
      agentKind: 'claude-code',
      workDir: '/repo',
      usedProjectContext: true,
    });
    expect(result).toMatchObject({ sessionId: 's-new', workDir: '/repo' });

    expect(sessionFromCreateResult(result!, {
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: '/repo',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: false,
      providerId: null,
      firstMessage: '帮我排查登录失败',
    }, new Date('2026-06-16T10:00:00.000Z'))).toMatchObject({
      id: 's-new',
      title: '帮我排查登录失败',
      workingDir: '/repo',
      workspaceKind: 'project',
      agentKind: 'cc',
      userSendAt: '2026-06-16T10:00:00.000Z',
    });

    expect(sessionFromCreateResult({
      sessionId: 's-dialogue',
      agentKind: 'codex',
      workDir: '/userData/dialogues/2026-06-16/s-dialogue',
    }, {
      agentKind: 'codex',
      workspaceKind: 'dialogue',
      workingDir: '',
      model: 'gpt-5.4',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: true,
      providerId: null,
    }, new Date('2026-06-16T10:00:00.000Z'))).toMatchObject({
      id: 's-dialogue',
      workingDir: '/userData/dialogues/2026-06-16/s-dialogue',
      workspaceKind: 'dialogue',
      agentKind: 'codex',
    });

    expect(normalizeCreateSessionResult({ sessionId: '' })).toBeNull();
    expect(normalizeCreateSessionResult(null)).toBeNull();
  });

  it('sessionFromCreateResult carries the draft providerId into the synthesized session (codex P1)', () => {
    const session = sessionFromCreateResult({ sessionId: 's-p' }, {
      agentKind: 'claude-code',
      workspaceKind: 'dialogue',
      workingDir: '',
      model: 'deepseek-v4-flash',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: false,
      providerId: 'deepseek',
    });
    expect(session.providerId).toBe('deepseek');
    expect(session.title).toBe('New Maker');
    // 未绑定来源的草稿 → null(默认路由),与真实会话同形
    expect(sessionFromCreateResult({ sessionId: 's-n' }, {
      agentKind: 'claude-code',
      workspaceKind: 'dialogue',
      workingDir: '',
      model: 'claude-sonnet-4-6',
      effort: '',
      permissionMode: 'acceptEdits',
      fastMode: false,
      providerId: null,
    }).providerId).toBeNull();
  });
});

describe('new session composer surface', () => {
  it('does not double-apply the Android safe-area inset to the top navigation', () => {
    const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');

    expect(newSource).toContain(
      "const NEW_SESSION_SCREEN_TOP_PADDING = Platform.OS === 'android' ? 0 : spacing.xl;",
    );
    expect(newSource).toContain('paddingTop: NEW_SESSION_SCREEN_TOP_PADDING,');
  });

  it('uses the shared platform keyboard avoidance rule for the new-session composer', () => {
    const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const normalizedNewSource = newSource.replace(/\r\n/g, '\n');

    expect(newSource).toContain("import { keyboardAvoidingBehaviorForPlatform } from '@/session/mobileNativeShellLayout';");
    expect(normalizedNewSource).toContain(`behavior={keyboardAvoidingBehaviorForPlatform(
          Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        )}`);
    expect(newSource).not.toContain("Platform.OS === 'ios' ? 'padding' : undefined");
  });

  it('uses the shared mobile composer row rather than a separate input implementation', () => {
    const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const sessionSource = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const sharedSource = readTextLf(resolve(process.cwd(), 'src/session/MobileComposerInputRow.tsx'), 'utf8');
    const newComposerStart = newSource.indexOf('<MobileComposerInputRow');
    const newComposerEnd = newSource.indexOf('\n                />', newComposerStart) + '\n                />'.length;
    const newComposerSource = newSource.slice(newComposerStart, newComposerEnd);
    const attachmentButtonStart = newSource.indexOf('const renderAttachmentToggleButton = () => (');
    const attachmentButtonEnd = newSource.indexOf('const renderCreateButton = () => (', attachmentButtonStart);
    const attachmentButtonSource = newSource.slice(attachmentButtonStart, attachmentButtonEnd);
    const createButtonStart = newSource.indexOf('const renderCreateButton = () => (');
    const createButtonEnd = newSource.indexOf('// 聚焦卡片形态的底部工具排', createButtonStart);
    const createButtonSource = newSource.slice(createButtonStart, createButtonEnd);
    const composerIconButtonStart = newSource.indexOf('composerIconButton: {');
    const composerIconButtonEnd = newSource.indexOf('composerCompactLeading:', composerIconButtonStart);
    const composerIconButtonStyle = newSource.slice(composerIconButtonStart, composerIconButtonEnd);
    const modelPillStart = newSource.indexOf('modelPill: {');
    const modelPillEnd = newSource.indexOf('modelPillText:', modelPillStart);
    const modelPillStyle = newSource.slice(modelPillStart, modelPillEnd);
    const modelPillTextStart = newSource.indexOf('modelPillText: {');
    const modelPillTextEnd = newSource.indexOf('inputVoiceHidden:', modelPillTextStart);
    const modelPillTextStyle = newSource.slice(modelPillTextStart, modelPillTextEnd);
    const voiceDraftTextStart = newSource.indexOf('voiceDraftText: {');
    const voiceDraftTextEnd = newSource.indexOf('voiceDraftListeningPrompt:', voiceDraftTextStart);
    const voiceDraftTextStyle = newSource.slice(voiceDraftTextStart, voiceDraftTextEnd);
    const sendButtonStart = newSource.indexOf('sendButton: {');
    const sendButtonEnd = newSource.indexOf('sendButtonDisabled:', sendButtonStart);
    const sendButtonStyle = newSource.slice(sendButtonStart, sendButtonEnd);
    const sendButtonDisabledStart = newSource.indexOf('sendButtonDisabled: {');
    const sendButtonDisabledEnd = newSource.indexOf('sendButtonPressed:', sendButtonDisabledStart);
    const sendButtonDisabledStyle = newSource.slice(sendButtonDisabledStart, sendButtonDisabledEnd);
    const voiceButtonStart = newSource.indexOf('const renderComposerVoiceButton = (buttonStyle?: StyleProp<ViewStyle>) => (');
    const voiceButtonEnd = newSource.indexOf('// 切 agent:', voiceButtonStart);
    const voiceButtonSource = newSource.slice(voiceButtonStart, voiceButtonEnd);
    const storedAgentStart = newSource.indexOf('const storedAgentKind = newSessionPreferences?.agentKind;');
    const storedAgentEnd = newSource.indexOf('// 新建任务默认运行配置', storedAgentStart);
    const storedAgentSource = newSource.slice(storedAgentStart, storedAgentEnd);
    const selectDeviceStart = newSource.indexOf('const selectDevice = useCallback((option: NewSessionDeviceOption) => {');
    const selectDeviceEnd = newSource.indexOf('// 切 agent:', selectDeviceStart);
    const selectDeviceSource = newSource.slice(selectDeviceStart, selectDeviceEnd);
    const selectWorkingDirStart = newSource.indexOf('const selectWorkingDir = useCallback((workingDir: string) => {');
    const selectDialogueWorkspaceStart = newSource.indexOf('const selectDialogueWorkspace = useCallback(() => {');
    const selectRecentProjectStart = newSource.indexOf('const selectRecentProject = useCallback((workingDir: string) => {');
    const openProjectBrowseStart = newSource.indexOf('const openProjectBrowse = useCallback(() => {');
    const selectWorkingDirSource = newSource.slice(selectWorkingDirStart, selectDialogueWorkspaceStart);
    const selectDialogueWorkspaceSource = newSource.slice(selectDialogueWorkspaceStart, selectRecentProjectStart);
    const selectRecentProjectSource = newSource.slice(selectRecentProjectStart, openProjectBrowseStart);
    const browseHiddenToggleStyleStart = newSource.indexOf('browseHiddenToggle: {');
    const browseHiddenToggleStyleEnd = newSource.indexOf('browseCheckbox: {', browseHiddenToggleStyleStart);
    const browseHiddenToggleStyle = newSource.slice(browseHiddenToggleStyleStart, browseHiddenToggleStyleEnd);
    const createStart = newSource.indexOf('const create = useCallback(async () => {');
    const createEnd = newSource.indexOf('return (', createStart);
    const createSource = newSource.slice(createStart, createEnd);

    expect(newSource).toContain("MobileComposerInputRow,");
    expect(sessionSource).toContain("MobileComposerInputRow,");
    expect(newSource).toContain("import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';");
    expect(newSource).toContain("const visualFocusComposer = MOBILE_VISUAL_MOCK_ENABLED && readRouteString(params.visualFocusComposer) === '1';");
    expect(newSource).toContain('const visualInitialDraft = MOBILE_VISUAL_MOCK_ENABLED ? readRouteString(params.visualDraft) : null;');
    expect(newSource).toContain('firstMessage: visualInitialDraft ?? DEFAULT_NEW_SESSION_DRAFT.firstMessage');
    expect(newComposerSource).toContain('inputTestID="newSession.firstMessageInput"');
    expect(newComposerSource).toContain('autoFocus={visualFocusComposer}');
    expect(newComposerSource).toContain('maxHeight={composerResize.inputMaxHeight}');
    expect(newComposerSource).toContain('inputFrameAnimatedStyle={composerResize.frameStyle}');
    expect(newSource).toContain('gesture={composerResize.gesture}');
    expect(newComposerSource).toContain('resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}');
    expect(newComposerSource).toContain('cardActive={composerCardActive}');
    expect(newComposerSource).toContain('toolbar={renderComposerToolbar()}');
    expect(newComposerSource).toContain('voicePlacement={composerVoicePlacement}');
    expect(newComposerSource).toContain('floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}');
    expect(newComposerSource).toContain('cursorColor={colors.inputCaret}');
    expect(newComposerSource).toContain('selectionColor={colors.inputCaret}');
    expect(newComposerSource).toContain('inputRef={firstMessageInputRef}');
    expect(newComposerSource).toContain('inputOverlay={renderComposerInputOverlay()}');
    expect(newComposerSource).toContain('inputStyle={voiceIsListening ? styles.inputVoiceHidden : undefined}');
    expect(newComposerSource).toContain('onChangeText={setFirstMessageDraft}');
    expect(newComposerSource).toContain('onContentSizeChange={handleFirstMessageInputContentSizeChange}');
    expect(newComposerSource).toContain("placeholder={voiceIsListening ? '' : composerPlaceholder}");
    expect(newComposerSource).toContain('scrollEnabled={composerInputScrollEnabled}');
    expect(newComposerSource).toContain('trailing={composerCardActive || !composerShowCreateButton ? null : renderCreateButton()}');
    expect(newComposerSource).toContain('leading={renderComposerCompactLeading()}');
    expect(newSource).toContain('const renderComposerCompactLeading = () => (');
    expect(newSource).not.toContain('styles.composerCompactAttachmentSlot');
    expect(newSource).toContain('styles.composerCompactAttachmentHit');
    expect(newSource).not.toContain('styles.composerCompactAttachmentHitArea');
    expect(newSource).toContain('pointerEvents="none"');
    expect(newSource).toContain('testID="newSession.attachmentToggleButton"');
    expect(newSource).toContain('height: MOBILE_COMPOSER_MIN_TOUCH_TARGET');
    expect(newSource).toContain('width: MOBILE_COMPOSER_MIN_TOUCH_TARGET');
    expect(newSource).toContain('minWidth: MOBILE_COMPOSER_MIN_TOUCH_TARGET');
    expect(newSource).not.toContain('marginVertical: (MOBILE_COMPOSER_CONTROL_SIZE - MOBILE_COMPOSER_MIN_TOUCH_TARGET) / 2');
    expect(newSource).not.toContain('marginHorizontal: (MOBILE_COMPOSER_CONTROL_SIZE - MOBILE_COMPOSER_MIN_TOUCH_TARGET) / 2');
    expect(newSource).not.toContain('left: (MOBILE_COMPOSER_CONTROL_SIZE - MOBILE_COMPOSER_MIN_TOUCH_TARGET) / 2');
    expect(newSource).toContain('const renderComposerToolbar = () => (');
    // 左侧组包住 [+][权限][计划][模型],再接 spacer;右段 语音占位 → 创建。
    const newToolbarStart = newSource.indexOf('const renderComposerToolbar = () => (');
    const newToolbarEnd = newSource.indexOf('const renderComposerInputOverlay', newToolbarStart);
    const newToolbarSource = newSource.slice(newToolbarStart, newToolbarEnd);
    const newToolbarLeftGroupStart = newToolbarSource.indexOf('<ComposerToolbarLeftGroup testID="newSession.composerToolbarLeft">');
    const newToolbarLeftGroupEnd = newToolbarSource.indexOf('</ComposerToolbarLeftGroup>');
    const newToolbarModelIndex = newToolbarSource.indexOf('testID="newSession.modelIndicator"');
    const newToolbarSpacerIndex = newToolbarSource.indexOf('<ComposerToolbarSpacer />');
    const newToolbarVoiceSlotIndex = newToolbarSource.indexOf('<ComposerToolbarVoiceSlot width={voiceRecordingTimer.pillWidth} />');
    expect(newToolbarLeftGroupStart).toBeGreaterThan(-1);
    expect(newToolbarModelIndex).toBeGreaterThan(newToolbarLeftGroupStart);
    expect(newToolbarLeftGroupEnd).toBeGreaterThan(newToolbarModelIndex);
    expect(newToolbarSpacerIndex).toBeGreaterThan(newToolbarLeftGroupEnd);
    expect(newToolbarVoiceSlotIndex).toBeGreaterThan(newToolbarSpacerIndex);
    expect(newSource).toContain('PaperPlaneIcon');
    expect(newSource).not.toContain('ArrowUp');
    expect(attachmentButtonSource).toContain('contextSheetOpen && styles.composerIconButtonActive');
    expect(attachmentButtonSource).toContain('color={contextSheetOpen ? colors.textPrimary : colors.textSecondary}');
    expect(attachmentButtonSource).toContain('size={iconSize.sm}');
    expect(createButtonSource).toContain('<PaperPlaneIcon');
    expect(createButtonSource).toContain('size={iconSize.lg}');
    expect(createButtonSource).toContain('color={canCreate ? colors.ctaText : colors.textSecondary}');
    expect(createButtonSource).toContain('<ActivityIndicator color={colors.textSecondary} size="small" />');
    expect(composerIconButtonStyle).toContain('backgroundColor: colors.sheetActionSurface');
    expect(composerIconButtonStyle).toContain('borderColor: colors.sheetActionBorder');
    expect(composerIconButtonStyle).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(composerIconButtonStyle).toContain('height: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(composerIconButtonStyle).toContain('width: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(modelPillStyle).toContain('backgroundColor: colors.sheetActionSurface');
    expect(modelPillStyle).toContain('borderColor: colors.sheetActionBorder');
    expect(modelPillStyle).toContain('borderRadius: radius.pill');
    expect(modelPillStyle).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(modelPillStyle).toContain('minHeight: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(modelPillStyle).toContain('paddingHorizontal: spacing.md');
    expect(modelPillTextStyle).toContain('color: colors.textPrimary');
    expect(modelPillTextStyle).toContain('fontSize: typeScale.caption');
    expect(modelPillTextStyle).toContain('fontWeight: fontWeight.semibold');
    // 输入框字号档由 MobileComposerInputRow 统一持有(MOBILE_COMPOSER_DRAFT_TEXT_STYLE),
    // 页面不再覆盖;语音草稿覆盖层必须引用同一档,否则换行位置与输入框错开(见
    // composerVoiceDraftMetrics.test.ts)。
    expect(newSource).not.toContain('sessionComposerInput');
    expect(voiceDraftTextStyle).toContain('...MOBILE_COMPOSER_DRAFT_TEXT_STYLE');
    expect(sendButtonStyle).toContain('backgroundColor: colors.cta');
    expect(sendButtonStyle).toContain('borderColor: colors.cta');
    expect(sendButtonStyle).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(sendButtonStyle).toContain('height: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(sendButtonStyle).toContain('width: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(sendButtonDisabledStyle).toContain('backgroundColor: colors.surfaceChip');
    expect(sendButtonDisabledStyle).toContain('borderColor: colors.border');
    // 模型浮窗(ModelPickerSheet):composer 上方 drop-up 面板不回潮。2026-07-28 起
    // 权限从浮窗二级视图提为工具排独立药丸(permissionIndicator)+ 独立 sheet,
    // 新建页与会话页都隐藏浮窗 header 权限入口(hidePermissionTrigger),避免双入口;
    // 旧的 permissionButton/permissionPanel 形态仍不允许回潮。
    expect(newSource).toContain('<ModelPickerSheet');
    expect(newSource).toContain('testID="newSession.modelSheet"');
    expect(newSource).toContain('hidePermissionTrigger');
    expect(newSource).toContain('testID="newSession.permissionIndicator"');
    expect(newSource).toContain('testID="newSession.permissionSheet"');
    expect(newSource).not.toContain('testID="newSession.permissionButton"');
    expect(newSource).not.toContain('testID="newSession.permissionPanel"');
    expect(newSource).not.toContain('testID="newSession.modelPickerPanel"');
    // 语音生命周期内创建按钮常驻(2026-07-25 对齐桌面):录音中点创建=结束录音并
    // 用转写创建;否则首段转写落地瞬间按钮冒出来会把语音胶囊整格推左。
    expect(newSource).toContain("|| voiceStartPending\n    || voiceState === 'listening'\n    || voiceState === 'submitting'\n    || voiceState === 'refining';");
    // listening 时只豁免「缺正文/附件」校验(路径/模型等其它校验不放行,
    // 否则按钮可点但必失败):点创建 = 停录并用最终转写创建(review 二轮收窄)。
    // 判定必须是结构化的 isNewSessionDraftMissingPayloadOnly,禁止比对本地化
    // 文案——locale 异步恢复时字符串比对会静默失效(review 三轮收口)。
    expect(newSource).toContain('isNewSessionDraftMissingPayloadOnly(draft, draftContent)');
    expect(newSource).not.toContain("=== t('session.new.enterFirstMessageOrAttachment')");
    expect(newSource).toContain('const canCreate = (!createValidation || (voiceIsListening && createValidationIsMissingPayload))');
    expect(newSource).not.toContain('(!createValidation || voiceIsListening) &&');
    expect(newSource).toContain('const composerShowCreateButton = composerHasMessage');
    expect(newSource).toContain('const deviceSelectorDisabled = creating || voiceIsProcessing || !deviceHasChoices;');
    // 按下即录(pressIn 起录):同一手势的松手由 voiceStartedOnPressInRef 吞掉,
    // 不再直接把 onPress 绑到 toggle。
    expect(voiceButtonSource).toContain('voiceStartedOnPressInRef.current = false;');
    expect(voiceButtonSource).toContain('toggleVoiceRecording();');
    expect(voiceButtonSource).toContain('disabled={creating || voiceIsProcessing}');
    expect(newSource).toContain('const startVoiceRecording = useCallback(async () => {');
    expect(newSource).toContain('const voiceStartupInFlightRef = useRef(false);');
    expect(newSource).toContain('const voicePermissionRequestInFlightRef = useRef(false);');
    expect(newSource).toContain('const voiceStopInFlightRef = useRef(false);');
    expect(newSource).toContain('const voiceStartupSeqRef = useRef(0);');
    expect(newSource).toContain('|| voiceStopInFlightRef.current');
    expect(newSource).toContain('resolveMobileVoiceRecordingPermission({');
    expect(newSource).toContain('voiceStartupInFlightRef.current = true;');
    expect(newSource.indexOf('resolveMobileVoiceRecordingPermission({')).toBeLessThan(
      newSource.indexOf('voiceStartupInFlightRef.current = true;'),
    );
    expect(newSource).toContain('getPermission: getRecordingPermissionsAsync');
    expect(newSource).toContain("isAppActive: () => AppState.currentState === 'active'");
    expect(newSource).toContain(
      "voicePermissionRequestSeqRef.current !== permissionRequestSeq\n"
      + "        || AppState.currentState !== 'active'\n"
      + "      ) return;\n"
      + "      startupSeq = voiceStartupSeqRef.current + 1;",
    );
    expect(newSource).toContain('const cancelVoiceForDeviceSwitch = useCallback(() => {');
    expect(selectDeviceSource).toContain('voicePermissionRequestInFlightRef.current');
    expect(selectDeviceSource).toContain('|| voiceStopInFlightRef.current');
    expect(selectDeviceSource).toContain('|| voiceIsProcessing');
    expect(selectDeviceSource).toContain('cancelVoiceForDeviceSwitch();');
    expect(newSource).toContain('voiceStartupInFlightRef.current = false;');
    expect(newSource).toContain('createMobileVoiceControllerSession({');
    expect(newSource).toContain('createMobileCindyVoiceCredential(selectedDeviceId)');
    expect(newSource).toContain('readNewSessionPreferences');
    expect(newSource).toContain('saveNewSessionPreferences');
    expect(newSource).toContain('pickNewSessionDefaultDevice({');
    expect(newSource).toContain('const userTouchedDeviceRef = useRef(false);');
    expect(newSource).toContain('if (!newSessionPreferencesLoaded) return;');
    expect(newSource).toContain('if (userTouchedDeviceRef.current) return;');
    expect(selectDeviceSource).toContain('userTouchedDeviceRef.current = true;');
    expect(selectWorkingDirSource).toContain('setShowHiddenDirectories(false);');
    expect(selectDialogueWorkspaceSource).toContain('setShowHiddenDirectories(false);');
    expect(selectRecentProjectSource).toContain('setShowHiddenDirectories(false);');
    expect(newSource).toContain("import { newSessionText } from '@/session/newSessionMessages';");
    expect(newSource).toContain('accessibilityRole="checkbox"');
    expect(newSource).toContain("accessibilityLabel={newSessionText('showHiddenDirectories')}");
    expect(newSource).toContain('accessibilityState={{ checked: showHiddenDirectories, disabled: creating || undefined }}');
    expect(newSource).toContain("{newSessionText('showHiddenDirectories')}");
    expect(newSource).toContain("{newSessionText('emptyDirectory')}");
    expect(newSource).not.toContain('显示隐藏文件夹');
    expect(newSource).not.toContain('没有可显示的子目录。');
    expect(browseHiddenToggleStyle).toContain('minHeight: 44');
    expect(storedAgentSource).toContain('if (selectedDeviceId) autoDefaultDeviceRef.current = selectedDeviceId;');
    expect(storedAgentSource).not.toContain('userTouchedRuntimeRef.current = true;');
    expect(newSource).toContain('void saveNewSessionPreferences({ agentKind: nextKind });');
    expect(newSource).toContain('testID="newSession.voiceStatus"');
    expect(newSource).toContain('testID="newSession.voiceSettingsButton"');
    expect(newSource).toContain('testID="newSession.voiceMicCaret"');
    expect(newSource).toContain('const renderComposerInputOverlay = () => voiceIsListening ? (');
    expect(newSource).toContain("import { buildSessionComposerLayout } from '@/session/sessionComposerLayout';");
    expect(newSource).toContain('const composerListeningPlaceholder = buildSessionComposerLayout({');
    expect(newSource).toContain('<Text style={styles.voiceDraftListeningText}>{composerListeningPlaceholder}</Text>');
    // 听写 mic 波形 caret 用正文色(对齐桌面 --chat-input-text,2026-07-28 用户定案),不用 statusReady 蓝绿。
    expect(newSource).toContain('<VoiceMicWaveCaret color={colors.textPrimary} testID="newSession.voiceMicCaret" />');
    // 语音态占位文案就是普通态 TextInput 的 placeholder,必须与 placeholderTextColor 同源,
    // 否则一进语音态这行字会变色(2026-07-31 用户定案:不再用 statusReady 蓝绿)。
    expect(newSource).toContain('placeholderTextColor={colors.textTertiary}');
    expect(newSource).toContain('voiceDraftListeningText: {\n    color: colors.textTertiary,');
    expect(newSource).not.toContain('voiceDraftListeningText: {\n    color: colors.statusReady,');
    expect(newSource).toContain('const voiceDraftShowsListeningPrompt = voiceIsListening && draft.firstMessage.length === 0;');
    expect(newSource).toContain('firstMessageInputRef.current?.setNativeProps({ selection: { start: end, end } });');
    expect(newSource).toContain('voiceDraftScrollRef.current?.scrollToEnd({ animated: false });');
    expect(sharedSource).toContain('export function VoiceMicWaveCaret');
    expect(newSource).toContain('const creatingRef = useRef(false);');
    expect(createSource).toContain('|| voiceStartupInFlightRef.current');
    expect(createSource).toContain('|| voiceStopInFlightRef.current');
    expect(createSource).toContain('|| voiceIsProcessing');
    expect(createSource).toContain('creatingRef.current = true;');
    expect(createSource.indexOf('creatingRef.current = true;')).toBeLessThan(createSource.indexOf('const latestDraftText = await finishVoiceRecording();'));
    expect(createSource).toContain('const latestDraftText = await finishVoiceRecording();');
    expect(createSource).toContain('effectiveDraft = { ...draft, firstMessage: latestDraftText };');
    expect(createSource).toContain('creatingRef.current = false;');
    expect(createButtonSource).toContain('busy: creating');
    expect(createButtonSource).toContain('|| worktreePreferenceSaving');
    expect(createButtonSource).toContain('|| worktreeBranchPreferenceSaving');
    expect(newSource).toContain('disabled: !canCreate || undefined,');
    // No start cue on mobile: playing a cue via expo-audio during capture stalls
    // the AVAudioEngine record tap (see mobileVoiceCue.ts). Only the end cue is wired.
    expect(newSource).not.toContain('playMobileVoiceInputStartCue');
    expect(newSource).not.toContain('onReadyForStartCue');
    expect(newSource).toContain('onReadyForEndCue: credential.settings?.playInteractionSound ? playMobileVoiceInputEndCue : undefined,');
    // Touch-down warm-up: the mic button prewarms the audio session + ASR
    // connection at pressIn, and voice startup claims that connection when fresh.
    expect(newSource).toContain('onPressIn={handleVoiceButtonPressIn}');
    // 托管预热:凭登录态提前拿 voice-server 票据(BYOK/穿透路径已删除,
    // 手机语音只保留 Cindy 官方托管路径)。
    expect(newSource).toContain('prewarmMobileVoiceStart(selectedDeviceId, {');
    expect(newSource).toContain('getAccessToken: () => auth.getAccessToken(),');
    expect(newSource).toContain('refreshAccessToken: () => auth.refreshAccessToken(),');
    expect(newSource).toContain('apiFetch: auth.apiFetch,');
    expect(newSource).toContain('const [prewarmedVoice, localVoiceInputHistory] = await Promise.all([');
    expect(newSource).toContain('takePrewarmedMobileVoiceAsr(selectedDeviceId) ?? Promise.resolve(null),');
    expect(newSource).not.toContain('MobileVoiceServiceMode');
    expect(newSource).not.toContain('LiteLlm');
    expect(newSource).toContain('?? createMobileCindyVoiceCredential(selectedDeviceId);');
    expect(newSource).toContain('connectionProvider: (providerId: string) => voiceContext.createAsrConnection(providerId),');
    expect(newSource).toContain('voiceContext.createRefinerTarget(providerId, options),');
    expect(newSource).toContain('voiceContext.warmRefiner(input),');
    expect(newSource).toContain('const voiceUiAvailable = shouldShowMobileVoiceUi(Platform.OS);');
    expect(newSource).toContain('const composerVoicePlacement = voiceUiAvailable');
    expect(newSource).toContain('hasTrailingAction: composerShowCreateButton');
    expect(newSource).toContain('const voiceStatusVisible = voiceUiAvailable && Boolean(voiceError);');
    expect(newSource).toContain('floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}');
    expect(sessionSource).toContain('voicePlacement={composerVoicePlacement}');
    expect(sharedSource).toContain('export const MOBILE_COMPOSER_INPUT_MAX_VISIBLE_LINES = 12;');
    expect(sharedSource).toContain('MOBILE_COMPOSER_CONTROL_SIZE,');
    expect(sharedSource).toContain('resolveMobileComposerVoiceButtonPlacement,');
    expect(sharedSource).toContain('resolveMobileComposerVoiceButtonAnchorStyle({');
    expect(sharedSource).toContain('voicePlacement?.inline || voicePlacement?.floating');
    expect(sharedSource).not.toContain('styles.voiceButtonAnchor');
    expect(newSource).not.toContain('messageInput: {');
    expect(newSource).not.toContain('composerToolbar: {');
    expect(newSource).not.toContain('permissionIcon: {');
    expect(newSource).not.toContain('style={styles.messageInput}');
  });
});

describe('new session worktree wiring (source locks)', () => {
  // worktree 两步建会话的接线不变量(纯函数测试覆盖不到的部分):
  //  - worktree:create 必须发生在 startNewSessionCreation 之前(远程没有改已建会话
  //    workingDir 的通道,且 create 对同 sessionId 重跑不幂等,不得进乐观管线重试面);
  //  - 两步共用同一预生成 sessionId(工作端 close-session 按绑定回收 worktree);
  //  - 成功后以 meta.path 替换 effectiveDraft.workingDir 再进管线;
  //  - 失败(业务 {ok:false} / invoke 抛错)早退留在表单,不建会话。
  const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');

  it('runs worktree:create before the optimistic pipeline with the same preset sessionId', () => {
    const requestIdx = newSource.indexOf('const createRequest = buildWorktreeCreateRequest({');
    const createIdx = newSource.indexOf('await maker.worktree.create(createRequest)', requestIdx);
    const parseIdx = newSource.indexOf('parseWorktreeCreateResult(', requestIdx);
    const pipelineIdx = newSource.indexOf('startNewSessionCreation({');
    expect(requestIdx).toBeGreaterThan(0);
    expect(createIdx).toBeGreaterThan(0);
    expect(parseIdx).toBeGreaterThan(requestIdx);
    expect(pipelineIdx).toBeGreaterThan(createIdx);
    expect(newSource).toContain('effectiveDraft = { ...effectiveDraft, workingDir: resp.meta.path };');
    expect(newSource).toContain('setError(formatWorktreeCreateFailure(resp.error));');
    // 勾选生效三条件:project 模式 × 用户勾选 × 资格探测通过。
    expect(newSource).toContain('worktreeIntent.applicable');
    expect(newSource).toContain('&& worktreeIntent.enabled');
    expect(newSource).toContain("&& worktreeIntent.eligibility.status === 'eligible'");
  });

  it('keeps the workstation-owned preference semantics (seed + explicit write-through)', () => {
    // 播种:openLink + 瞬态重试(app 后台恢复的重连窗口不得把工作端偏好静默播成未勾)。
    expect(newSource).toContain(
      "if (!selectedDeviceId || !syncKey || deviceLinkStatus !== 'online') return undefined;",
    );
    expect(newSource).toContain('return maker.getNewMakerDefaults(worktreeSeedAgentKindRef.current);');
    expect(newSource).toContain(
      'remoteSessionStore.getNewMakerWorktreePreference(selectedDeviceId).revision',
    );
    expect(newSource).toContain(
      'remoteSessionStore.setNewMakerWorktreePreference(',
    );
    expect(newSource).toContain(
      'useRemoteNewMakerWorktreePreference(selectedDeviceId)',
    );
    expect(newSource).toContain("classification.status === 'missing'");
    expect(newSource).toContain('worktreeHostSupportsRecoveryKeyDiscardRef.current === false');
    const seedEffect = newSource.indexOf('const worktreeSeedAgentKindRef = useRef(draft.agentKind);');
    const seedDeps = newSource.slice(
      newSource.indexOf('}, [', seedEffect),
      newSource.indexOf(']);', seedEffect) + 3,
    );
    expect(seedDeps).toContain('worktreePreferenceSyncKey,');
    expect(seedDeps).not.toContain('worktreeHostSupportsRecoveryKeyDiscard,');
    expect(newSource).not.toContain(
      'remoteSessionStore.setNewMakerWorktreePreference(selectedDeviceId, false);',
    );
    expect(newSource).toContain('worktreePreferenceSyncKey,');
    expect(newSource).toContain('worktreeSeedRetryNonce,');
    // 显式点击才写穿工作端记忆;工作端接受后才更新手机镜像。
    expect(newSource).toContain('applyWorktreePreferenceOnHost({');
    expect(newSource).toContain('apply: maker.applyNewMakerWorktreePref,');
    expect(newSource).toContain(
      "!next && worktreeEligibility.status === 'unsupported',",
    );
    expect(newSource).toContain('enabled: worktreeEnabled,');
    expect(newSource).not.toContain(
      'void maker.applyNewMakerWorktreePref(next).catch(() => undefined);',
    );
    // host-first 写入期间，适用 worktree 的项目由按钮和 create() 二次门禁阻止读取旧镜像；
    // 对话工作区不应被一份与当前创建无关的偏好写入卡住。
    expect(newSource).toContain('&& !worktreeCreateBlocked;');
    expect(newSource).toContain(
      'applicable: worktreeApplicable,',
    );
    const createEntry = newSource.indexOf('const create = useCallback(async () => {');
    // ineligible 豁免守卫使 create 函数体略长,窗口扩至 1600 确保覆盖 worktreeCreateBlocked。
    const createBody = newSource.slice(createEntry, createEntry + 1_600);
    expect(createBody).not.toContain('|| worktreePreferenceSaving');
    expect(createBody).toContain('if (worktreeCreateBlocked) {');
    expect(newSource).toContain('worktreeBranchPreferenceSaving');
    expect(newSource).toContain('worktreeCreateBlocked && worktreeControlCaptionKey');
    expect(newSource).toContain(
      "worktreePreferenceAuthorityUnknown ? 'session.new.worktreeSettingsSyncFailed' : null",
    );
    expect(newSource).toContain("worktreePreferenceCreateBlocked ? 'session.new.worktreeSettingsSaving' : null");
    expect(newSource).toContain('const resolveWorktreePreferenceGateErrorKey = useCallback(() => (');
    expect(newSource).toContain("? 'session.new.worktreeSettingsSyncFailed'");
    expect(newSource).toContain(": 'session.new.worktreeSettingsSaving'");
    expect(newSource).toContain('setError(t(resolveWorktreePreferenceGateErrorKey()));');
    expect(newSource).toContain('setGoalError(t(resolveWorktreePreferenceGateErrorKey()));');
  });

  it('re-probes worktree eligibility when the relay or workstation reconnects', () => {
    expect(newSource).toContain(
      "if (!selectedDeviceId || !cwd || deviceLinkStatus !== 'online') return undefined;",
    );
    const detectEffect = newSource.indexOf(
      'return maker.worktree.detectCwd(cwd);',
    );
    const preferenceEffect = newSource.indexOf(
      'const worktreeSeedAgentKindRef',
      detectEffect,
    );
    const detectBlock = newSource.slice(detectEffect, preferenceEffect);
    expect(detectBlock).toContain('connectionEpoch,');
    expect(detectBlock).toContain('deviceLinkStatus,');
    expect(detectBlock).toContain('presenceVersion,');
  });

  it('settles an unowned cleanup obligation before creating another worktree', () => {
    const recovery = newSource.indexOf(
      'const recovery = await recoverPendingPrecreatedWorktrees(worktreeAccountId, {',
    );
    const pendingGuard = newSource.indexOf(
      '!recovery.storageReadable',
      recovery,
    );
    const sessionId = newSource.indexOf(
      'const sessionId = createNewSessionId();',
      pendingGuard,
    );
    const worktreeCreate = newSource.indexOf(
      'await maker.worktree.create(createRequest)',
      sessionId,
    );

    expect(recovery).toBeGreaterThan(-1);
    expect(pendingGuard).toBeGreaterThan(recovery);
    expect(sessionId).toBeGreaterThan(pendingGuard);
    expect(worktreeCreate).toBeGreaterThan(sessionId);
    expect(newSource.slice(recovery, pendingGuard)).toContain(
      'record.deviceId !== selectedDeviceId',
    );
    expect(newSource.slice(pendingGuard, sessionId)).toContain(
      'recovery.retained > 0',
    );
    expect(newSource.slice(pendingGuard, sessionId)).toContain(
      "setError(t('session.new.worktreeCleanupPending'))",
    );
  });

  it('binds the new-screen recovery and background pipeline to the auth-owner generation', () => {
    const ownerCapture = newSource.indexOf('const authOwnerAtCreate = getMobileAuthOwner();');
    const ownerCheck = newSource.indexOf('const isCurrentOwner = () => (', ownerCapture);
    const recovery = newSource.indexOf(
      'const recovery = await recoverPendingPrecreatedWorktrees(worktreeAccountId, {',
      ownerCheck,
    );
    const recoveryFence = newSource.indexOf('isCurrent: isCurrentOwner,', recovery);
    const pipeline = newSource.indexOf('startNewSessionCreation({', recoveryFence);
    const pipelineFence = newSource.indexOf('isCurrentOwner,', pipeline);

    expect(ownerCapture).toBeGreaterThan(-1);
    expect(ownerCheck).toBeGreaterThan(ownerCapture);
    expect(recovery).toBeGreaterThan(ownerCheck);
    expect(recoveryFence).toBeGreaterThan(recovery);
    expect(pipeline).toBeGreaterThan(recoveryFence);
    expect(pipelineFence).toBeGreaterThan(pipeline);
  });

  it('persists a recoveryKey reservation before allowing remote worktree creation', () => {
    const hold = newSource.indexOf(
      'releasePrecreatedRegistration = holdPrecreatedWorktreeRegistration(sessionId);',
    );
    const reservation = newSource.indexOf(
      'const reservationRecorded = await registerPendingPrecreatedWorktree(',
      hold,
    );
    const failedPersistence = newSource.indexOf(
      'if (!reservationRecorded)',
      reservation,
    );
    const remoteCreate = newSource.indexOf(
      'await maker.worktree.create(createRequest)',
      failedPersistence,
    );

    expect(hold).toBeGreaterThan(-1);
    expect(reservation).toBeGreaterThan(hold);
    expect(failedPersistence).toBeGreaterThan(reservation);
    expect(remoteCreate).toBeGreaterThan(failedPersistence);
    expect(newSource.slice(failedPersistence, remoteCreate)).toContain(
      "setError(t('session.new.worktreeRecoveryStateFailed'))",
    );
    expect(newSource.slice(remoteCreate, remoteCreate + 500)).toContain(
      'recoveryKey,',
    );
    expect(newSource.slice(remoteCreate, remoteCreate + 1_500)).not.toContain(
      'maker.worktree.discardPrecreated',
    );
    expect(newSource.slice(remoteCreate, remoteCreate + 2_500)).toContain(
      "setError(t('session.new.worktreeCleanupPending'))",
    );
  });

  it('binds eligibility and source branch to device/cwd, then carries cleanup metadata into the pipeline', () => {
    expect(newSource).toContain('const worktreeTarget = {');
    expect(newSource).toContain('deviceId: selectedDeviceId ??');
    expect(newSource).toContain('worktreeEligibilityForTarget(worktreeProbe, worktreeTarget)');
    expect(newSource).toContain('probeGeneration: `${connectionEpoch}\\u0000${presenceVersion}`');
    expect(newSource).toContain('worktreeSourceBranchFromPreference(');
    expect(newSource).toContain('shouldAcceptWorktreeBranchListResult({');
    expect(newSource).toContain('sourceBranch: worktreeIntent.sourceBranch,');
    expect(newSource).toContain('const worktreeIntent = captureWorktreeCreateIntent();');
    expect(newSource).toContain('isWorktreeCreateIntentCurrent(worktreeIntent)');
    expect(newSource).toContain('precreatedWorktree = {');
    expect(newSource).toContain('recoveryKey,');
    expect(newSource).toContain('originalWorkingDir: effectiveDraft.workingDir,');
    expect(newSource).toContain('precreatedWorktree,');
  });

  it('keeps branch selection independent from the worktree checkbox', () => {
    const disabledStart = newSource.indexOf('const worktreeBranchDisabled =');
    const disabledEnd = newSource.indexOf(';', disabledStart);
    expect(disabledStart).toBeGreaterThan(-1);
    expect(newSource.slice(disabledStart, disabledEnd + 1)).not.toContain('worktreeEnabled');

    const selectStart = newSource.indexOf('const selectWorktreeSourceBranch = useCallback(');
    const selectEnd = newSource.indexOf('// —— worktree 勾选播种', selectStart);
    const selectBlock = newSource.slice(selectStart, selectEnd);
    expect(selectBlock).toContain('maker.applyNewMakerWorktreeBranchPref(');
    expect(selectBlock).not.toContain('toggleWorktree');
    expect(selectBlock).not.toContain('maker.applyNewMakerWorktreePref(');
    expect(newSource).toContain('maker.getNewMakerWorktreeBranchPref(baseRepo)');
    expect(newSource).toContain('useRemoteNewMakerWorktreeBranchPreference(');
    expect(newSource).toContain('testID="newSession.worktreeBranchPicker"');
    expect(newSource).toContain('testID="newSession.worktreeToggle"');
    expect(newSource).toContain("t('session.new.worktreeShortLabel')");
    expect(newSource).not.toContain('>worktree</Text>');
  });

  it('keeps Goal on the same worktree contract as ordinary creation', () => {
    const goalStart = newSource.indexOf('const createGoalSession = useCallback(');
    const goalEnd = newSource.indexOf('\n\n  return (', goalStart);
    const goalBody = newSource.slice(goalStart, goalEnd);
    const gate = goalBody.indexOf('if (worktreeCreateBlocked) {');
    const worktreeCreate = goalBody.indexOf(
      'await maker.worktree.create(createRequest)',
    );
    const sessionCreate = goalBody.indexOf('maker.createSession(createOpts)');

    expect(goalStart).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(worktreeCreate).toBeGreaterThan(gate);
    expect(sessionCreate).toBeGreaterThan(worktreeCreate);
    expect(goalBody).toContain('id: sessionId,');
    expect(goalBody).toContain('effectiveDraft = { ...draft, workingDir: response.meta.path };');
    expect(goalBody).toContain('sessionId: precreatedWorktree!.sessionId');
    expect(goalBody).toContain('sessionId: precreatedWorktree.sessionId');
  });

  it('does not couple OFF creation to branch writes, while closing checkbox and branch same-tick races', () => {
    expect(newSource).toContain('|| (worktreeEnabled && worktreeBranchPreferenceSaving)');
    expect(newSource).toContain('worktreePreferenceWriteTargetRef.current = targetDeviceId;');
    expect(newSource).toContain('worktreeBranchPreferenceWriteTargetRef.current = key;');
    const createStart = newSource.indexOf('const create = useCallback(async () => {');
    const goalStart = newSource.indexOf('const createGoalSession = useCallback(');
    expect(newSource.slice(createStart, goalStart)).toContain(
      'worktreePreferenceWriteTargetRef.current === selectedDeviceId',
    );
    expect(newSource.slice(goalStart, goalStart + 2_000)).toContain(
      'worktreePreferenceWriteTargetRef.current === selectedDeviceId',
    );
    expect(newSource.slice(createStart, goalStart)).toContain(
      'worktreeBranchPreferenceWriteTargetRef.current === worktreeBranchPreferenceKey',
    );
    expect(newSource.slice(goalStart, goalStart + 2_500)).toContain(
      'worktreeBranchPreferenceWriteTargetRef.current === worktreeBranchPreferenceKey',
    );
    expect(newSource).toContain('disabled={worktreeCreateBlocked}');
  });

  it('keeps branch preference GET fail-closed except for explicit old-channel compatibility', () => {
    const pullStart = newSource.indexOf('const seq = ++worktreeBranchPreferencePullSeqRef.current;');
    const pullEnd = newSource.indexOf('\n  }, [', pullStart);
    const pullBody = newSource.slice(pullStart, pullEnd);
    expect(pullBody).toContain('if (isWorktreeChannelNotAllowedError(err))');
    expect(pullBody).not.toContain('setWorktreeBranchPreferenceReadyKey(syncKey);\n      });');
    expect(pullBody).toContain('const newerPush = remoteSessionStore.getNewMakerWorktreeBranchPreference(');
    expect(pullBody).toContain('worktreeBranchPreferenceReadyKeyRef.current = null;');
    expect(pullBody).toContain('isValidWorktreeBranchPreferenceSnapshot(snapshot, baseRepo)');
  });

  it('propagates recovery ownership probe failures instead of treating them as unclaimed', () => {
    const recoveryCalls = newSource.match(/isExactRemoteSessionClaimed\(/g) ?? [];
    expect(recoveryCalls).toHaveLength(3); // ordinary + Goal recovery + Goal compensation
    expect(newSource).not.toContain('return false;\n            }\n          },\n          shouldDefer:');
  });

  it('applies the protocol timeout override map to mobile invokes (worktree:create needs 60s)', () => {
    // 2026-07-29 与 main 合并后,移动端逐通道超时统一走 invokeTimeouts 的
    // resolveMobileInvokeTimeoutMs(mobile 专属表 → 协议契约表 INVOKE_TIMEOUT_OVERRIDES_MS
    // 兜底),worktree:create 的 60s 预算经协议表兜底生效——两层缺一都会让
    // 被控端建完 worktree 而控制端已超时放弃。
    const contextSource = readTextLf(
      resolve(process.cwd(), 'src/device-link/DeviceLinkContext.tsx'),
      'utf8',
    );
    expect(contextSource).toContain('resolveMobileInvokeTimeoutMs(channel)');
    const timeoutsSource = readTextLf(
      resolve(process.cwd(), 'src/device-link/invokeTimeouts.ts'),
      'utf8',
    );
    expect(timeoutsSource).toContain('INVOKE_TIMEOUT_OVERRIDES_MS[channel]');
  });
});

describe('submit guard catalog wiring (source locks)', () => {
  // 提交终检目录取信的接线不变量(纯函数测试覆盖不到的 new.tsx 接线):
  //  - 两处守卫(create / createGoalSession)都必须走 resolveSubmitGuardCatalog
  //    (代际安全:唯一数据源 = 设备缓存 + 代际,不再读渲染期 rows——catalogReadyRef
  //    是渲染镜像,驱逐窗口内不可信,独立 review P1-1);
  //  - 守卫内 buildRows 重建必须带 selectedModelId/selectedProviderId —— 缺了就没有
  //    keepSelected 豁免,被被控端隐藏 override 的选中行会被过滤出终检 rows,
  //    手动选中的模型被静默联合回退(独立 review P2);
  //  - 两处守卫都必须全程设备守卫(切设备放弃创建,Greptile P1 跨设备混用):
  //    deviceAtCreate 捕获 + ensureDeviceAlive/abortIfDeviceSwitched,handoff
  //    (startNewSessionCreation / maker.createSession / goal.set)前必复核;
  //    已 precreate 后失配必须走 ledger 补偿(forgetPendingPrecreatedWorktree)。
  const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');

  it('both submit guards resolve catalog trust via the generation-safe helper', () => {
    const guardCalls = newSource.match(/resolveSubmitGuardCatalog\(\{/g) ?? [];
    expect(guardCalls.length).toBe(2);
    // 守卫不再消费渲染期 rows / catalogReadyRef
    const staleReady = newSource.match(/resolveGuardCatalog\(\s*catalogReadyRef\.current,/g) ?? [];
    expect(staleReady.length).toBe(0);
    expect(newSource).toContain('getCachedDeviceProviders(guardDeviceId)');
    expect(newSource).toContain('getDeviceProvidersGen(guardDeviceId)');
  });

  it('every catalog rebuild in the guards passes the keepSelected exemption pair', () => {
    // 两处守卫内的 buildRows(2 处)带 effectiveDraft 豁免对 + 渲染期(1 处)带 draft
    // + 轮次 35 create 管线 revalidate(1 处)带 effectiveDraft 豁免对 = 4 处
    // (轮次 36 删除了 Goal 路径的旧 authResult fresh 校验——时间序错误,guard
    // 已用 fetchDeviceProvidersFresh 强制刷新,不再二次校验)。
    const selectedModel = newSource.match(/selectedModelId: (effectiveDraft|draft|selected)\.model,/g) ?? [];
    const selectedProvider = newSource.match(/selectedProviderId: (effectiveDraft|draft|selected)\.providerId,/g) ?? [];
    expect(selectedModel.length).toBe(4);
    expect(selectedProvider.length).toBe(4);
  });

  it('both guards are device-guarded through to the handoff, with ACK-gated ledger compensation after precreate', () => {
    // 设备快照取自闭包 selectedDeviceId(独立 review P1-1)+ 入口立即与 ref 核对
    expect(newSource.match(/const deviceAtCreate = selectedDeviceId;/g) ?? []).toHaveLength(2);
    expect(newSource.match(/if \(selectedDeviceRef\.current !== deviceAtCreate\) return;/g) ?? []).toHaveLength(2);
    expect(newSource.match(/const ensureDeviceAlive = \(\): boolean =>/g) ?? []).toHaveLength(2);
    expect(newSource.match(/const abortIfDeviceSwitched = async/g) ?? []).toHaveLength(2);
    expect(newSource.match(/compensatePrecreatedWorktree\(\{/g) ?? []).toHaveLength(2);
    expect(newSource.match(/parseAck: parseDiscardPrecreatedAck,/g) ?? []).toHaveLength(2);
    // 真局部 slice(独立 review round-22 Standards P1:全文件 indexOf 命中 create 首个
    // 检查,Goal 检查删掉也照样绿)
    const createSlice = newSource.slice(
      newSource.indexOf('const create = useCallback'),
      newSource.indexOf('const createGoalSession = useCallback'),
    );
    const goalSlice = newSource.slice(newSource.indexOf('const createGoalSession = useCallback'));
    // 入口设备检查先于加锁(round-20 Standards P1 busy 泄漏):goal 的 setGoalBusy(true)
    // 前必须有该 return(create() 的检查在 try 内,finally 兜底,不要求此序)。
    // Standards P1:先断言 needle 存在(indexOf=-1 会让 -1<X 假通过)。
    const goalEntryCheck = goalSlice.indexOf('if (selectedDeviceRef.current !== deviceAtCreate) return;');
    const goalSetBusy = goalSlice.indexOf('setGoalBusy(true)');
    expect(goalEntryCheck).toBeGreaterThan(-1);
    expect(goalSetBusy).toBeGreaterThan(-1);
    expect(goalEntryCheck).toBeLessThan(goalSetBusy);
    // 有界稳定循环:两段各含「每轮 runGuard 后同步核对 genAt」+ 耗尽降 unknown/fail-open
    expect(createSlice.match(/if \(getDeviceProvidersGen\(guardDeviceId\) === guardResult\.genAt\) break;/g) ?? []).toHaveLength(1);
    // goal:prepare 循环(1)+ post-started 循环(前查 + 后查,2)+ 鉴权降级 re-fence(1)
    //   + 设备切换 commit 分支 re-fence(1)
    expect(goalSlice.match(/if \(getDeviceProvidersGen\(guardDeviceId\) === guardResult\.genAt\) break;/g) ?? []).toHaveLength(5);
    const failOpen = 'rows: [], catalogKnown: false, genAt: getDeviceProvidersGen(guardDeviceId),';
    const failOpenCount = (slice: string): number =>
      slice.split(failOpen).length - 1;
    expect(failOpenCount(createSlice)).toBe(2); // 哨兵 + 耗尽
    expect(failOpenCount(goalSlice)).toBe(5); // 哨兵 + prepare 耗尽 + started 后耗尽 + 鉴权降级 re-fence + 设备切换 re-fence
    // create:apply 后零 await 直至 handoff(同一 turn)。Standards P1:endpoint 必须
    // 在 apply 之后(endpoint 前移会让空 slice 假通过零 await)。
    const createApply = createSlice.indexOf('applyGuard(guardResult);');
    const createHandoff = createSlice.indexOf('startNewSessionCreation({');
    expect(createApply).toBeGreaterThan(-1);
    expect(createHandoff).toBeGreaterThan(createApply);
    const createBetween = createSlice
      .slice(createApply, createHandoff)
      .replace(/\/\/[^\n]*/g, '');
    expect(createBetween).not.toMatch(/await /);
    // goal:最后核对后零 await 至 createSession(apply 前的 downgrade 分支是切换时早退,不在此段)
    const goalApply = goalSlice.indexOf('applyGuard(guardResult);');
    const goalCreate = goalSlice.indexOf('const created = await maker.createSession');
    expect(goalApply).toBeGreaterThan(-1);
    expect(goalCreate).toBeGreaterThan(goalApply);
    const goalBetween = goalSlice
      .slice(goalApply, goalCreate)
      .replace(/\/\/[^\n]*/g, '');
    expect(goalBetween).not.toMatch(/await /);
    // 轮次 42 终检复核(独立审核者 P1):apply 前的设备复核必须是**同步快路径**——
    // 先 ensureDeviceAlive 同步判,未切换零 await 直达 handoff(维持零 await 不变量);
    // await abortIfDeviceSwitched 只允许出现在已切换的早退分支里。裸
    // `if (await abortIfDeviceSwitched())` 会让出微任务,ref 更新排队时打开竞态。
    // 注意 prepare 段(guard 循环前)的裸 await 复核是合法的「可取消 await」,
    // 断言只覆盖 guard 循环后到 apply 的 commit 前区段。
    const finalCheckMarker = '// 终检刷新(await 网络往返)期间设备可能已切换';
    const finalCheckStart = goalSlice.indexOf(finalCheckMarker);
    expect(finalCheckStart).toBeGreaterThan(-1);
    const goalFinalCheck = goalSlice.slice(finalCheckStart, goalApply);
    expect(goalFinalCheck).toContain('if (!ensureDeviceAlive()) {');
    expect(goalFinalCheck).not.toMatch(/if \(await abortIfDeviceSwitched\(\)\)/);
  });

  it('goal failure restore payload is single-use: cleared after goal.set success (independent reviewer P2)', () => {
    // 失败接回的 objective/limits 载荷(codex review P2)必须一次性消费:goal.set
    // 成功后清 goalRestore state 与路由参数(goalObjective/goalLimits/goalError),
    // 否则清掉该 Goal 重新挂载表单仍带旧输入、页面重挂载再次恢复旧值。
    const sessionSource = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    expect(sessionSource).toContain("from '@/session/goalLimitsRouteParam'");
    expect(sessionSource).toContain('parseGoalLimitsRouteParam(readRouteParam(params.goalLimits))');
    expect(sessionSource).toContain('setGoalRestore(null);');
    // 换代清理 effect 也含 setGoalRestore(null)(codex P2)——「一次性消费」锚定
    // handleSetGoal 成功路径的最后一处(lastIndexOf),不用首次命中。
    const setParamsBlock = sessionSource.slice(
      sessionSource.lastIndexOf('setGoalRestore(null);'),
      sessionSource.lastIndexOf('setGoalRestore(null);') + 400,
    );
    expect(setParamsBlock).toContain('goalObjective: undefined');
    expect(setParamsBlock).toContain('goalLimits: undefined');
    expect(setParamsBlock).toContain('goalError: undefined');
    // 一次性消费必须发生在 goal.set 成功之后(与表单关闭同一段),不是任意位置
    const goalSetSuccess = sessionSource.indexOf('await maker.goal.set({ sessionId, ...input });');
    const restoreClear = sessionSource.lastIndexOf('setGoalRestore(null);');
    expect(goalSetSuccess).toBeGreaterThan(-1);
    expect(restoreClear).toBeGreaterThan(goalSetSuccess);
    // initial 优先级:恢复载荷优先于 composer 文字带入;无载荷时 initialObjective
    // 仍从 composer 带入(旧行为)。渲染前按 sessionId 过滤(codex review P1):
    // 恢复值带 sessionId 归属,非当前任务立即失效,新表单不用旧目标初始化。
    expect(sessionSource).toContain('goalRestore && goalRestore.sessionId === sessionId ? goalRestore : undefined');
    const viewCall = sessionSource.slice(
      sessionSource.indexOf('initial={goalRestoreForSession}') - 200,
      sessionSource.indexOf('initial={goalRestoreForSession}') + 300,
    );
    expect(viewCall).toContain('initial={goalRestoreForSession}');
    expect(viewCall).toContain('initialObjective={goalRestoreForSession ? undefined : (draftRef.current.trim() || undefined)}');
  });

  it('goal 接回载荷按 sessionId 换代清理:切任务不残留旧 objective/limits(codex P2)', () => {
    // 任务抽屉 replaceParams 原地更新同一 SessionScreen 实例,goalRestore/goalError
    // 只在首次挂载初始化——sessionId 变化必须清理,否则新任务 Goal 表单预填旧目标、
    // 甚至把旧目标提交到新任务(codex review P2)。
    const sessionSource = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    // 换代清理 effect 存在:prevSessionIdRef 记录上次 sessionId,变化时清 goalRestore + goalError
    const cleanEffect = sessionSource.indexOf('prevSessionIdRef.current !== sessionId');
    expect(cleanEffect).toBeGreaterThan(-1);
    const effectBlock = sessionSource.slice(cleanEffect - 200, cleanEffect + 400);
    expect(effectBlock).toContain('setGoalRestore(null);');
    expect(effectBlock).toContain('setGoalError(null);');
    expect(effectBlock).toContain('prevSessionIdRef.current = sessionId;');
    // ref 与当前 sessionId 同步初始化(useRef(sessionId)):首次挂载 prev===cur 不触发
    // 清理,保留路由带入的接回值(与「一次性消费」语义兼容)
    const refInit = sessionSource.indexOf('useRef(sessionId)');
    expect(refInit).toBeGreaterThan(-1);
    expect(refInit).toBeLessThan(cleanEffect);
    // 清理 effect 依赖 sessionId;位于 goalRestore 定义之后(初始化完成才可能清)
    const restoreInit = sessionSource.indexOf('const [goalRestore, setGoalRestore]');
    expect(restoreInit).toBeGreaterThan(-1);
    expect(cleanEffect).toBeGreaterThan(restoreInit);
    // 一次性消费不依赖本 effect:handleSetGoal 成功路径仍显式清 goalRestore(防误删
    // 同任务内的路由清参语义)
    expect(sessionSource).toContain('setGoalRestore(null);');
  });

  it('goal 表单按 sessionId 重挂载:子表单内部 state 随任务换代重置(codex P2)', () => {
    // 第 58 轮只清理父层 goalRestore;ContextSheetGoalCreateForm 的
    // objective/limits/limitsTouched 只在挂载时 useState(initial) 初始化一次,
    // 同实例下不随 initial 清空——旧目标仍显示并可提交到新任务。key={sessionId}
    // 强制表单组件在任务换代时重挂载,内部字段从新 initial 重新初始化。
    const sessionSource = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const viewCall = sessionSource.indexOf('<ContextSheetGoalView');
    expect(viewCall).toBeGreaterThan(-1);
    const callBlock = sessionSource.slice(viewCall, viewCall + 120);
    expect(callBlock).toContain('key={sessionId}');
    // 表单内部确实只在挂载时读 initial(useState 初始化)——重挂载是唯一同步手段
    const viewSource = readTextLf(resolve(process.cwd(), 'src/session/ContextSheetGoalView.tsx'), 'utf8');
    expect(viewSource).toContain('useState(initial?.objective ?? \'\')');
    expect(viewSource).toContain('useState(initial?.limits != null)');
  });

  it('鉴权降级失败 commit 分支与设备切换同口径 re-fence(codex P2)', () => {
    // resolveStartedDowngradeOrCommit 的降级/恢复 await 窗口可能换代(来源恢复或
    // 替换为 B)——鉴权降级失败(commit)分支必须像设备切换 commit 分支一样重跑
    // 有界 runGuard + genAt 核对,否则用等待前的空/旧目录校准草稿(codex review P2)。
    const goalSlice = newSource.slice(newSource.indexOf('const createGoalSession = useCallback'));
    // 两处 commit 后的 re-fence(鉴权降级 + 设备切换)
    const reFences = goalSlice.match(/for \(let pass = 0; pass < 2; pass \+= 1\) \{\s*\n\s*guardResult = await runGuard\(\);/g) ?? [];
    expect(reFences.length).toBe(2);
    // 鉴权降级 commit 分支(agentAuthGateHint 之后)与设备切换分支(ensureDeviceAlive
    // 之后)之间,re-fence 循环位于各自 commit 判断之后;agentAuthGateHint 有 4 处,
    // 用 lastIndexOf 定位最晚的鉴权降级分支(在 resolveStartedDowngradeOrCommit 内)
    const authDowngrade = goalSlice.lastIndexOf('setGoalError(agentAuthGateHint(draft.agentKind));');
    expect(authDowngrade).toBeGreaterThan(-1);
    const afterAuth = goalSlice.slice(authDowngrade, authDowngrade + 800);
    expect(afterAuth).toMatch(/guardResult = await runGuard\(\);/);
    // re-fence 循环内每轮 runGuard 后同步设备检查(greptile P1):二次 runGuard 的
    // await 期间设备切换 → 提前 break,交设备切换分支按 started 语义降级,不再向
    // 旧设备 commit(会话落旧设备 + 当前页面无法接管 + 用户可能重复创建)。
    // 断言用位置比较(循环内 runGuard 之后、genAt break 之前有设备 break)。
    const runGuardIdx = afterAuth.indexOf('guardResult = await runGuard();');
    const deviceBreakIdx = afterAuth.indexOf('if (!ensureDeviceAlive()) break;');
    expect(runGuardIdx).toBeGreaterThan(-1);
    expect(deviceBreakIdx).toBeGreaterThan(-1);
    expect(deviceBreakIdx).toBeGreaterThan(runGuardIdx);
  });

  it('goal commit segment: started 后无裸 return,goal.set 先于本地同步(round-22 Spec P1-2/P1-3)', () => {
    const goalSlice = newSource.slice(newSource.indexOf('const createGoalSession = useCallback'));
    const iStarted = goalSlice.indexOf('sessionCreateStarted = true;');
    const iCreate = goalSlice.indexOf('maker.createSession(');
    expect(iStarted).toBeGreaterThan(0);
    expect(iCreate).toBeGreaterThan(iStarted);
    // started 可靠落账后到 createSession 之间:禁止 owner 中止与补偿式设备取消;
    // 唯一的 return 必须是「降级成功才 return」(downgrade-or-commit,独立 review round-22)
    const startedToCreate = goalSlice.slice(iStarted, iCreate);
    expect(startedToCreate).not.toMatch(/isCurrentOwner\(\)\) return;|abortIfDeviceSwitched/);
    expect(startedToCreate).toMatch(/if \(decision === 'downgraded'\) return;/);
    // started commit 段的 return 必须是 downgraded 分支(枚举全部 return;
    // 2 处 = 设备切换降级 + started 写盘后鉴权门禁降级,均降级成功才 return)
    const returns = startedToCreate.match(/return;/g) ?? [];
    expect(returns).toHaveLength(2);
    expect(startedToCreate).toContain('applyGuard(guardResult);');
    // 降级模式:started 失败与设备切换两处都 re-register phase precreated
    // (goal 区 phase:'precreated' 共 5 处:precreate 写盘 ×2 + 降级 ×3——
    // startedRecorded 失败降级 / 设备切换降级 / started 后鉴权门禁降级)
    expect(goalSlice.match(/phase: 'precreated',/g) ?? []).toHaveLength(5);
    // goal.set 先于 subscribe(session:)(本地同步属 settle 段)
    const iGoal = goalSlice.indexOf('maker.goal.set(');
    expect(iGoal).toBeGreaterThan(iCreate);
    expect(goalSlice.indexOf('subscribe(`session:${result.sessionId}`')).toBeGreaterThan(iGoal);
    // createSession 与 goal.set 之间无任何 owner/设备中止
    const between = goalSlice.slice(iCreate, iGoal);
    expect(between).not.toMatch(/isCurrentOwner\(\)\) return;|ensureDeviceAlive|abortIfDeviceSwitched/);
  });

  it('goal settle 段:goal.set 之后每处中止都是 owner + 设备双复核,切设备中止 settle(greptile P1)', () => {
    // goal.set 等待期间同账号可能切换设备:owner 检查拦不住,settle 若继续用旧
    // selectedDeviceId 会把设备 A 的会话写进当前页面并跳转设备 A 会话页,用户
    // 还会在设备 B 上重复创建——settle 每处中止必须并列设备复核(greptile P1)。
    const goalSlice = newSource.slice(newSource.indexOf('const createGoalSession = useCallback'));
    const settleStart = goalSlice.indexOf('── settle 段');
    expect(settleStart).toBeGreaterThan(0);
    const settleSlice = goalSlice.slice(settleStart, goalSlice.indexOf('router.replace({'));
    // settle 段不再有裸 owner 中止
    expect(settleSlice).not.toMatch(/if \(!isCurrentOwner\(\)\) return;/);
    const dualChecks = settleSlice.match(/!isCurrentOwner\(\) \|\| !ensureDeviceAlive\(\)\) return;/g) ?? [];
    // subscribe / getSession(前+后) / catch / upsert / waitForPendingUploads 后 = 7 处
    expect(dualChecks.length).toBeGreaterThanOrEqual(7);
    // 跳转是 settle 最后一步:最后一个复核点之后无 await(无设备切换窗口)
    const lastCheck = settleSlice.lastIndexOf('!ensureDeviceAlive()) return;');
    expect(lastCheck).toBeGreaterThan(0);
    expect(settleSlice.slice(lastCheck)).not.toMatch(/await /);
  });

  it('goal settle 只登记本机预览,不把目标文案写成用户改名', () => {
    const goalSlice = newSource.slice(newSource.indexOf('const createGoalSession = useCallback'));
    const settleSlice = goalSlice.slice(
      goalSlice.indexOf('── settle 段'),
      goalSlice.indexOf('router.replace({'),
    );
    expect(settleSlice).toContain('remoteSessionStore.setPendingTitlePreview(result.sessionId, session.title)');
    expect(settleSlice).not.toContain('persistRemoteGoalSessionTitle');
    expect(settleSlice).not.toContain('patchSessionMeta');
    expect(settleSlice).not.toContain('generateSessionTitle');
  });
});

describe('fast memory restore wiring (source locks)', () => {
  // Fast 记忆恢复的门控接线不变量(codex review P1):
  //  - 切/恢复 agent 两个恢复点的 agent 级门控必须只认**目标 agent** 的缓存能力表
  //    (targetAgentHasFast),不得直接用闭包里的 capabilities state(属于切换前 agent
  //    或冷启动 null);
  //  - 必须存在延迟恢复 effect:目标 caps 就绪后按 (agent, 来源, 模型) 记忆重评,
  //    通过才打开 fastMode——「永久清除合法记忆」与「恢复出目标不支持的 fast」
  //    两个故障形态都靠这对接线闭合。
  const newSource = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');

  it('both restore sites gate on target-agent cached capabilities, never the closure state', () => {
    const gated = newSource.match(/isFastRestorable\(next\.agentKind, next\.providerId, next\.model, rowsNow, targetAgentHasFast\(selectedDeviceId, next\.agentKind\)\)/g) ?? [];
    expect(gated.length).toBe(2);
    // 恢复点不再直接消费 capabilities state 做门控
    const stale = newSource.match(/isFastRestorable\(next\.agentKind[^)]*capabilities\?\.hasFastMode/g) ?? [];
    expect(stale.length).toBe(0);
  });

  it('defers the remembered-fast restore until target-agent capabilities arrive', () => {
    expect(newSource).toContain('function targetAgentHasFast(deviceId: string, agentKind: NewSessionAgentKind): boolean');
    // 延迟恢复 effect:记忆为 true 才评 + 门控用目标 agent 缓存能力表 + 写回前再核一次当前草稿
    // (来源 id 与 changeSelectedFastMode 同口径:显式 providerId 优先,默认路由用推断来源)
    expect(newSource).toContain('draftMemory.getFast(draft.agentKind, pid, draft.model) !== true');
    expect(newSource).toContain('targetAgentHasFast(selectedDeviceId, draft.agentKind)');
    expect(newSource).toContain('current.providerId === draft.providerId');
  });
});

describe('compensatePrecreatedWorktree —— 设备切换补偿分阶段(独立 review P1-3)', () => {
  // 不得在远端目录已产生后只删账本(forget 删唯一 ledger 行 → 远端目录永久孤儿):
  // precreated 阶段必须 discard 获严格 ACK 才 forget;ACK 失败/未知 → 保留 ledger。
  const ack = { discarded: true as const };
  const base = {
    sessionId: 's1',
    recoveryKey: 'rk1',
    createdAt: 1,
    discard: () => Promise.resolve(ack),
    parseAck: (v: unknown) => (v && (v as { discarded?: boolean }).discarded === true ? { discarded: true as const } : null),
    forget: () => Promise.resolve(),
    release: null,
  };

  it('precreated + discard 严格 ACK → forget + release,返回 discarded', async () => {
    const forget = vi.fn(() => Promise.resolve());
    const release = vi.fn();
    const res = await compensatePrecreatedWorktree({ ...base, phase: 'precreated', forget, release });
    expect(res).toBe('discarded');
    expect(forget).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('precreated + discard ACK 非严格({discarded:false})→ 保留 ledger(不 forget),返回 retained', async () => {
    const forget = vi.fn(() => Promise.resolve());
    const res = await compensatePrecreatedWorktree({
      ...base,
      phase: 'precreated',
      discard: () => Promise.resolve({ discarded: false }),
      forget,
    });
    expect(res).toBe('retained');
    expect(forget).not.toHaveBeenCalled();
  });

  it('precreated + discard 抛错 → 保留 ledger(不 forget),返回 retained', async () => {
    const forget = vi.fn(() => Promise.resolve());
    const res = await compensatePrecreatedWorktree({
      ...base,
      phase: 'precreated',
      discard: () => Promise.reject(new Error('link down')),
      forget,
    });
    expect(res).toBe('retained');
    expect(forget).not.toHaveBeenCalled();
  });

  it('precreated + ACK 延迟到达且有效 → discard 后才 forget(顺序由 deferred 保证)', async () => {
    const d = deferred<unknown>();
    const forget = vi.fn(() => Promise.resolve());
    const pending = compensatePrecreatedWorktree({
      ...base,
      phase: 'precreated',
      discard: () => d.promise,
      forget,
    });
    await flush();
    expect(forget).not.toHaveBeenCalled(); // ACK 未到,绝不提前删账
    d.resolve(ack);
    const res = await pending;
    expect(res).toBe('discarded');
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('reserved(仅账本,无远端副作用)→ 直接 forget,不调 discard,返回 discarded', async () => {
    const discard = vi.fn(() => Promise.resolve(ack));
    const forget = vi.fn(() => Promise.resolve());
    const res = await compensatePrecreatedWorktree({ ...base, phase: 'reserved', discard, forget });
    expect(res).toBe('discarded');
    expect(discard).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledTimes(1);
  });
});

describe('resolveStartedDowngradeOrCommit —— started 落账后设备切换处置(round-23 Spec P1-1/P1-2)', () => {
  // 降级成功 → 'downgraded'(recovery 可回收);降级失败 → 恢复 volatile 回 started
  // 后 'commit'——防 recovery 读到可 discard 的 precreated 对未知创建做 destructive
  // discard(破坏「started 绝不回收未知创建」不变量)。
  const base = {
    downgrade: () => Promise.resolve(true),
    restoreStarted: () => Promise.resolve(),
  };

  it('downgrade 成功 → downgraded,不调 restoreStarted', async () => {
    const restoreStarted = vi.fn(() => Promise.resolve());
    const res = await resolveStartedDowngradeOrCommit({ ...base, restoreStarted });
    expect(res).toBe('downgraded');
    expect(restoreStarted).not.toHaveBeenCalled();
  });

  it('downgrade 返回 false → commit,且恢复 volatile started', async () => {
    const restoreStarted = vi.fn(() => Promise.resolve());
    const res = await resolveStartedDowngradeOrCommit({
      downgrade: () => Promise.resolve(false),
      restoreStarted,
    });
    expect(res).toBe('commit');
    expect(restoreStarted).toHaveBeenCalledTimes(1);
  });

  it('downgrade 抛错 → commit,且恢复 volatile started', async () => {
    const restoreStarted = vi.fn(() => Promise.resolve());
    const res = await resolveStartedDowngradeOrCommit({
      downgrade: () => Promise.reject(new Error('storage down')),
      restoreStarted,
    });
    expect(res).toBe('commit');
    expect(restoreStarted).toHaveBeenCalledTimes(1);
  });

  it('downgrade 延迟到达且为 false → 恢复在决策后才发生(顺序由 deferred 保证)', async () => {
    const d = deferred<boolean>();
    const restoreStarted = vi.fn(() => Promise.resolve());
    const pending = resolveStartedDowngradeOrCommit({
      downgrade: () => d.promise,
      restoreStarted,
    });
    await flush();
    expect(restoreStarted).not.toHaveBeenCalled();
    d.resolve(false);
    const res = await pending;
    expect(res).toBe('commit');
    expect(restoreStarted).toHaveBeenCalledTimes(1);
  });
});
