import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  DEFAULT_NEW_SESSION_DRAFT,
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
  sessionFromCreateResult,
  serializeNewSessionDeviceOptions,
  summarizeNewSessionDraft,
  validateNewSessionDraft,
  withAgentDefaults,
} from '@/session/newSession';
import type { ProviderModelRow } from '@/session/providerModelSections';
import type { RemoteSession } from '@/session/types';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function modelRow(
  id: string,
  efforts: readonly string[] = [],
  defaultEffort: string | null = null,
): ProviderModelRow {
  return {
    provider: { id: `prov-${id}`, name: id } as ProviderModelRow['provider'],
    model: {
      id,
      displayName: id,
      efforts: efforts as ProviderModelRow['model']['efforts'],
      defaultEffort: defaultEffort as ProviderModelRow['model']['defaultEffort'],
      contextWindow: 0,
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

describe('pickMostRecentSessionRuntime', () => {
  it('picks the most recent session runtime (agent+model+effort), cc → claude-code', () => {
    const runtime = pickMostRecentSessionRuntime([
      remoteSession('old', { model: 'claude-opus-4-8', effort: 'high', userSendAt: '2026-01-01T00:00:01.000Z' }),
      remoteSession('new', { model: 'gpt-5.4', effort: 'low', agentKind: 'codex', userSendAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low' });
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
    });
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'high' });
  });

  it('reconciles the recent effort down to the model default when unsupported', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-5.4', effort: 'xhigh', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
    });
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low' });
  });

  it('keeps the recent effort when the recent model is not in modelRows (no SectionModel to reconcile)', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cx', { agentKind: 'codex', model: 'gpt-legacy', effort: 'high', userSendAt: '2026-01-01T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low')],
      currentEffort: 'medium',
    });
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-legacy', effort: 'high' });
  });

  it('falls back to the top of the target agent\'s model list when it has no recent session', () => {
    const runtime = pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [remoteSession('cc', { agentKind: 'cc', model: 'claude-opus-4-8', userSendAt: '2026-02-02T00:00:00.000Z' })],
      modelRows: [modelRow('gpt-5.4', ['low', 'medium'], 'low'), modelRow('gpt-mini', ['low'], 'low')],
      currentEffort: 'high', // 不被目标模型支持 → reconcile 到默认 'low'
    });
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low' });
  });

  it('falls back to DEFAULT_MODELS and keeps current effort when providers are not loaded yet', () => {
    expect(pickAgentDefaultRuntime({
      agentKind: 'codex',
      sessions: [],
      modelRows: [],
      currentEffort: 'medium',
    })).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'medium' });
    expect(pickAgentDefaultRuntime({
      agentKind: 'claude-code',
      sessions: [],
      modelRows: [],
      currentEffort: 'high',
    })).toEqual({ agentKind: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' });
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
    });
    expect(runtime).toEqual({ agentKind: 'codex', model: 'gpt-5.4', effort: 'low' });
  });
});

describe('resolveNewSessionAutoDefault', () => {
  const baseInput = {
    userTouched: false,
    appliedDeviceId: null as string | null,
    selectedDeviceId: 'devA',
    sessions: [] as RemoteSession[],
    modelRows: [] as ProviderModelRow[],
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

  it('intent ②: no recent session → top of the model list (model + reconciled effort, agentKind untouched)', () => {
    const result = resolveNewSessionAutoDefault({
      ...baseInput,
      currentEffort: 'high', // 不被首个模型支持 → reconcile 到默认 'low'
      modelRows: [modelRow('claude-sonnet-4-6', ['low', 'medium'], 'low'), modelRow('claude-haiku', ['low'], 'low')],
    });
    expect(result).toEqual({
      appliedDeviceId: 'devA',
      patch: { model: 'claude-sonnet-4-6', effort: 'low', providerId: null },
    });
    expect(result?.patch).not.toHaveProperty('agentKind');
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
    const homeSource = readFileSync(resolve(process.cwd(), 'app/devices/index.tsx'), 'utf8');
    // 筛选某台电脑时带显式标记;"所有对话"(selectedDeviceId=null)不带,保留记忆回落。
    expect(homeSource).toContain("...(selectedDeviceId ? { deviceExplicit: '1' } : {})");
  });

  it('treats the deviceExplicit route flag as an explicit device on the new-session screen', () => {
    const newSource = readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
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
        '电脑: Carol Mac',
        '位置: 未选择项目路径',
        '运行: Claude · claude-sonnet-4-6 · medium',
        '首条: 未填写',
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
      subtitle: '确认后会在被控电脑创建会话，并把首条消息加入队列。',
      details: [
        '电脑: Carol Mac',
        '位置: 对话工作区',
        '运行: Claude · claude-sonnet-4-6 · medium',
        '首条: 请帮我总结这个项目，并给出下一步建议。',
      ],
    });

    expect(buildNewSessionCreatePreview({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo/xdt-maker',
      firstMessage: '',
    }, 'Carol Mac', { attachmentCount: 2 })).toMatchObject({
      title: '准备创建并发送',
      details: [
        '电脑: Carol Mac',
        '位置: /repo/xdt-maker',
        '运行: Claude · claude-sonnet-4-6 · medium',
        '首条: 仅发送附件',
        '附件: 2 个',
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
    }, new Date('2026-06-16T10:00:00.000Z'))).toMatchObject({
      id: 's-new',
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
    }, new Date('2026-06-16T10:00:00.000Z'))).toMatchObject({
      id: 's-dialogue',
      workingDir: '/userData/dialogues/2026-06-16/s-dialogue',
      workspaceKind: 'dialogue',
      agentKind: 'codex',
    });

    expect(normalizeCreateSessionResult({ sessionId: '' })).toBeNull();
    expect(normalizeCreateSessionResult(null)).toBeNull();
  });
});

describe('new session composer surface', () => {
  it('does not double-apply the Android safe-area inset to the top navigation', () => {
    const newSource = readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');

    expect(newSource).toContain(
      "const NEW_SESSION_SCREEN_TOP_PADDING = Platform.OS === 'android' ? 0 : spacing.xl;",
    );
    expect(newSource).toContain('paddingTop: NEW_SESSION_SCREEN_TOP_PADDING,');
  });

  it('uses the shared platform keyboard avoidance rule for the new-session composer', () => {
    const newSource = readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const normalizedNewSource = newSource.replace(/\r\n/g, '\n');

    expect(newSource).toContain("import { keyboardAvoidingBehaviorForPlatform } from '@/session/mobileNativeShellLayout';");
    expect(normalizedNewSource).toContain(`behavior={keyboardAvoidingBehaviorForPlatform(
          Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        )}`);
    expect(newSource).not.toContain("Platform.OS === 'ios' ? 'padding' : undefined");
  });

  it('uses the shared mobile composer row rather than a separate input implementation', () => {
    const newSource = readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const sessionSource = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), 'src/session/MobileComposerInputRow.tsx'), 'utf8');
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
    const composerIconButtonEnd = newSource.indexOf('composerIconButtonActive:', composerIconButtonStart);
    const composerIconButtonStyle = newSource.slice(composerIconButtonStart, composerIconButtonEnd);
    const modelPillStart = newSource.indexOf('modelPill: {');
    const modelPillEnd = newSource.indexOf('modelPillText:', modelPillStart);
    const modelPillStyle = newSource.slice(modelPillStart, modelPillEnd);
    const modelPillTextStart = newSource.indexOf('modelPillText: {');
    const modelPillTextEnd = newSource.indexOf('sessionComposerInput:', modelPillTextStart);
    const modelPillTextStyle = newSource.slice(modelPillTextStart, modelPillTextEnd);
    const sessionComposerInputStart = newSource.indexOf('sessionComposerInput: {');
    const sessionComposerInputEnd = newSource.indexOf('inputVoiceHidden:', sessionComposerInputStart);
    const sessionComposerInputStyle = newSource.slice(sessionComposerInputStart, sessionComposerInputEnd);
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
    const storedAgentEnd = newSource.indexOf('// 新建对话默认运行配置', storedAgentStart);
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
    expect(newComposerSource).toContain('inputFrameHeight={composerResize.frameHeight}');
    expect(newComposerSource).toContain('resizeHandle={composerCardActive ? renderComposerResizeHandle() : null}');
    expect(newComposerSource).toContain('cardActive={composerCardActive}');
    expect(newComposerSource).toContain('toolbar={renderComposerToolbar()}');
    expect(newComposerSource).toContain('voicePlacement={composerVoicePlacement}');
    expect(newComposerSource).toContain('floatingVoiceButton={voiceUiAvailable ? renderComposerVoiceButton : undefined}');
    expect(newComposerSource).toContain('cursorColor={colors.inputCaret}');
    expect(newComposerSource).toContain('selectionColor={colors.inputCaret}');
    expect(newComposerSource).toContain('inputRef={firstMessageInputRef}');
    expect(newComposerSource).toContain('inputOverlay={renderComposerInputOverlay()}');
    expect(newComposerSource).toContain('inputStyle={[styles.sessionComposerInput, voiceIsListening && styles.inputVoiceHidden]}');
    expect(newComposerSource).toContain('onChangeText={setFirstMessageDraft}');
    expect(newComposerSource).toContain('onContentSizeChange={handleFirstMessageInputContentSizeChange}');
    expect(newComposerSource).toContain("placeholder={voiceIsListening ? '' : composerPlaceholder}");
    expect(newComposerSource).toContain('scrollEnabled={composerInputScrollEnabled}');
    expect(newComposerSource).toContain('trailing={composerCardActive || !composerShowCreateButton ? null : renderCreateButton()}');
    expect(newSource).toContain('const renderComposerToolbar = () => (');
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
    expect(sessionComposerInputStyle).toContain('fontSize: typeScale.listBody');
    expect(sessionComposerInputStyle).toContain('lineHeight: lineHeight.listBody');
    expect(sendButtonStyle).toContain('backgroundColor: colors.cta');
    expect(sendButtonStyle).toContain('borderColor: colors.cta');
    expect(sendButtonStyle).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(sendButtonStyle).toContain('height: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(sendButtonStyle).toContain('width: MOBILE_COMPOSER_CONTROL_SIZE');
    expect(sendButtonDisabledStyle).toContain('backgroundColor: colors.surfaceChip');
    expect(sendButtonDisabledStyle).toContain('borderColor: colors.border');
    // 模型 + 权限浮窗(ModelPickerSheet):工具排只剩 [+][模型 pill],独立权限按钮与
    // composer 上方 drop-up 面板均已移除,权限收进浮窗二级视图。
    expect(newSource).toContain('<ModelPickerSheet');
    expect(newSource).toContain('testID="newSession.modelSheet"');
    expect(newSource).not.toContain('testID="newSession.permissionButton"');
    expect(newSource).not.toContain('testID="newSession.permissionPanel"');
    expect(newSource).not.toContain('testID="newSession.modelPickerPanel"');
    expect(newSource).toContain('const composerShowCreateButton = composerHasMessage || attachments.length > 0 || pendingUploads.length > 0;');
    expect(newSource).toContain('const canCreate = !createValidation && !creating && !voiceIsProcessing;');
    expect(newSource).toContain('const deviceSelectorDisabled = creating || voiceIsProcessing || !deviceHasChoices;');
    expect(voiceButtonSource).toContain('onPress={toggleVoiceRecording}');
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
    expect(newSource).toContain('<VoiceMicWaveCaret color={colors.statusReady} testID="newSession.voiceMicCaret" />');
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
    expect(newSource).toContain('accessibilityState={{ busy: creating || voiceIsProcessing || undefined, disabled: !canCreate || undefined }}');
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
    expect(sharedSource).toContain('export const MOBILE_COMPOSER_CONTROL_SIZE = 34;');
    expect(sharedSource).toContain('export function resolveMobileComposerVoiceButtonPlacement');
    expect(sharedSource).toContain('voicePlacement?.inline || voicePlacement?.floating');
    expect(sharedSource).toContain('styles.voiceButtonAnchor,');
    expect(newSource).not.toContain('messageInput: {');
    expect(newSource).not.toContain('composerToolbar: {');
    expect(newSource).not.toContain('permissionIcon: {');
    expect(newSource).not.toContain('style={styles.messageInput}');
  });
});
