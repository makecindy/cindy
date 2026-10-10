/**
 * 动态任务标题:纯逻辑(解析/拼装/形状/冷却)与编排守卫(开关/改名/冷却/失败静默)。
 * electron 依赖链全部 mock,只测注入面(工程规范 §3)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: vi.fn(),
}));

vi.mock('../../localDb/latestMessageText.js', () => ({
  regenerateTitleMaterial: vi.fn(),
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  persistSessionTitleIfStillDraft: vi.fn(async () => true),
  setOnSessionTurnEndedTitleRefresh: vi.fn(),
  setOnUserSessionTitleWritten: vi.fn(),
  getOverwritableAutoTitle: vi.fn(),
  isUntitledSessionAwaitingAutoTitle: vi.fn(),
}));

vi.mock('../../session-title-settings-store.js', () => ({
  readSessionTitleSettings: vi.fn(() => ({ dynamicTitleEnabled: true })),
}));

vi.mock('../../session-title-user-renames-store.js', () => ({
  hasPersistedManualSessionTitleRename: vi.fn(() => false),
  noteSessionTitleManuallyRenamed: vi.fn(),
}));

vi.mock('../sessionAutoTitle.js', () => ({
  hasSessionBeenManuallyRenamed: vi.fn(() => false),
  isSessionAutoTitleEligible: vi.fn(),
  registerSessionAutoTitleHooks: vi.fn(),
  runSessionAutoTitle: vi.fn(),
  scheduleSessionAutoTitle: vi.fn(),
  __resetSessionAutoTitleStateForTest: vi.fn(),
}));

vi.mock('../title.js', () => ({
  generateDynamicTitleViaProvider: vi.fn(),
  generateMakerSessionTitle: vi.fn(),
  regenerateMakerSessionTitle: vi.fn(),
}));

import {
  buildDynamicSessionTitle,
  formatShanghaiMonthDay,
  isDynamicTitlePattern,
  parseDynamicTitleModelOutput,
  shouldAttemptDynamicTitle,
} from '../dynamicSessionTitle.logic.js';
import {
  DYNAMIC_TITLE_MIN_INTERVAL_MS,
  refreshSessionDynamicTitle,
  resolveDynamicTitleEligibility,
  __resetSessionDynamicTitleStateForTest,
  type DynamicTitleDeps,
  type DynamicTitleSessionRow,
} from '../dynamicSessionTitle.js';

/** 2026-09-03 10:09:48 上海(= 02:09 UTC)。 */
const CREATED_AT_SHANGHAI_0903 = 1788412188769;

function makeRow(overrides: Partial<DynamicTitleSessionRow> = {}): DynamicTitleSessionRow {
  return {
    title: 'New Maker',
    createdAt: CREATED_AT_SHANGHAI_0903,
    agentKind: 'codex',
    source: 'desktop',
    orcaRole: null,
    status: 'active',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DynamicTitleDeps> = {}): DynamicTitleDeps {
  return {
    readSettings: vi.fn(() => ({ dynamicTitleEnabled: true })),
    readSessionRow: vi.fn(async () => makeRow()),
    collectMaterial: vi.fn(async () => ({
      opening: { text: '帮我看看最新的 issue', createdAt: null, rowid: 1 },
      recent: [
        { role: 'user' as const, text: '帮我看看最新的 issue', createdAt: null, rowid: 1 },
        { role: 'assistant' as const, text: '#3228 是自动生成的维护者确认门', createdAt: null, rowid: 2 },
      ],
    })),
    generateTitle: vi.fn(async () => ({ status: 'ok' as const, title: '修复｜维护者确认门分析' })),
    persistTitle: vi.fn(async () => true),
    hasBeenManuallyRenamed: vi.fn(() => false),
    now: vi.fn(() => 1_000_000),
    ...overrides,
  };
}

beforeEach(() => {
  __resetSessionDynamicTitleStateForTest();
});

describe('dynamicSessionTitle.logic', () => {
  it('formatShanghaiMonthDay converts epoch ms to MMDD in Asia/Shanghai', () => {
    expect(formatShanghaiMonthDay(CREATED_AT_SHANGHAI_0903)).toBe('0903');
    expect(formatShanghaiMonthDay(Date.UTC(2026, 7, 31, 17, 30))).toBe('0901');
  });

  it('parses full Chinese output and normalizes English type aliases', () => {
    expect(parseDynamicTitleModelOutput('修复｜Pi 开发者角色兼容')).toEqual({
      typeLabel: '修复',
      topic: 'Pi 开发者角色兼容',
    });
    expect(parseDynamicTitleModelOutput('FIX｜login error')).toEqual({
      typeLabel: '修复',
      topic: 'login error',
    });
    expect(parseDynamicTitleModelOutput('fix｜login error')).toEqual({
      typeLabel: '修复',
      topic: 'login error',
    });
    expect(parseDynamicTitleModelOutput(' 优化｜ 批量文字显示。 ')).toEqual({
      typeLabel: '优化',
      topic: '批量文字显示',
    });
  });

  it('rejects malformed output instead of guessing', () => {
    expect(parseDynamicTitleModelOutput('修复')).toBeNull();
    expect(parseDynamicTitleModelOutput('修复｜a｜b')).toBeNull();
    expect(parseDynamicTitleModelOutput('未知类型｜abc')).toBeNull();
    expect(parseDynamicTitleModelOutput('修复｜')).toBeNull();
    expect(parseDynamicTitleModelOutput(null)).toBeNull();
  });

  it('builds the final title and sanitizes separator runs in the topic', () => {
    expect(
      buildDynamicSessionTitle({ createdAtMs: CREATED_AT_SHANGHAI_0903, typeLabel: '修复', topic: 'Pi 开发者角色兼容' }),
    ).toBe('0903｜修复｜Pi 开发者角色兼容');
    expect(
      buildDynamicSessionTitle({ createdAtMs: CREATED_AT_SHANGHAI_0903, typeLabel: '研究', topic: 'a｜b' }),
    ).toBe('0903｜研究｜a b');
  });

  it('recognizes only its own Chinese shape as system-owned', () => {
    expect(isDynamicTitlePattern('0903｜修复｜x')).toBe(true);
    expect(isDynamicTitlePattern('0903｜FIX｜x')).toBe(false);
    expect(isDynamicTitlePattern('New Maker')).toBe(false);
  });

  it('enforces the per-session cooldown window', () => {
    expect(shouldAttemptDynamicTitle({ nowMs: 1000, lastAttemptMs: null, minIntervalMs: 60 })).toBe(true);
    expect(shouldAttemptDynamicTitle({ nowMs: 1000, lastAttemptMs: 990, minIntervalMs: 60 })).toBe(false);
    expect(shouldAttemptDynamicTitle({ nowMs: 1100, lastAttemptMs: 990, minIntervalMs: 60 })).toBe(true);
  });
});

describe('resolveDynamicTitleEligibility', () => {
  it('accepts placeholder and own-pattern titles', () => {
    expect(resolveDynamicTitleEligibility(makeRow(), false)).toEqual({
      ok: true,
      expectedTitle: 'New Maker',
      createdAtMs: CREATED_AT_SHANGHAI_0903,
      agentKind: 'codex',
    });
    expect(resolveDynamicTitleEligibility(makeRow({ title: '0903｜修复｜x' }), false).ok).toBe(true);
    expect(resolveDynamicTitleEligibility(makeRow({ title: '你好' }), false).ok).toBe(true);
  });

  it('skips renamed, archived, worker and hidden-source sessions', () => {
    expect(resolveDynamicTitleEligibility(makeRow(), true)).toEqual({ ok: false, reason: 'manually-renamed' });
    expect(resolveDynamicTitleEligibility(makeRow({ title: '我自己起的名字' }), false).ok).toBe(true);
    expect(resolveDynamicTitleEligibility(makeRow({ status: 'archived' }), false).ok).toBe(false);
    expect(resolveDynamicTitleEligibility(makeRow({ orcaRole: 'worker' }), false).ok).toBe(false);
    expect(resolveDynamicTitleEligibility(makeRow({ source: 'hidden-source' }), false).ok).toBe(false);
    expect(resolveDynamicTitleEligibility(makeRow({ orcaRole: 'lead' }), false).ok).toBe(true);
  });
});

describe('refreshSessionDynamicTitle', () => {
  it('is a no-op when the setting is off', async () => {
    const deps = makeDeps({ readSettings: vi.fn(() => ({ dynamicTitleEnabled: false })) });
    await expect(refreshSessionDynamicTitle('s1', deps)).resolves.toEqual({ applied: false });
    expect(deps.generateTitle).not.toHaveBeenCalled();
  });

  it('writes MMDD｜类型｜主题 via conditional persist on the happy path', async () => {
    const deps = makeDeps();
    await expect(refreshSessionDynamicTitle('s1', deps)).resolves.toEqual({ applied: true });
    expect(deps.persistTitle).toHaveBeenCalledWith('s1', '0903｜修复｜维护者确认门分析', 'New Maker');
  });

  it('skips without any model call when the session was manually renamed', async () => {
    const deps = makeDeps({ hasBeenManuallyRenamed: vi.fn(() => true) });
    await expect(refreshSessionDynamicTitle('s1', deps)).resolves.toEqual({ applied: false });
    expect(deps.generateTitle).not.toHaveBeenCalled();
  });

  it('rewrites first-message auto titles such as 你好', async () => {
    const deps = makeDeps({ readSessionRow: vi.fn(async () => makeRow({ title: '你好' })) });
    await expect(refreshSessionDynamicTitle('s1', deps)).resolves.toEqual({ applied: true });
    expect(deps.persistTitle).toHaveBeenCalledWith('s1', '0903｜修复｜维护者确认门分析', '你好');
  });

  it('throttles repeat attempts within the cooldown window', async () => {
    const deps = makeDeps();
    await refreshSessionDynamicTitle('s1', deps);
    await refreshSessionDynamicTitle('s1', deps);
    expect(deps.generateTitle).toHaveBeenCalledTimes(1);
    await refreshSessionDynamicTitle('s2', deps);
    expect(deps.generateTitle).toHaveBeenCalledTimes(2);
  });

  it('keeps the current title when generation fails or output is unparseable', async () => {
    const failing = makeDeps({
      generateTitle: vi.fn(async () => ({ status: 'failed' as const })),
    });
    await expect(refreshSessionDynamicTitle('s1', failing)).resolves.toEqual({ applied: false });
    expect(failing.persistTitle).not.toHaveBeenCalled();

    const unparseable = makeDeps({ generateTitle: vi.fn(async () => ({ status: 'ok' as const, title: '看不出主题' })) });
    await expect(refreshSessionDynamicTitle('s1', unparseable)).resolves.toEqual({ applied: false });
    expect(unparseable.persistTitle).not.toHaveBeenCalled();
  });

  it('does not persist when the generated title equals the current one', async () => {
    const same = makeDeps({
      readSessionRow: vi.fn(async () => makeRow({ title: '0903｜修复｜维护者确认门分析' })),
    });
    await expect(refreshSessionDynamicTitle('s1', same)).resolves.toEqual({ applied: false });
    expect(same.persistTitle).not.toHaveBeenCalled();
  });

  it('records failed attempts into the cooldown window as well', async () => {
    const deps = makeDeps({
      generateTitle: vi.fn(async () => ({ status: 'failed' as const })),
    });
    await refreshSessionDynamicTitle('s1', deps);
    await refreshSessionDynamicTitle('s1', deps);
    expect(deps.generateTitle).toHaveBeenCalledTimes(1);
    expect(DYNAMIC_TITLE_MIN_INTERVAL_MS).toBeGreaterThan(0);
  });
});
