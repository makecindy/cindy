// @vitest-environment jsdom

/**
 * AuxiliaryModelSectionView 渲染测试(云实例设置复用的展示部分)。
 *
 * 回归目标:
 *   1. 三个槽位只用注入的 options,且已被其它槽位选中的不重复出现;
 *   2. 进入「自定义」只调 setDrafting,不落库;草稿槽位按注入 options 种 Cindy AI 默认链;
 *   3. 改槽位 / 恢复默认走注入的 persistModels;
 *   4. signInHint 为 true 时显示提示且不种 Cindy AI 默认链。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_AUXILIARY_MODEL_CHAIN } from '../../../../shared/auxiliaryModelChain';
import type { AuxiliaryModelOption } from '../../../../shared/auxiliaryModelSettings';

const PICKED_PIN = 'cat:remote-or:codex:openai/gpt-5-mini';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactElement }) => children,
}));

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

// View 必须不读本机鉴权与模型可见性;调用即失败。
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => {
    throw new Error('AuxiliaryModelSectionView must not read local auth');
  },
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => {
    throw new Error('AuxiliaryModelSectionView must not read local visibility');
  },
  useModelVisibilityVersion: () => {
    throw new Error('AuxiliaryModelSectionView must not read local visibility');
  },
}));

vi.mock('@/cindy-brain/OneshotModelPinPicker', () => ({
  OneshotModelPinPicker: ({
    value,
    options,
    onChange,
    ariaLabel,
    disabled,
  }: {
    value?: string;
    options: readonly AuxiliaryModelOption[];
    onChange: (pin: string | null) => unknown;
    ariaLabel: string;
    disabled?: boolean;
  }) => (
    <div>
      <span data-testid={`${ariaLabel}:value`}>{value ?? 'empty'}</span>
      <span data-testid={`${ariaLabel}:options`}>{options.map((option) => option.id).join(',')}</span>
      <button
        type="button"
        aria-label={`${ariaLabel}:pick`}
        disabled={disabled}
        onClick={() => void onChange(PICKED_PIN)}
      />
    </div>
  ),
}));

import { AuxiliaryModelSectionView, type AuxiliaryModelSectionViewProps } from '../AuxiliaryModelSection';

function option(id: string, providerId: string, group: string): AuxiliaryModelOption {
  return {
    id,
    label: id,
    group,
    providerId,
    agentKind: 'codex',
    modelId: id.split(':').slice(3).join(':'),
    modelName: id,
    budget: false,
    subscription: false,
    agentSuffix: 'Codex',
    available: true,
  };
}

const OPTIONS: AuxiliaryModelOption[] = [
  ...AUTO_AUXILIARY_MODEL_CHAIN.map((id) => option(id, 'xd', 'Cindy AI')),
  option(PICKED_PIN, 'remote-or', 'OpenRouter'),
];

function renderView(overrides: Partial<AuxiliaryModelSectionViewProps> = {}) {
  const props: AuxiliaryModelSectionViewProps = {
    models: [],
    options: OPTIONS,
    pending: false,
    signInHint: false,
    drafting: false,
    setDrafting: vi.fn(),
    persistModels: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const view = render(<AuxiliaryModelSectionView {...props} />);
  return { props, view };
}

beforeEach(() => {
  cleanup();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});

describe('AuxiliaryModelSectionView', () => {
  it('asks the owner to start a draft instead of persisting when Custom is chosen', async () => {
    const { props } = renderView();

    expect(screen.queryByText('settings.auxiliaryModels.preferred.label')).toBeNull();
    fireEvent.click(await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' }));
    const custom = await screen.findByRole('option', { name: 'settings.auxiliaryModels.customize' });
    await act(async () => {
      fireEvent.click(custom);
    });

    expect(props.setDrafting).toHaveBeenCalledWith(true);
    expect(props.persistModels).not.toHaveBeenCalled();
  });

  it('seeds a draft from the injected catalog and persists it only on save', async () => {
    const { props } = renderView({ drafting: true });

    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      AUTO_AUXILIARY_MODEL_CHAIN[0],
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback2.ariaLabel:value').textContent).toBe(
      AUTO_AUXILIARY_MODEL_CHAIN[2],
    );

    fireEvent.click(screen.getByLabelText('settings.auxiliaryModels.preferred.ariaLabel:pick'));
    expect(props.persistModels).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    });
    expect(props.persistModels).toHaveBeenCalledExactlyOnceWith([
      PICKED_PIN,
      AUTO_AUXILIARY_MODEL_CHAIN[1],
      AUTO_AUXILIARY_MODEL_CHAIN[2],
    ]);
    expect(props.setDrafting).toHaveBeenLastCalledWith(false);
  });

  it('keeps the draft when a save fails or its account changed meanwhile', async () => {
    const persistModels = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce('stale');
    const { props } = renderView({ drafting: true, persistModels });
    fireEvent.click(screen.getByLabelText('settings.auxiliaryModels.preferred.ariaLabel:pick'));
    vi.mocked(props.setDrafting).mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('settings.auxiliaryModels.saveFailed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.retryAction' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(PICKED_PIN);
    expect(props.setDrafting).not.toHaveBeenCalled();
  });

  it('hides options taken by other slots and restores automatic through persistModels([])', () => {
    const { props } = renderView({ models: [PICKED_PIN, AUTO_AUXILIARY_MODEL_CHAIN[0]] });

    expect(
      screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:options').textContent?.split(','),
    ).not.toContain(AUTO_AUXILIARY_MODEL_CHAIN[0]);
    expect(
      screen.getByTestId('settings.auxiliaryModels.fallback1.ariaLabel:options').textContent?.split(','),
    ).not.toContain(PICKED_PIN);

    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
    expect(props.persistModels).toHaveBeenCalledWith([]);
    expect(props.setDrafting).not.toHaveBeenCalled();
  });

  it('shows the sign-in hint and does not seed Cindy AI defaults when signInHint is set', () => {
    renderView({ drafting: true, signInHint: true });

    expect(screen.getByText('settings.auxiliaryModels.signInHint')).toBeTruthy();
    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      'empty',
    );
  });
});
