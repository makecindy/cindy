// @vitest-environment jsdom

// 2026-11-13 主人试用反馈：关系图里的来源只在被选中过之后才显示余量，同一个订阅账号的其它来源一片空白。
// 余量现在来自打开总览时只看不选的解析(与「试一下」同一份)，从没被选中过的来源也要显示。
// 真实入口：ModelGroupsOverview 渲染 + window.electronAPI.modelGroups 的 resolve / decisions。Tier: unit。
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelSelectorContentProps, ModelSelectorProps } from '@/components/new-chat/ModelSelector';
import type { ModelGroupResolveResult, ModelGroupsConfig } from '../../../../shared/modelGroups';

// 与真实 i18next 一样，t 与 i18n 在多次渲染之间保持同一个引用。
const i18nValue = { t: (key: string) => key, i18n: { language: 'en' } };
vi.mock('react-i18next', () => ({ useTranslation: () => i18nValue }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
const pickerSelections = new Map<string, Parameters<NonNullable<ModelSelectorProps['onUnifiedSelect']>>[0]>();
const openedEditors = vi.fn();
vi.mock('@/components/new-chat/ModelSelector', async () => {
  const { Popover, PopoverContent, PopoverTrigger } = await import('@/components/ui/popover');
  return {
  ModelSelectorPopover: ({ open, onOpenChange, trigger, children }: {
    open: boolean; onOpenChange: (open: boolean) => void; trigger: React.ReactElement; children: React.ReactNode;
  }) => (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent>{children}</PopoverContent>
    </Popover>
  ),
  ModelSelectorContent: ({ onUnifiedSelect, modelId, vendorKey, remoteAgent }: ModelSelectorContentProps) => {
    openedEditors(remoteAgent?.selectedDeviceId);
    return <button type="button" data-current-harness={vendorKey} onClick={() => {
      const selection = pickerSelections.get(modelId);
      if (selection) void onUnifiedSelect?.(selection);
    }}>save candidate</button>;
  },
  ProviderMark: () => null,
  ModelSelector: ({ onUnifiedSelect, modelId, vendorKey, remoteAgent }: ModelSelectorProps) => (
    <button type="button" data-current-harness={vendorKey} data-current-device={remoteAgent?.selectedDeviceId}
      onClick={() => {
        const selection = pickerSelections.get(modelId);
        if (selection) void onUnifiedSelect?.(selection);
      }}>
      {modelId || 'add candidate'}
    </button>
  ),
  };
});
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/hooks/useModelRouteDevices', () => ({ useModelRouteDevices: () => ({}) }));
// 与真实 hook 一样返回稳定的函数(真实实现经 useCallback)。
const namesOf = (candidate: { model: string; providerId: string }) => ({
  provider: undefined, modelName: candidate.model, sourceName: candidate.providerId,
  sourceLabel: candidate.providerId, known: true, connected: true,
});
const saveSpy = vi.fn<(change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => Promise<void>>();
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/features/model-groups/modelGroupsClient', () => ({
  modelGroupWhyText: () => '',
  saveModelGroups: (change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => saveSpy(change),
  useModelGroupCandidateNames: () => namesOf,
  useModelGroups: () => ({ config, loaded: true }),
}));

import { ModelGroupsOverview } from '../ModelGroupsOverview';
import { ModelGroupsSection } from '../ModelGroupsSection';
import { SettingsEscapeHarness } from './SettingsEscapeHarness';

const SOL = { agentKind: 'codex', providerId: 'openai', model: 'sol' } as const;
const TERRA = { agentKind: 'codex', providerId: 'openai', model: 'terra' } as const;
const config: ModelGroupsConfig = { routes: [{ id: 'r1', name: 'Dev', strategy: 'order', candidates: [SOL, TERRA] }] } as ModelGroupsConfig;
const quota = (usedPercent: number) => ({ usedPercent, resetAtMs: Date.now() + 3_600_000, windowMs: 7 * 86_400_000 });

describe('ModelGroupsOverview source quota', () => {
  it('shows the current quota on every source, including ones never picked before', async () => {
    const preview: ModelGroupResolveResult = {
      outcome: 'routed', groupName: 'Dev', modelName: 'sol', sourceName: 'openai', route: SOL, why: 'order', quota: quota(3),
      trace: [
        { ...SOL, modelName: 'sol', sourceName: 'openai', state: 'picked', why: 'order', quota: quota(3) },
        { ...TERRA, modelName: 'terra', sourceName: 'openai', state: 'standby', why: 'order', quota: quota(3) },
      ],
    } as ModelGroupResolveResult;
    const resolve = vi.fn().mockResolvedValue(preview);
    Object.assign(window, { electronAPI: { modelGroups: { resolve, decisions: vi.fn().mockResolvedValue([]) } } });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

    render(<ModelGroupsOverview config={config} onOpenRoute={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByText('97%')).toHaveLength(2));
    expect(resolve).toHaveBeenCalledWith({ selection: { type: 'route', id: 'r1' }, dryRun: true });
  });

  // 2026-11-25 用户反馈：打开页面后余量要等两秒才出来。额度没读全时照常的解析会等满上限，
  // 所以先要手头已有的读数立刻显示，再用照常读到的换掉。失效后果：余量每次都晚两秒出现，或被旧数盖回去。
  it('shows the readings on hand at once and replaces them when the usual read arrives', async () => {
    const trace = (used: number) => ({
      outcome: 'routed', groupName: 'Dev', modelName: 'sol', sourceName: 'openai', route: SOL, why: 'order', quota: quota(used),
      trace: [{ ...SOL, modelName: 'sol', sourceName: 'openai', state: 'picked', why: 'order', quota: quota(used) }],
    }) as ModelGroupResolveResult;
    let finishUsual: (value: ModelGroupResolveResult) => void = () => {};
    const resolve = vi.fn((request: { cachedQuota?: boolean }) => (request.cachedQuota
      ? Promise.resolve(trace(40))
      : new Promise<ModelGroupResolveResult>((done) => { finishUsual = done; })));
    Object.assign(window, { electronAPI: { modelGroups: { resolve, decisions: vi.fn().mockResolvedValue([]) } } });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

    render(<ModelGroupsOverview config={config} onOpenRoute={vi.fn()} />);

    expect(await screen.findByText('60%')).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith({ selection: { type: 'route', id: 'r1' }, dryRun: true, cachedQuota: true });
    finishUsual(trace(10));
    expect(await screen.findByText('90%')).toBeTruthy();
    expect(screen.queryByText('60%')).toBeNull();
  });
});

// Unit: the overview quota test does not navigate. Enter a route from a
// scrolled list, scroll its detail independently, then return to the list.
it.each(['button', 'Escape'])('opens a route at the top and restores the model group list position on %s', async (action) => {
  Object.assign(window, { electronAPI: { modelGroups: {
    decisions: vi.fn().mockResolvedValue([]), resolve: vi.fn().mockResolvedValue({ trace: [] }),
  } } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const scrollRef = createRef<HTMLDivElement>();
  render(<SettingsEscapeHarness><div ref={scrollRef}><ModelGroupsSection scrollRef={scrollRef} /></div></SettingsEscapeHarness>);
  const container = scrollRef.current!;
  container.scrollTop = 560;
  fireEvent.click(screen.getByRole('button', { name: 'modelGroups.overview.openRoute' }));
  expect(await screen.findByTestId('model-group-route-detail')).toBeTruthy();
  expect(container.scrollTop).toBe(0);

  container.scrollTop = 120;
  if (action === 'Escape') fireEvent.keyDown(document.body, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: 'modelGroups.settings.back' }));
  expect(await screen.findByTestId('model-groups-settings')).toBeTruthy();
  expect(container.scrollTop).toBe(560);
});

// 2026-11-26 排查(unit)：路由详情里的改动经真实 ModelGroupsSection 存到 saveModelGroups，按「最新配置」改。
// 覆盖缺口：原来按界面上的序号挪、改名失败后同一个名字再也提交不了，现有用例都不进详情页保存。
// 最小输入：两个来源的路由，配置推回来之前连点两次「下移」；改名第一次保存失败、原样再回车。
describe('ModelGroupsSection route edits', () => {
  const openDetail = async () => {
    Object.assign(window, { electronAPI: { modelGroups: {
      decisions: vi.fn().mockResolvedValue([]), resolve: vi.fn().mockResolvedValue({ trace: [] }),
    } } });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const scrollRef = createRef<HTMLDivElement>();
    render(<SettingsEscapeHarness><div ref={scrollRef}><ModelGroupsSection scrollRef={scrollRef} /></div></SettingsEscapeHarness>);
    fireEvent.click(screen.getByRole('button', { name: 'modelGroups.overview.openRoute' }));
    return screen.findByTestId('model-group-route-detail');
  };

  it('moves the clicked source even when the list has not caught up with the last move', async () => {
    let latest = config;
    saveSpy.mockReset().mockImplementation(async (change) => { latest = change(latest); });
    const detail = await openDetail();
    const down = within(detail).getAllByRole('button', { name: 'modelGroups.settings.moveDown' })[0]!;
    fireEvent.click(down);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(down);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
    expect(latest.routes[0]!.candidates.map((item) => item.model)).toEqual(['terra', 'sol']);
  });

  // Unit: settings must save the chosen Harness and execution device as part
  // of the candidate identity. Changing an existing source must preserve its
  // position and weight even when another row now points to the same model.
  it('adds and edits distinct Harness candidates without losing saved route options', async () => {
    let latest: ModelGroupsConfig = { ...config, routes: [{ ...config.routes[0]!,
      candidates: [{ ...SOL, off: true, weight: 3 }, TERRA],
    }] };
    saveSpy.mockReset().mockImplementation(async (change) => { latest = change(latest); });
    openedEditors.mockClear();
    pickerSelections.set('', { engine: 'pi', modelId: SOL.model, providerId: SOL.providerId, fast: false, favoriteUid: null });
    pickerSelections.set(SOL.model, { engine: 'cc', modelId: SOL.model, providerId: SOL.providerId,
      fast: false, favoriteUid: null, agentDevice: { deviceId: 'remote', name: 'Office' } });
    const detail = await openDetail();
    try {
      expect(openedEditors).not.toHaveBeenCalled();
      fireEvent.click(within(detail).getByRole('button', { name: 'add candidate' }));
      await waitFor(() => expect(latest.routes[0]?.candidates).toHaveLength(3));
      fireEvent.click(within(detail).getByRole('button', { name: 'modelGroups.settings.editSource: sol' }));
      const editor = await screen.findByRole('button', { name: 'save candidate' });
      expect(editor.getAttribute('data-current-harness')).toBe('codex');
      fireEvent.click(editor);
      await waitFor(() => expect(latest.routes[0]?.candidates).toEqual([
        { ...SOL, agentKind: 'cc', agentDeviceId: 'remote', off: true, weight: 3 },
        TERRA,
        { ...SOL, agentKind: 'pi' },
      ]));
      fireEvent.keyDown(screen.getByRole('button', { name: 'save candidate' }), { key: 'Escape' });
      fireEvent.click(within(detail).getByRole('button', { name: 'add candidate' }));
      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(3));
      expect(latest.routes[0]?.candidates).toHaveLength(3);
    } finally {
      pickerSelections.clear();
    }
  });

  it('lets the same new name be saved again after a failed save', async () => {
    saveSpy.mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const detail = await openDetail();
    const name = within(detail).getByRole('textbox', { name: 'modelGroups.settings.name' });
    fireEvent.change(name, { target: { value: 'Daily' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
  });
});
