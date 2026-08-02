// @vitest-environment jsdom

/**
 * 工作目录偏好行必须复用应用标准选择器,不许再私搭下拉。
 *
 * 回归目标(2026-07 用户定稿): 这一行曾自建裸下拉,把 'claude-code' 原始 id 直接
 * 露给用户、自己拼一遍可选模型清单、effort 显示未经 i18n 的 low/medium/high。
 * 这里锁三件事: 三个字段分别落在 VendorSegmentedSwitcher / ModelSelector /
 * PermissionSelector 上;effort 没有独立控件(并进模型 trigger);禁用态整行同步。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspacePrefsEditor, type HookWorkspacePrefsState } from '../HookWorkspacePrefsEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// caps 可用性开关:capsUnavailable=true 模拟能力请求在途/失败(hook 返回 null),
// 供「分段不因 caps 缺失禁死」用例使用;afterEach 复位。
let capsUnavailable = false;
vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: (agent: 'codex' | 'claude-code') =>
    capsUnavailable
      ? { capabilities: null, loading: true, error: null }
      : {
          capabilities: {
            availableModels: [
              { id: agent === 'codex' ? 'gpt-5.5' : 'claude-opus-4-8', efforts: ['high'], defaultEffort: 'high' },
            ],
            permissionModes: [{ id: 'bypassPermissions', displayName: 'Bypass permissions' }],
          },
          loading: false,
          error: null,
        },
}));

// 两个重依赖选择器只验「用了它、参数对」,内部行为由各自的测试负责。
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    effort: string;
    vendorKey: string;
    triggerVariant?: string;
    maxVisibleModelRows?: number;
    disabled?: boolean;
    onProviderChange?: (providerId: string | null, modelId?: string) => void;
    onModelChange: (modelId: string) => void;
    reselectEmitsChange?: boolean;
    unknownModelLabel?: (modelId: string) => string;
    ariaContext?: string;
  }) => (
    <div
      data-testid="model-selector"
      data-model={props.modelId}
      data-effort={props.effort}
      data-vendor={props.vendorKey}
      data-trigger-variant={props.triggerVariant}
      data-max-visible-model-rows={props.maxVisibleModelRows}
      data-disabled={String(props.disabled)}
      data-aria-context={props.ariaContext ?? ''}
      // onProviderChange 是「供应商分段模式」的开关(ModelSelector 内部
      // sourcesEnabled = !!onProviderChange),这里暴露出来供断言。
      data-sources-enabled={String(props.onProviderChange !== undefined)}
      data-reselect-emits={String(props.reselectEmitsChange === true)}
      // 未知模型的 trigger 文案由调用方给出;这里回放它对一个不存在的 id 的结果。
      data-unknown-label={props.unknownModelLabel?.('ghost-model-1') ?? ''}
      onClick={() => props.onModelChange('gpt-5.5')}
      // 分段行点击(供应商, 模型)原子选择 —— 回放 onProviderChange 的行为锁触发器。
      onKeyDown={() => props.onProviderChange?.('anthropic', 'claude-opus-5')}
    />
  ),
}));

vi.mock('@/components/new-chat/PermissionSelector', () => ({
  PermissionSelector: (props: {
    permissionMode: string;
    vendorKey: string;
    triggerVariant?: string;
    disabled?: boolean;
    ariaContext?: string;
  }) => (
    <div
      data-testid="permission-selector"
      data-mode={props.permissionMode}
      data-vendor={props.vendorKey}
      data-trigger-variant={props.triggerVariant}
      data-disabled={String(props.disabled)}
      data-aria-context={props.ariaContext ?? ''}
    />
  ),
}));

const applyPatch = vi.fn();

function stateWith(overrides: Partial<HookWorkspacePrefsState> = {}): HookWorkspacePrefsState {
  return {
    prefsFor: () => ({
      workspace: 'cindy',
      model: 'claude-opus-4-8',
      effort: 'high',
      agentKind: 'claude-code',
      permissionMode: 'bypassPermissions',
    }),
    providerSourceFor: () => null,
    applyProviderSource: vi.fn(),
    editable: true,
    pendingWs: null,
    hint: null,
    retry: null,
    imDefaults: { agentKind: 'claude-code', agents: {} },
    applyPatch,
    teams: [],
    selectedTeamId: null,
    selectTeam: vi.fn(),
    showTeamChip: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  applyPatch.mockReset();
  capsUnavailable = false;
});

describe('WorkspacePrefsEditor 复用标准选择器', () => {
  it('三个字段分别落在标准组件上,且都用 field 形态', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} maxVisibleModelRows={6} />);

    // agent: VendorSegmentedSwitcher 的品牌分段(真实渲染),不再是露原始 id 的下拉
    const tablist = screen.getByRole('tablist', { name: 'settings.tina.prefs.agentLabel · cindy' });
    expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Codex' }).getAttribute('aria-selected')).toBe('false');
    expect(tablist.textContent).not.toContain('claude-code');

    const model = screen.getByTestId('model-selector');
    expect(model.getAttribute('data-model')).toBe('claude-opus-4-8');
    expect(model.getAttribute('data-vendor')).toBe('cc');
    expect(model.getAttribute('data-trigger-variant')).toBe('field');
    expect(model.getAttribute('data-max-visible-model-rows')).toBe('6');

    const permission = screen.getByTestId('permission-selector');
    expect(permission.getAttribute('data-mode')).toBe('bypassPermissions');
    expect(permission.getAttribute('data-vendor')).toBe('cc');
    expect(permission.getAttribute('data-trigger-variant')).toBe('field');
  });

  // 2026-07 用户定稿基准反转:全软件一个模型选择面板,处处同行为 —— 供应商分段
  // **必须开**。旧的「选 A 落 B」根因(选了来源没地方存)已由本地
  // workspaceProviderSourceStore 消除:来源落本地,model 照旧走 server prefs。
  it('模型选择器开供应商分段(composer 同款全功能形态)', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);
    expect(screen.getByTestId('model-selector').getAttribute('data-sources-enabled')).toBe('true');
  });

  // 双写串联(Greptile/codex review):model/effort 走远端 prefs patch,来源作为
  // applyPatch 第三参在远端成功后落本地 —— 不再各自 fire-and-forget(分裂态风险)。
  it('分段行选择:(模型, 来源)经 applyPatch 串联落库,不直接调 applyProviderSource', () => {
    const applyProviderSource = vi.fn();
    render(
      <WorkspacePrefsEditor alias="cindy" state={stateWith({ applyProviderSource })} />,
    );
    fireEvent.keyDown(screen.getByTestId('model-selector'));
    expect(applyPatch).toHaveBeenCalledWith(
      'cindy',
      expect.objectContaining({ model: 'claude-opus-5', agentKind: 'claude-code' }),
      'anthropic',
    );
    expect(applyProviderSource).not.toHaveBeenCalled();
  });

  it('选中模型落 model id,并随手写入 agent 配对', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    screen.getByTestId('model-selector').click();

    expect(applyPatch).toHaveBeenCalledWith('cindy', {
      model: 'gpt-5.5',
      agentKind: 'claude-code',
      effort: null,
    });
  });

  // 这一行的「当前模型」可能是从 IM 新会话默认解析出来的继承值(prefs.model === null)。
  // ModelSelector 默认把「点当前选中行」当无操作,于是用户点了没反应、之后上游默认一变
  // 这条偏好就被静默改掉 —— 必须开 reselectEmitsChange 才能把继承值钉成显式值。
  it('允许把继承来的模型钉成显式偏好(reselectEmitsChange)', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);
    expect(screen.getByTestId('model-selector').getAttribute('data-reselect-emits')).toBe('true');
  });

  it('继承态(prefs.model=null)下点当前模型仍写入显式偏好', () => {
    render(
      <WorkspacePrefsEditor
        alias="cindy"
        state={stateWith({
          prefsFor: () => ({
            workspace: 'cindy',
            model: null, // 跟随默认
            effort: null,
            agentKind: null,
            permissionMode: null,
          }),
        })}
      />,
    );

    screen.getByTestId('model-selector').click();

    expect(applyPatch).toHaveBeenCalledWith('cindy', expect.objectContaining({ model: 'gpt-5.5' }));
  });

  // 已存模型被隐藏 / 供应商断开 / 目录下架时,占位符「选择模型」会把「存过但不可用」
  // 显示成「没选过」,用户既看不到自己存的是什么、也无从判断 bot 为何没用它。
  it('已存模型不在可见清单时显示裸 id 而非占位符', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);
    expect(screen.getByTestId('model-selector').getAttribute('data-unknown-label')).toBe(
      'ghost-model-1',
    );
  });

  it('effort 并进模型选择器,不再有独立控件', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    expect(screen.getByTestId('model-selector').getAttribute('data-effort')).toBe('high');
    // 字段 label 只剩 agent / 模型 / 权限三个
    expect(screen.queryByText('settings.tina.prefs.effortLabel')).toBeNull();
    expect(screen.getByText('settings.tina.prefs.agentLabel')).toBeTruthy();
    expect(screen.getByText('settings.tina.prefs.modelLabel')).toBeTruthy();
    expect(screen.getByText('settings.tina.prefs.permissionLabel')).toBeTruthy();
  });

  it('codex 偏好映射到 codex 分段与 vendorKey', () => {
    render(
      <WorkspacePrefsEditor
        alias="cindy"
        state={stateWith({
          prefsFor: () => ({
            workspace: 'cindy',
            model: 'gpt-5.5',
            effort: 'high',
            agentKind: 'codex',
            permissionMode: 'bypassPermissions',
          }),
        })}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Codex' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('model-selector').getAttribute('data-vendor')).toBe('codex');
    expect(screen.getByTestId('permission-selector').getAttribute('data-vendor')).toBe('codex');
  });

  it('不可编辑时整行三个控件同步禁用', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith({ editable: false })} />);

    expect(screen.getByRole('tablist', { name: 'settings.tina.prefs.agentLabel · cindy' }).className).toContain(
      'pointer-events-none',
    );
    expect(screen.getByTestId('model-selector').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('permission-selector').getAttribute('data-disabled')).toBe('true');
  });

  // 容器上的 pointer-events-none 只挡鼠标:键盘仍能 Tab 到 tab 按钮并按 Enter,
  // 在只读态(未连接/未绑定)或写入在途时绕过禁用触发 applyPatch。必须是原生 disabled。
  it('禁用态的 agent 分段在按钮级禁用,键盘也进不去', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith({ editable: false })} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(3);
    for (const tab of tabs) expect((tab as HTMLButtonElement).disabled).toBe(true);

    tabs.find((t) => t.getAttribute('aria-selected') === 'false')?.click();
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('写入在途时同样按钮级禁用', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith({ pendingWs: 'cindy' })} />);
    for (const tab of screen.getAllByRole('tab')) {
      expect((tab as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('写入在途的目录同样整行禁用', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith({ pendingWs: 'cindy' })} />);

    expect(screen.getByTestId('model-selector').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('permission-selector').getAttribute('data-disabled')).toBe('true');
  });

  it('继承态(agentKind=null)下点当前 agent 段也写入显式偏好(reselectEmitsChange)', () => {
    render(
      <WorkspacePrefsEditor
        alias="cindy"
        state={stateWith({
          prefsFor: () => ({
            workspace: 'cindy',
            model: null,
            effort: null,
            agentKind: null, // 跟随默认(claude-code)
            permissionMode: null,
          }),
        })}
      />,
    );

    // 点当前显示的 Claude 段 = 把继承值钉成显式,否则 IM 默认一变这条目录被静默改掉
    screen.getByRole('tab', { name: 'Claude' }).click();
    expect(applyPatch).toHaveBeenCalledWith('cindy', {
      agentKind: 'claude-code',
      model: null,
      effort: null,
    });
  });

  it('未知/过期 agentKind 归一到默认 agent,分段控件不禁死', () => {
    render(
      <WorkspacePrefsEditor
        alias="cindy"
        state={stateWith({
          prefsFor: () => ({
            workspace: 'cindy',
            model: null,
            effort: null,
            agentKind: 'future-agent', // server 快照里的过期值
            permissionMode: null,
          }),
        })}
      />,
    );

    // 显示为默认 agent(claude-code)而非裸值;caps 可解析 → 整行不因 null caps 禁死
    expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-selected')).toBe('true');
    for (const tab of screen.getAllByRole('tab')) {
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }
    // 用户可以点 Codex 纠正过期值
    screen.getByRole('tab', { name: 'Codex' }).click();
    expect(applyPatch).toHaveBeenCalledWith('cindy', {
      agentKind: 'codex',
      model: null,
      effort: null,
    });
  });

  it('切换 agent 分段写入配对 patch(清掉旧模型/档位)', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    screen.getByRole('tab', { name: 'Codex' }).click();

    expect(applyPatch).toHaveBeenCalledWith('cindy', {
      agentKind: 'codex',
      model: null,
      effort: null,
    });
  });

  // 能力请求在途/失败(caps=null)不能把 agent 分段禁死:patchForAgentChange 只清
  // model/effort、不做能力校准,切 agent 不需要当前 agent 的清单;跟着禁会让瞬时
  // 失败变成死局,用户连切到另一个(可用的)agent 都不行(codex review 2026-07-25)。
  // 模型/权限字段的选项列表真的来自 caps,维持禁用。
  it('caps 未就绪: agent 分段仍可切换,模型/权限字段禁用', () => {
    capsUnavailable = true;
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    for (const tab of screen.getAllByRole('tab')) {
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }
    screen.getByRole('tab', { name: 'Codex' }).click();
    expect(applyPatch).toHaveBeenCalledWith('cindy', {
      agentKind: 'codex',
      model: null,
      effort: null,
    });
    expect(screen.getByTestId('model-selector').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('permission-selector').getAttribute('data-disabled')).toBe('true');
  });

  // 读屏可及名:三个字段都带「字段名 · 行别名」上下文,多卡片同屏行与行可区分
  // (tablist 直接命名;模型/权限经 ariaContext 前置到 trigger aria-label)。
  it('模型/权限字段带 alias 化 ariaContext', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    expect(screen.getByTestId('model-selector').getAttribute('data-aria-context')).toBe(
      'settings.tina.prefs.modelLabel · cindy',
    );
    expect(screen.getByTestId('permission-selector').getAttribute('data-aria-context')).toBe(
      'settings.tina.prefs.permissionLabel · cindy',
    );
  });
});
