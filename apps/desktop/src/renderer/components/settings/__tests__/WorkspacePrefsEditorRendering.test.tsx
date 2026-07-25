// @vitest-environment jsdom

/**
 * 工作目录偏好行必须复用应用标准选择器,不许再私搭下拉。
 *
 * 回归目标(2026-07 用户定稿): 这一行曾自建裸下拉,把 'claude-code' 原始 id 直接
 * 露给用户、自己拼一遍可选模型清单、effort 显示未经 i18n 的 low/medium/high。
 * 这里锁三件事: 三个字段分别落在 VendorSegmentedSwitcher / ModelSelector /
 * PermissionSelector 上;effort 没有独立控件(并进模型 trigger);禁用态整行同步。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspacePrefsEditor, type HookWorkspacePrefsState } from '../HookWorkspacePrefsEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: (agent: 'codex' | 'claude-code') => ({
    capabilities: {
      availableModels: [
        { id: agent === 'codex' ? 'gpt-5.5' : 'claude-opus-4-8', efforts: ['high'], defaultEffort: 'high' },
      ],
      permissionModes: [{ id: 'bypassPermissions', displayName: 'Bypass permissions' }],
    },
    loading: false,
    error: null,
  }),
}));

// 两个重依赖选择器只验「用了它、参数对」,内部行为由各自的测试负责。
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    effort: string;
    vendorKey: string;
    triggerVariant?: string;
    disabled?: boolean;
    onProviderChange?: (providerId: string | null, modelId?: string) => void;
    onModelChange: (modelId: string) => void;
  }) => (
    <div
      data-testid="model-selector"
      data-model={props.modelId}
      data-effort={props.effort}
      data-vendor={props.vendorKey}
      data-trigger-variant={props.triggerVariant}
      data-disabled={String(props.disabled)}
      // onProviderChange 是「供应商分段模式」的开关(ModelSelector 内部
      // sourcesEnabled = !!onProviderChange),这里暴露出来供断言。
      data-sources-enabled={String(props.onProviderChange !== undefined)}
      onClick={() => props.onModelChange('gpt-5.5')}
    />
  ),
}));

vi.mock('@/components/new-chat/PermissionSelector', () => ({
  PermissionSelector: (props: {
    permissionMode: string;
    vendorKey: string;
    triggerVariant?: string;
    disabled?: boolean;
  }) => (
    <div
      data-testid="permission-selector"
      data-mode={props.permissionMode}
      data-vendor={props.vendorKey}
      data-trigger-variant={props.triggerVariant}
      data-disabled={String(props.disabled)}
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
});

describe('WorkspacePrefsEditor 复用标准选择器', () => {
  it('三个字段分别落在标准组件上,且都用 field 形态', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    // agent: VendorSegmentedSwitcher 的品牌分段(真实渲染),不再是露原始 id 的下拉
    const tablist = screen.getByRole('tablist', { name: 'Vendor switcher' });
    expect(screen.getByRole('tab', { name: 'Claude' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Codex' }).getAttribute('aria-selected')).toBe('false');
    expect(tablist.textContent).not.toContain('claude-code');

    const model = screen.getByTestId('model-selector');
    expect(model.getAttribute('data-model')).toBe('claude-opus-4-8');
    expect(model.getAttribute('data-vendor')).toBe('cc');
    expect(model.getAttribute('data-trigger-variant')).toBe('field');

    const permission = screen.getByTestId('permission-selector');
    expect(permission.getAttribute('data-mode')).toBe('bypassPermissions');
    expect(permission.getAttribute('data-vendor')).toBe('cc');
    expect(permission.getAttribute('data-trigger-variant')).toBe('field');
  });

  it('模型选择器不开供应商分段(偏好表无 providerId,分段会造成选 A 落 B)', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith()} />);

    // 开分段会按 (供应商, 模型) 列多行,但只能落一个 model id,来源仍由派发侧按
    // nativeDefaultSourceId 解析(claude-code 一律优先 'xd')—— 用户点「订阅版
    // Opus 5」当场被重映射成「Cindy AI 的 Opus 5」(2026-07 用户实测)。
    // 等偏好表支持 providerId 再开;在那之前这个断言必须是 false。
    expect(screen.getByTestId('model-selector').getAttribute('data-sources-enabled')).toBe('false');
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

    expect(screen.getByRole('tablist', { name: 'Vendor switcher' }).className).toContain(
      'pointer-events-none',
    );
    expect(screen.getByTestId('model-selector').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('permission-selector').getAttribute('data-disabled')).toBe('true');
  });

  it('写入在途的目录同样整行禁用', () => {
    render(<WorkspacePrefsEditor alias="cindy" state={stateWith({ pendingWs: 'cindy' })} />);

    expect(screen.getByTestId('model-selector').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('permission-selector').getAttribute('data-disabled')).toBe('true');
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
});
