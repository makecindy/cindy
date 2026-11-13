// @vitest-environment jsdom

// 2026-11-13 主人试用反馈：关系图里的来源只在被选中过之后才显示余量，同一个订阅账号的其它来源一片空白。
// 余量现在来自打开总览时只看不选的解析(与「试一下」同一份)，从没被选中过的来源也要显示。
// 真实入口：ModelGroupsOverview 渲染 + window.electronAPI.modelGroups 的 resolve / decisions。Tier: unit。
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelGroupResolveResult, ModelGroupsConfig } from '../../../../shared/modelGroups';

// 与真实 i18next 一样，t 与 i18n 在多次渲染之间保持同一个引用。
const i18nValue = { t: (key: string) => key, i18n: { language: 'en' } };
vi.mock('react-i18next', () => ({ useTranslation: () => i18nValue }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ProviderMark: () => null }));
// 与真实 hook 一样返回稳定的函数(真实实现经 useCallback)。
const namesOf = (candidate: { model: string; providerId: string }) => ({
  provider: undefined, modelName: candidate.model, sourceName: candidate.providerId,
  sourceLabel: candidate.providerId, known: true, connected: true,
});
vi.mock('@/features/model-groups/modelGroupsClient', () => ({
  modelGroupWhyText: () => '',
  useModelGroupCandidateNames: () => namesOf,
}));

import { ModelGroupsOverview } from '../ModelGroupsOverview';

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
});
