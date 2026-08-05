/**
 * scheduleFormLogic — Schedule 表单纯函数层测试。
 *
 * Cover 的关键设计点:
 *   1. buildScheduleInput heartbeat 分支 model/effort **恒带 key**(空值为
 *      undefined):update patch 走 schedulePatchToRow 的 hasKey 判定,
 *      key 在 + undefined → 写 NULL,是"跟随会话"清掉显式模型的唯一通道。
 *   2. heartbeat 分支既有约定回归:不带 workingDir、useWorktree=false、
 *      targetSessionId 透传。
 *   3. 非 heartbeat 分支不变:空 model **不带** key(锁住"不动 create 路径"
 *      的决策);codex 恒带 fastMode。
 *   4. RunMode 三态:deriveRunMode 映射、applyRunMode 转换与幂等、
 *      hasRealBinding 边界('' / '__pending__' / 空白串)。
 *   5. agentKind 映射('cc'→'claude-code')。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import type { ScheduleTemplate } from '@cindy/maker-scheduler';
import type { ProviderView } from '@cindy/model-providers';

import {
  PENDING_SESSION_ID,
  buildHookCommandForScriptFile,
  applyRunMode,
  buildScheduleInput,
  canSubmitSessionBinding,
  captureBinding,
  deriveRunMode,
  hasRealBinding,
  isExplicitScheduleModelUnavailable,
  resolveScheduleGenerationProviderId,
  resolveTemplateAgentFields,
  sessionAgentKindToScheduleAgentKind,
  shouldFollowBoundSessionGenerationRoute,
} from '../scheduleFormLogic';
import type { ScheduleFormState } from '../scheduleFormLogic';
import {
  cronExprToIntervalMs,
  intervalMsToCronExpr,
  resolveScheduleTimingPresentation,
  switchScheduleTimingMode,
} from '../cronCodexPreset';

const tapsvcProvider: ProviderView = {
  id: 'tapsvc',
  name: 'Tap Service',
  source: 'user',
  connected: true,
  agents: ['codex'],
  auth: { method: 'apiKey' },
  routing: { codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' } },
  models: {
    codex: [{
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 200_000,
      efforts: ['high'],
      defaultEffort: 'high',
    }],
  },
};

describe('resolveScheduleGenerationProviderId', () => {
  it('materializes the effective custom provider when the stored provider id is empty', () => {
    expect(resolveScheduleGenerationProviderId({
      providers: [tapsvcProvider],
      providerId: '',
      model: 'gpt-5.5',
      agentKind: 'codex',
    })).toBe('tapsvc');
  });

  it('returns null when the current agent cannot use the configured provider', () => {
    expect(resolveScheduleGenerationProviderId({
      providers: [tapsvcProvider],
      providerId: '',
      model: 'claude-sonnet-4-6',
      agentKind: 'claude-code',
    })).toBeNull();
  });

  it('preserves an explicit provider id while that provider is disconnected', () => {
    expect(resolveScheduleGenerationProviderId({
      providers: [{ ...tapsvcProvider, connected: false }],
      providerId: 'tapsvc',
      model: 'gpt-5.5',
      agentKind: 'codex',
    })).toBe('tapsvc');
  });
});

describe('shouldFollowBoundSessionGenerationRoute', () => {
  it('only follows a true bound session with empty provider and model', () => {
    expect(shouldFollowBoundSessionGenerationRoute({
      persistentSession: false,
      targetSessionId: 'session-1',
      providerId: '',
      model: '',
    })).toBe(true);
  });

  it('keeps the task route for persistent schedules after a session id is written back', () => {
    expect(shouldFollowBoundSessionGenerationRoute({
      persistentSession: true,
      targetSessionId: 'session-1',
      providerId: 'tapsvc',
      model: 'gpt-5.5',
    })).toBe(false);
  });
});

describe('isExplicitScheduleModelUnavailable', () => {
  it('does not reject an explicit model before capabilities are ready', () => {
    expect(isExplicitScheduleModelUnavailable('retained-model', undefined)).toBe(false);
  });

  it('rejects an explicit model missing from a completed capabilities snapshot', () => {
    expect(
      isExplicitScheduleModelUnavailable('removed-model', [{ id: 'available-model' }]),
    ).toBe(true);
  });

  it('allows blank follow-session semantics and available explicit models', () => {
    expect(isExplicitScheduleModelUnavailable('', [])).toBe(false);
    expect(isExplicitScheduleModelUnavailable('available-model', [{ id: 'available-model' }])).toBe(false);
  });
});

describe('canSubmitSessionBinding', () => {
  it('allows non-bound modes without resolving a session reference', () => {
    expect(canSubmitSessionBinding('agent', 'fresh', undefined)).toBe(true);
    expect(canSubmitSessionBinding('agent', 'persistent', undefined)).toBe(true);
  });

  it('only allows a bound session after it resolves as available and not archived', () => {
    expect(canSubmitSessionBinding('agent', 'bound', undefined)).toBe(false);
    expect(canSubmitSessionBinding('agent', 'bound', { sessionId: 'session-1', state: 'missing' })).toBe(false);
    expect(canSubmitSessionBinding('agent', 'bound', { sessionId: 'session-1', state: 'deleted' })).toBe(false);
    expect(canSubmitSessionBinding('agent', 'bound', { sessionId: 'session-1', state: 'available' })).toBe(true);
    expect(canSubmitSessionBinding('agent', 'bound', {
      sessionId: 'session-1',
      state: 'available',
      status: 'active',
    })).toBe(true);
    expect(canSubmitSessionBinding('agent', 'bound', {
      sessionId: 'session-1',
      state: 'available',
      status: 'archived',
    })).toBe(false);
  });

  it('allows script mode to clear an unavailable stale binding', () => {
    expect(canSubmitSessionBinding('script', 'bound', undefined)).toBe(true);
    expect(
      canSubmitSessionBinding('script', 'bound', { sessionId: 'session-1', state: 'deleted' }),
    ).toBe(true);
    expect(canSubmitSessionBinding('script', 'bound', {
      sessionId: 'session-1',
      state: 'available',
      status: 'archived',
    })).toBe(true);
  });
});

function makeForm(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    name: 'follow-up',
    prompt: 'check the PR',
    cronExpr: '*/10 * * * *',
    intervalMs: undefined,
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    model: '',
    providerId: '',
    effort: '',
    fastMode: false,
    workspaceKind: 'project',
    workingDir: '/repo/project',
    useWorktree: true,
    targetSessionId: '',
    persistentSession: false,
    silentWhenIdle: false,
    preRunHookEnabled: false,
    preRunHookCommand: '',
    preRunHookTimeoutSec: '',
    notifyDesktop: true,
    notifyFeishu: false,
    ...overrides,
  };
}

const hasKey = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

describe('schedule timing mode conversion', () => {
  it('preserves the authoritative interval when cronExpr is stale', () => {
    const input = buildScheduleInput(makeForm({
      cronExpr: '*/5 * * * *',
      intervalMs: 10 * 60_000,
      name: 'renamed only',
    }));

    expect(input.cronExpr).toBe('*/5 * * * *');
    expect(input.intervalMs).toBe(10 * 60_000);
  });

  it('keeps pure cron schedules in cron mode even for interval-shaped expressions', () => {
    const input = buildScheduleInput(makeForm({
      cronExpr: '*/10 * * * *',
      intervalMs: undefined,
    }));

    expect(hasKey(input, 'intervalMs')).toBe(true);
    expect(input.intervalMs).toBeUndefined();
  });

  it('converts only the minute/hour presets supported by the timing-mode switch', () => {
    expect(cronExprToIntervalMs('*/10 * * * *')).toBe(10 * 60_000);
    expect(intervalMsToCronExpr(10 * 60_000)).toBe('*/10 * * * *');
    expect(intervalMsToCronExpr(2 * 60 * 60_000)).toBe('0 */2 * * *');
    expect(intervalMsToCronExpr(90_000)).toBeUndefined();
  });

  it('uses an exact presentation instead of fabricating a five-minute preset', () => {
    expect(resolveScheduleTimingPresentation('*/5 * * * *', 90_000)).toEqual({
      kind: 'intervalExact',
    });
    expect(resolveScheduleTimingPresentation('*/5 * * * *', 10 * 60_000)).toEqual({
      kind: 'intervalPreset',
      displayCronExpr: '*/10 * * * *',
    });
  });

  it('switches between cron and relative interval without reusing a stale cron value', () => {
    expect(switchScheduleTimingMode('*/5 * * * *', 10 * 60_000, 'cron')).toEqual({
      cronExpr: '*/10 * * * *',
      intervalMs: undefined,
    });
    expect(switchScheduleTimingMode('*/2 * * * *', undefined, 'interval')).toEqual({
      cronExpr: '*/2 * * * *',
      intervalMs: 2 * 60_000,
    });
  });
});

function makeTemplate(overrides: Partial<ScheduleTemplate> = {}): ScheduleTemplate {
  return {
    id: 'template-1',
    name: 'template',
    description: 'template',
    category: 'code-quality',
    source: 'builtin',
    ...overrides,
  };
}

describe('buildScheduleInput — heartbeat 分支', () => {
  it('model/effort 空值时恒带 key 且值为 undefined(跟随会话 → patch 清列)', () => {
    const input = buildScheduleInput(makeForm({ targetSessionId: 'sess-1' }));
    expect(hasKey(input, 'model')).toBe(true);
    expect(input.model).toBeUndefined();
    expect(hasKey(input, 'effort')).toBe(true);
    expect(input.effort).toBeUndefined();
  });

  it('显式 model/effort 时带 trim 后的值', () => {
    const input = buildScheduleInput(
      makeForm({ targetSessionId: 'sess-1', model: ' claude-opus-4-8 ', effort: 'high' }),
    );
    expect(input.model).toBe('claude-opus-4-8');
    expect(input.effort).toBe('high');
  });

  it('providerId 空值时恒带 key 且值为 undefined(跟随会话来源 → patch 清列)', () => {
    const input = buildScheduleInput(makeForm({ targetSessionId: 'sess-1' }));
    expect(hasKey(input, 'providerId')).toBe(true);
    expect(input.providerId).toBeUndefined();
  });

  it('显式 providerId 时带 trim 后的值(钉到非原生来源)', () => {
    const input = buildScheduleInput(
      makeForm({ targetSessionId: 'sess-1', providerId: ' anthropic ' }),
    );
    expect(input.providerId).toBe('anthropic');
  });

  it('不带 workingDir、useWorktree 强制 false、targetSessionId 透传', () => {
    const input = buildScheduleInput(
      makeForm({ targetSessionId: 'sess-1', useWorktree: true, workingDir: '/repo' }),
    );
    expect(hasKey(input, 'workingDir')).toBe(false);
    expect(input.useWorktree).toBe(false);
    expect(input.targetSessionId).toBe('sess-1');
  });
});

describe('buildScheduleInput — 非 heartbeat 分支(行为锁定,不动 create 路径)', () => {
  it('空 model/effort 不带 key', () => {
    const input = buildScheduleInput(makeForm());
    expect(hasKey(input, 'model')).toBe(false);
    expect(hasKey(input, 'effort')).toBe(false);
  });

  it('空 providerId 不带 key(= 原生默认来源,no-break);显式值才带', () => {
    expect(hasKey(buildScheduleInput(makeForm()), 'providerId')).toBe(false);
    const pinned = buildScheduleInput(makeForm({ providerId: 'anthropic' }));
    expect(pinned.providerId).toBe('anthropic');
  });

  it('project 带 workingDir;codex 恒带 fastMode', () => {
    const input = buildScheduleInput(
      makeForm({ agentKind: 'codex', fastMode: false }),
    );
    expect(input.workingDir).toBe('/repo/project');
    expect(hasKey(input, 'fastMode')).toBe(true);
    expect(input.fastMode).toBe(false);
  });

  it('targetSessionId 空 → undefined(落库 null,解绑通道)', () => {
    const input = buildScheduleInput(makeForm());
    expect(input.targetSessionId).toBeUndefined();
  });

  it('透传静默运行开关', () => {
    expect(buildScheduleInput(makeForm()).silentWhenIdle).toBe(false);
    expect(buildScheduleInput(makeForm({ silentWhenIdle: true })).silentWhenIdle).toBe(true);
  });
});

describe('deriveRunMode', () => {
  it.each([
    [false, '', 'fresh'],
    [true, '', 'persistent'],
    [true, 'sess-1', 'persistent'],
    [false, PENDING_SESSION_ID, 'bound'],
    [false, 'sess-1', 'bound'],
  ] as const)('persistentSession=%s targetSessionId=%j → %s', (persistent, tgt, expected) => {
    expect(deriveRunMode({ persistentSession: persistent, targetSessionId: tgt })).toBe(expected);
  });
});

describe('applyRunMode', () => {
  it('fresh:双清', () => {
    const next = applyRunMode(
      makeForm({ persistentSession: true, targetSessionId: 'sess-1' }),
      'fresh',
    );
    expect(next.persistentSession).toBe(false);
    expect(next.targetSessionId).toBe('');
  });

  it('从 fresh 切 bound:置 __pending__ 占位', () => {
    const next = applyRunMode(makeForm(), 'bound');
    expect(next.persistentSession).toBe(false);
    expect(next.targetSessionId).toBe(PENDING_SESSION_ID);
  });

  it('bound(已有真实绑定)切 bound:保留 id 且返回原引用(幂等)', () => {
    const form = makeForm({ targetSessionId: 'sess-1' });
    expect(applyRunMode(form, 'bound')).toBe(form);
  });

  it('bound(真实绑定)切 persistent:保留绑定(非破坏性),persistentSession=true', () => {
    const next = applyRunMode(makeForm({ targetSessionId: 'sess-1' }), 'persistent');
    expect(next.persistentSession).toBe(true);
    expect(next.targetSessionId).toBe('sess-1');
  });

  it('已在 persistent(含 runner 回写的绑定)再切 persistent:返回原引用', () => {
    const form = makeForm({ persistentSession: true, targetSessionId: 'sess-1' });
    expect(applyRunMode(form, 'persistent')).toBe(form);
  });

  it('fresh 清空后凭 remembered 快照切回 bound:还原上次绑定(切换不丢绑定 bug 修复)', () => {
    const bound = makeForm({ targetSessionId: 'sess-1' });
    const snapshot = captureBinding(bound);
    const cleared = applyRunMode(bound, 'fresh');
    expect(cleared.targetSessionId).toBe('');
    const restored = applyRunMode(cleared, 'bound', snapshot);
    expect(restored.targetSessionId).toBe('sess-1');
    expect(restored.persistentSession).toBe(false);
  });

  it('fresh 切回 persistent 时同样还原 remembered 快照', () => {
    const bound = makeForm({ persistentSession: true, targetSessionId: 'sess-1' });
    const snapshot = captureBinding(bound);
    const cleared = applyRunMode(bound, 'fresh');
    const restored = applyRunMode(cleared, 'persistent', snapshot);
    expect(restored.persistentSession).toBe(true);
    expect(restored.targetSessionId).toBe('sess-1');
  });

  it('还原快照时 model/effort/fastMode/agentKind 整组恢复(防"跟随会话"被回填模型污染,PR #103 review)', () => {
    // 跟随会话任务(model 空)→ 切 fresh → 空 model 回填 effect 把 model 填成显式默认值
    const bound = makeForm({ targetSessionId: 'sess-1', model: '', effort: '', agentKind: 'claude-code' });
    const snapshot = captureBinding(bound);
    const cleared = applyRunMode(bound, 'fresh');
    const backfilled = { ...cleared, model: 'claude-sonnet-4-6', effort: 'high' as const };
    // 切回 bound:model 必须还原为 ''(跟随会话),否则保存会把默认模型 patch 给任务
    const restored = applyRunMode(backfilled, 'bound', snapshot);
    expect(restored.targetSessionId).toBe('sess-1');
    expect(restored.model).toBe('');
    expect(restored.effort).toBe('');
  });

  it('显式选过模型的绑定,快照还原后模型保留显式值', () => {
    const bound = makeForm({ targetSessionId: 'sess-1', model: 'claude-opus-4-8', effort: 'max' });
    const snapshot = captureBinding(bound);
    const cleared = applyRunMode(bound, 'fresh');
    const restored = applyRunMode(cleared, 'bound', snapshot);
    expect(restored.model).toBe('claude-opus-4-8');
    expect(restored.effort).toBe('max');
  });

  it('providerId 随快照整组还原(RunMode 切换不丢显式来源)', () => {
    const bound = makeForm({ targetSessionId: 'sess-1', model: 'claude-opus-4-8', providerId: 'anthropic' });
    const snapshot = captureBinding(bound);
    expect(snapshot?.providerId).toBe('anthropic');
    const cleared = applyRunMode(bound, 'fresh');
    const restored = applyRunMode(cleared, 'bound', snapshot);
    expect(restored.providerId).toBe('anthropic');
  });

  it('无 remembered 时 bound 仍置 __pending__ 占位', () => {
    const next = applyRunMode(makeForm(), 'bound', null);
    expect(next.targetSessionId).toBe(PENDING_SESSION_ID);
  });

  it('captureBinding:无真实绑定返回 null,占位不算绑定', () => {
    expect(captureBinding(makeForm())).toBeNull();
    expect(captureBinding(makeForm({ targetSessionId: PENDING_SESSION_ID }))).toBeNull();
    expect(captureBinding(makeForm({ targetSessionId: 'sess-1' }))?.targetSessionId).toBe('sess-1');
  });
});

describe('hasRealBinding / agentKind 映射', () => {
  it.each([
    ['', false],
    ['   ', false],
    [PENDING_SESSION_ID, false],
    ['sess-1', true],
  ] as const)('hasRealBinding(%j) = %s', (tgt, expected) => {
    expect(hasRealBinding({ targetSessionId: tgt })).toBe(expected);
  });

  it('sessionAgentKindToScheduleAgentKind 映射', () => {
    expect(sessionAgentKindToScheduleAgentKind('cc')).toBe('claude-code');
    expect(sessionAgentKindToScheduleAgentKind('codex')).toBe('codex');
  });
});

describe('resolveTemplateAgentFields', () => {
  const defaults = {
    getDefaultModel: (agentKind: ScheduleFormState['agentKind']) =>
      agentKind === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6',
    getAgentPrefs: (agentKind: ScheduleFormState['agentKind']) =>
      agentKind === 'codex'
        ? { providerId: 'openai', effort: 'high' as const, fastMode: true }
        : { providerId: 'anthropic', effort: 'medium' as const, fastMode: false },
  };

  it('模板跨 agent 且未显式给 model 时,重建目标 agent 的 model/provider/effort/fast 组合', () => {
    const fields = resolveTemplateAgentFields(
      makeForm({
        agentKind: 'codex',
        model: 'gpt-5.5',
        providerId: 'openai',
        effort: 'high',
        fastMode: true,
      }),
      makeTemplate({ agentKind: 'claude-code' }),
      defaults,
    );

    expect(fields).toEqual({
      agentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      effort: 'medium',
      fastMode: false,
    });
  });

  it('模板显式给 model/provider/effort/fast 时优先使用模板值', () => {
    const fields = resolveTemplateAgentFields(
      makeForm({ agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai', effort: 'high', fastMode: true }),
      makeTemplate({
        agentKind: 'claude-code',
        model: 'claude-opus-4-8',
        providerId: '',
        effort: 'xhigh',
        fastMode: false,
      }),
      defaults,
    );

    expect(fields).toEqual({
      agentKind: 'claude-code',
      model: 'claude-opus-4-8',
      providerId: '',
      effort: 'xhigh',
      fastMode: false,
    });
  });

  it('模板不切 agent 且未给模型字段时保留当前表单选择', () => {
    const current = makeForm({
      agentKind: 'codex',
      model: 'gpt-5.4',
      providerId: 'gateway',
      effort: 'medium',
      fastMode: false,
    });

    expect(resolveTemplateAgentFields(current, makeTemplate({ agentKind: 'codex' }), defaults)).toEqual({
      agentKind: 'codex',
      model: 'gpt-5.4',
      providerId: 'gateway',
      effort: 'medium',
      fastMode: false,
    });
  });
});

describe('buildHookCommandForScriptFile(脚本文件 → 调用命令)', () => {
  it('js/mjs → node;项目内转相对路径(正斜杠)', () => {
    expect(
      buildHookCommandForScriptFile('C:\\repo\\scripts\\check.mjs', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe('node scripts/check.mjs');
    expect(
      buildHookCommandForScriptFile('/repo/scripts/check.js', {
        workingDir: '/repo',
        platform: 'darwin',
      }),
    ).toBe('node scripts/check.js');
  });

  it('py → 平台分派 python/python3', () => {
    expect(
      buildHookCommandForScriptFile('C:\\x\\check.py', { platform: 'win32' }),
    ).toBe('python "C:/x/check.py"');
    expect(
      buildHookCommandForScriptFile('/x/check.py', { platform: 'darwin' }),
    ).toBe("python3 '/x/check.py'");
  });

  it('sh → bash;ps1 → 平台分派 powershell/pwsh', () => {
    expect(buildHookCommandForScriptFile('/x/gate.sh', { platform: 'darwin' })).toBe(
      "bash '/x/gate.sh'",
    );
    expect(
      buildHookCommandForScriptFile('C:\\x\\gate.ps1', { platform: 'win32' }),
    ).toBe('powershell -ExecutionPolicy Bypass -File "C:/x/gate.ps1"');
    // macOS/Linux 没有 powershell,只有 PowerShell Core(pwsh)
    expect(
      buildHookCommandForScriptFile('/x/gate.ps1', { platform: 'darwin' }),
    ).toBe("pwsh -ExecutionPolicy Bypass -File '/x/gate.ps1'");
  });

  it('直接执行分支(bat/exe/无扩展名):Windows 回写反斜杠(cmd 命令位置正斜杠不可靠)', () => {
    expect(buildHookCommandForScriptFile('C:\\x\\gate.bat', { platform: 'win32' })).toBe(
      `"C:${'\\'}x${'\\'}gate.bat"`,
    );
    // 项目内相对路径同样回写反斜杠(它是命令本身,不是解释器参数)
    expect(
      buildHookCommandForScriptFile('C:\\repo\\tools\\gate.exe', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe(`tools${'\\'}gate.exe`);
    // POSIX 直接执行保持正斜杠
    expect(buildHookCommandForScriptFile('/x/gate', { platform: 'darwin' })).toBe("'/x/gate'");
  });

  it('相对路径含 shell 元字符(无空格)也必须加引号(shell:true 下 & ( ) 会被解释)', () => {
    expect(
      buildHookCommandForScriptFile('/repo/scripts/check(weekday).mjs', {
        workingDir: '/repo',
        platform: 'darwin',
      }),
    ).toBe("node 'scripts/check(weekday).mjs'");
    expect(
      buildHookCommandForScriptFile('C:\\repo\\scripts\\check&skip.mjs', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe('node "scripts/check&skip.mjs"');
    // 直接执行分支同理(Windows 回写反斜杠后再判引号)
    expect(
      buildHookCommandForScriptFile('C:\\repo\\tools\\gate(x).exe', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe(`"tools${'\\'}gate(x).exe"`);
  });

  it('项目外绝对路径加引号;相对路径含空格也加引号', () => {
    expect(
      buildHookCommandForScriptFile('D:\\other\\check.mjs', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe('node "D:/other/check.mjs"');
    expect(
      buildHookCommandForScriptFile('C:\\repo\\my scripts\\check.mjs', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe('node "my scripts/check.mjs"');
  });

  it('Windows 大小写不敏感匹配工作目录;POSIX 敏感', () => {
    expect(
      buildHookCommandForScriptFile('c:\\Repo\\check.mjs', {
        workingDir: 'C:\\repo',
        platform: 'win32',
      }),
    ).toBe('node check.mjs');
    expect(
      buildHookCommandForScriptFile('/Repo/check.mjs', {
        workingDir: '/repo',
        platform: 'darwin',
      }),
    ).toBe("node '/Repo/check.mjs'");
  });
});

describe('buildScheduleInput — preRunHook 超时归一化', () => {
  const hookForm = (timeoutSec: string): ScheduleFormState =>
    makeForm({
      preRunHookEnabled: true,
      preRunHookCommand: 'node scripts/check.mjs',
      preRunHookTimeoutSec: timeoutSec,
    });

  it('显式 10s 原样落 10_000(默认超时已移除,不再有"等于默认就不落库"的过滤)', () => {
    const input = buildScheduleInput(hookForm('10'));
    expect(input.preRunHook?.command).toBe('node scripts/check.mjs');
    expect(input.preRunHook?.timeoutMs).toBe(10_000);
  });

  it('其它显式超时照常落显式值', () => {
    expect(buildScheduleInput(hookForm('60')).preRunHook?.timeoutMs).toBe(60_000);
  });

  it('空 / 非法超时 → undefined(不限时)', () => {
    expect(buildScheduleInput(hookForm('')).preRunHook?.timeoutMs).toBeUndefined();
    expect(buildScheduleInput(hookForm('abc')).preRunHook?.timeoutMs).toBeUndefined();
  });

  it('未启用时 preRunHook 恒带 key 且值 undefined(关闭落库的唯一通道)', () => {
    const input = buildScheduleInput(makeForm({ preRunHookEnabled: false }));
    expect(Object.prototype.hasOwnProperty.call(input, 'preRunHook')).toBe(true);
    expect(input.preRunHook).toBeUndefined();
  });
});

describe('formToProjectConfig — preRunHook 序列化(项目自动化)', () => {
  it('保留与 cronExpr 不一致的权威 intervalMs', async () => {
    const { formToProjectConfig } = await import('../projectAutomationConfig');
    const config = formToProjectConfig(
      makeForm({ cronExpr: '*/5 * * * *', intervalMs: 10 * 60_000 }),
      'auto-interval',
    );

    expect(config.cronExpr).toBe('*/5 * * * *');
    expect(config.intervalMs).toBe(10 * 60_000);
  });

  it('启用 hook 时写进 project config;未启用省略字段', async () => {
    const { formToProjectConfig } = await import('../projectAutomationConfig');
    const on = formToProjectConfig(
      makeForm({
        preRunHookEnabled: true,
        preRunHookCommand: 'node scripts/check.mjs',
        preRunHookTimeoutSec: '60',
      }),
      'auto-x',
    );
    expect(on.preRunHook).toEqual({ command: 'node scripts/check.mjs', timeoutMs: 60_000 });
    const off = formToProjectConfig(makeForm({ preRunHookEnabled: false }), 'auto-x');
    expect(off.preRunHook).toBeUndefined();
  });

  it('scheduleToProjectConfig 带回已配置的 hook(DB → schedules.json 不丢)', async () => {
    const { scheduleToProjectConfig } = await import('../projectAutomationConfig');
    const schedule = {
      id: 's1',
      name: 'n',
      prompt: 'p',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      useWorktree: false,
      persistentSession: false,
      silentWhenIdle: false,
      preRunHook: { command: 'node scripts/check.mjs', timeoutMs: 30_000 },
      notify: { desktop: true, feishu: false },
    } as never;
    const config = scheduleToProjectConfig(schedule, 'auto-x');
    expect(config.preRunHook).toEqual({ command: 'node scripts/check.mjs', timeoutMs: 30_000 });
  });
});
