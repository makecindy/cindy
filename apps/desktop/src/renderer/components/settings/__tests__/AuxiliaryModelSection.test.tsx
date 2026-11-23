// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuxiliaryModelOption,
  AuxiliaryModelSettingsState,
} from '../../../../shared/auxiliaryModelSettings';
import { AUTO_AUXILIARY_MODEL_CHAIN } from '../../../../shared/auxiliaryModelChain';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
import * as visibility from '@/state/modelVisibilityPrefs';
import { beginProvidersRefresh, commitProvidersSnapshot, __testing as providerSnapshots } from '@/lib/providersSnapshotStore';

const PREFERRED_PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const FALLBACK_PIN = 'cat:anthropic:claude-code:claude-haiku-4-5';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  test: vi.fn(),
  health: vi.fn(),
  set: vi.fn(),
  toastError: vi.fn(),
  authMode: 'cloud' as 'signed-out' | 'local' | 'cloud',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, data?: { slot: string; model: string }) =>
    key === 'settings.auxiliaryModels.failedSlot' && data ? data.slot + ' · ' + data.model : key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: h.toastError },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: h.authMode }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactElement }) => children,
}));

vi.mock('@/cindy-brain/OneshotModelPinPicker', () => ({
  OneshotModelPinPicker: ({
    value,
    disabled,
    defaultOptionLabel,
    groupByProvider,
    options,
    onChange,
    ariaLabel,
    'data-setting-id': settingId,
  }: {
    'data-setting-id'?: string;
    value?: string;
    ariaLabel: string;
    disabled?: boolean;
    defaultOptionLabel?: string;
    groupByProvider?: boolean;
    options: readonly AuxiliaryModelOption[];
    onChange: (pin: string | null) => void;
  }) => {
    return (
      <div>
        <span>{`${ariaLabel}:${value ?? defaultOptionLabel ?? 'empty'}`}</span>
        <span data-testid={`${ariaLabel}:value`}>{value ?? 'empty'}</span>
        <span data-testid={`${ariaLabel}:panel`}>
          {`${Boolean(groupByProvider)}:${options.map((option) => option.group).join(',')}`}
        </span>
        {options.map((option) => (
          <span key={option.id} data-testid={`${ariaLabel}:option:${option.id}`} data-available={option.available} data-label={option.label} />
        ))}
        <button
          type="button"
          data-setting-id={settingId}
          aria-label={`${ariaLabel}:select`}
          disabled={disabled}
          onClick={() => onChange(PREFERRED_PIN)}
        >
          select
        </button>
        <button
          type="button"
          aria-label={`${ariaLabel}:select-fallback`}
          disabled={disabled}
          onClick={() => onChange(FALLBACK_PIN)}
        >
          select fallback
        </button>
        <button
          type="button"
          aria-label={`${ariaLabel}:automatic`}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          automatic
        </button>
      </div>
    );
  },
}));

import { AuxiliaryModelSection } from '../AuxiliaryModelSection';

function state(partial: Partial<AuxiliaryModelSettingsState> = {}): AuxiliaryModelSettingsState {
  return {
    models: [],
    isCustomized: false,
    customizedKeys: [],
    defaults: { models: [] },
    options: [],
    ...partial,
  };
}

const SUPPLIER_OPTIONS: AuxiliaryModelOption[] = [
  {
    id: PREFERRED_PIN,
    label: 'GPT-5 mini · OpenRouter',
    group: 'OpenRouter',
    providerId: 'openrouter',
    agentKind: 'codex',
    modelId: 'openai/gpt-5-mini',
    modelName: 'GPT-5 mini',
    budget: false,
    subscription: false,
    agentSuffix: 'Codex',
    available: true,
  },
  {
    id: FALLBACK_PIN,
    label: 'Claude Haiku 4.5 · Anthropic',
    group: 'Anthropic',
    providerId: 'anthropic',
    agentKind: 'claude-code',
    modelId: 'claude-haiku-4-5',
    modelName: 'Claude Haiku 4.5',
    budget: false,
    subscription: false,
    agentSuffix: 'Claude Code',
    available: true,
  },
];

const AUTOMATIC_OPTIONS: AuxiliaryModelOption[] = AUTO_AUXILIARY_MODEL_CHAIN.map(
  (id, index) => ({
    id,
    label: ['DeepSeek V4 Flash', 'Hy3', 'Qwen3.8 Flash'][index]! + ' · Cindy AI',
    group: 'Cindy AI',
    providerId: 'xd',
    agentKind: 'codex',
    modelId: ['deepseek/deepseek-v4-flash', 'tencent/hy3', 'qwen/qwen3.8-flash'][index]!,
    modelName: ['DeepSeek V4 Flash', 'Hy3', 'Qwen3.8 Flash'][index]!,
    budget: false,
    subscription: false,
    agentSuffix: 'Codex',
    available: true,
  }),
);

const OPTIONS: AuxiliaryModelOption[] = [...AUTOMATIC_OPTIONS, ...SUPPLIER_OPTIONS];

function installApi(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        auxiliaryModelSettingsGet: h.get,
        auxiliaryModelHealthGet: h.health,
        auxiliaryModelSettingsTest: h.test,
        auxiliaryModelSettingsSet: h.set,
      },
    },
  });
}

async function selectMode(modeKey: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' }),
  );
  const option = await screen.findByRole('option', { name: modeKey });
  await act(async () => {
    fireEvent.click(option);
  });
}

describe('AuxiliaryModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerSnapshots.reset();
    h.authMode = 'cloud';
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    installApi();
    h.get.mockResolvedValue(state({ options: OPTIONS }));
    h.health.mockResolvedValue([]);
    h.test.mockResolvedValue({ ok: true, tested: [] });
    h.set.mockImplementation(async (patch: { models?: string[] }) => {
      const models = patch.models ?? [];
      return state({
        models,
        isCustomized: models.length > 0,
        customizedKeys: models.length > 0 ? ['models'] : [],
        options: OPTIONS,
      });
    });
  });

  it('renders a persistent automatic/custom mode selector above the automatic chain', async () => {
    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' })).textContent,
    ).toContain('settings.auxiliaryModels.automatic');
    expect(screen.getByText(/settings.auxiliaryModels.chain.cindyDeepseekV4Flash/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.auxiliaryModels.customize' })).toBeNull();
    expect(screen.queryByText('settings.auxiliaryModels.preferred.label')).toBeNull();
  });

  // PR #7744: mounted auxiliary settings must follow the shared source-name snapshot.
  // Old tests only read the initial GET. Interleave locale/membership changes with
  // a draft and a pending save; names must update without reloading saved choices.
  it('uses live identity names through locale changes, drafts and a late save response', async () => {
    const publishName = (name: string) => {
      commitProvidersSnapshot(beginProvidersRefresh(), {
        dataOwnerId: null, ownerGeneration: 0, providerOrder: ['xd'],
        providers: [{ id: 'xd', name } as import('@cindy/model-providers').ProviderView],
      });
    };
    publishName('Cindy AI · 个人');
    render(<AuxiliaryModelSection />);
    await selectMode('settings.auxiliaryModels.customize');
    const panel = () => screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:panel').textContent;
    expect(panel()).toContain('Cindy AI · 个人');
    await act(async () => publishName('Cindy AI · Personal'));
    expect(panel()).toContain('Cindy AI · Personal');
    expect(h.set).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(AUTO_AUXILIARY_MODEL_CHAIN[0]);

    let finishSave!: (next: AuxiliaryModelSettingsState) => void;
    h.set.mockImplementationOnce(() => new Promise<AuxiliaryModelSettingsState>(resolve => { finishSave = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.preferred.ariaLabel:select' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    await act(async () => publishName('Cindy AI · 心动'));
    expect(panel()).toContain('Cindy AI · 心动');
    await act(async () => finishSave(state({ models: [PREFERRED_PIN], options: OPTIONS })));
    expect(panel()).toContain('Cindy AI · 心动');
    expect(screen.getByTestId(`settings.auxiliaryModels.preferred.ariaLabel:option:${AUTO_AUXILIARY_MODEL_CHAIN[0]}`).getAttribute('data-label')).toContain('Cindy AI · 心动');
    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(PREFERRED_PIN);
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('keeps user visibility authoritative for a Pi HTTP choice (%s)', async (visible) => {
    const option: AuxiliaryModelOption = { ...SUPPLIER_OPTIONS[0], id: 'cat:go:pi:deepseek-v4.1-flash',
      providerId: 'go', agentKind: 'pi', modelId: 'deepseek-v4.1-flash', defaultEnabled: true };
    const override = vi.spyOn(visibility, 'isModelEnabled').mockReturnValue(visible);
    try {
      h.get.mockResolvedValue(state({ models: [option.id], options: [option] }));
      render(<AuxiliaryModelSection />);
      const row = await screen.findByTestId(`settings.auxiliaryModels.preferred.ariaLabel:option:${option.id}`);
      expect(row.getAttribute('data-available')).toBe(String(visible));
      expect(override).toHaveBeenCalledWith('pi', 'go', { id: 'deepseek-v4.1-flash', defaultEnabled: true });
    } finally {
      override.mockRestore();
    }
  });

  it('treats a GET payload without models as automatic instead of crashing', async () => {
    h.get.mockResolvedValue({
      models: [],
      isCustomized: false,
      customizedKeys: [],
      defaults: { models: [] },
      options: [],
    } as AuxiliaryModelSettingsState);

    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' })).textContent,
    ).toContain('settings.auxiliaryModels.automatic');
  });

  it('opens the three custom slots without persisting and keeps the mode selector', async () => {
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');

    expect(await screen.findByText('settings.auxiliaryModels.preferred.label')).toBeTruthy();
    // Unit protocol regression (#8481): custom slots must pass their own search ID.
    for (const slot of ['preferred', 'fallback1', 'fallback2']) {
      expect(screen.getByRole('button', { name: 'settings.auxiliaryModels.' + slot + '.ariaLabel:select' })
        .getAttribute('data-setting-id')).toBe('settings.auxiliaryModels.' + slot + '.label');
    }
    expect(screen.getByText('settings.auxiliaryModels.fallback1.label')).toBeTruthy();
    expect(screen.getByText('settings.auxiliaryModels.fallback2.label')).toBeTruthy();
    expect(
      screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' }).textContent,
    ).toContain('settings.auxiliaryModels.customize');
    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      'cat:xd:codex:deepseek/deepseek-v4-flash',
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback1.ariaLabel:value').textContent).toBe(
      'cat:xd:codex:tencent/hy3',
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback2.ariaLabel:value').textContent).toBe(
      'cat:xd:codex:qwen/qwen3.8-flash',
    );
    expect(screen.queryByText('settings.defaults.customizedBadge')).toBeNull();
    const modeTrigger = screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' });
    const restoreButton = screen.getByRole('button', { name: 'settings.defaults.restore' });
    expect(restoreButton).toBeTruthy();
    expect(
      modeTrigger.compareDocumentPosition(restoreButton) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(screen.getAllByText('settings.auxiliaryModels.customize')).toHaveLength(1);
    expect(
      screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:panel').textContent,
    ).toBe('true:Cindy AI,OpenRouter,Anthropic');
    expect(h.set).not.toHaveBeenCalled();
  });

  it('filters unavailable automatic routes from a first-time custom draft', async () => {
    h.get.mockResolvedValue(
      state({
        options: OPTIONS.map((option) =>
          option.id === AUTO_AUXILIARY_MODEL_CHAIN[0]
            ? { ...option, available: false }
            : option,
        ),
      }),
    );
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');

    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      AUTO_AUXILIARY_MODEL_CHAIN[1],
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback1.ariaLabel:value').textContent).toBe(
      AUTO_AUXILIARY_MODEL_CHAIN[2],
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback2.ariaLabel:value').textContent).toBe(
      'empty',
    );
    expect(h.set).not.toHaveBeenCalled();
  });

  it('does not seed Cindy AI defaults while signed out', async () => {
    h.authMode = 'signed-out';
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');

    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      'empty',
    );
    expect(screen.getByText('settings.auxiliaryModels.signInHint')).toBeTruthy();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('returns to automatic without persisting when restore is used while drafting', async () => {
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');
    fireEvent.click(await screen.findByRole('button', { name: 'settings.defaults.restore' }));

    expect(
      (await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' })).textContent,
    ).toContain('settings.auxiliaryModels.automatic');
    expect(screen.queryByText('settings.auxiliaryModels.preferred.label')).toBeNull();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('persists the changed preferred pin while keeping the other automatic defaults', async () => {
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.preferred.ariaLabel:select',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'settings.auxiliaryModels.save' }));

    await waitFor(() =>
      expect(h.set).toHaveBeenLastCalledWith({
        models: [PREFERRED_PIN, 'cat:xd:codex:tencent/hy3', 'cat:xd:codex:qwen/qwen3.8-flash'],
      }),
    );
  });

  it('keeps the previous chain when a selected model fails its real connection test', async () => {
    h.set.mockResolvedValueOnce({ ok: false, model: PREFERRED_PIN, reason: 'permission_denied', httpStatus: 403, upstreamMessage: 'An updated provider message.' });
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');
    fireEvent.click(await screen.findByRole('button', {
      name: 'settings.auxiliaryModels.preferred.ariaLabel:select',
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.auxiliaryModels.save' }));

    expect(await screen.findByText('settings.auxiliaryModels.failedAuto')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('HTTP 403 · settings.auxiliaryModels.http.403');
    expect(screen.getByText('An updated provider message.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.retryAction' }));
    await screen.findByText('settings.auxiliaryModels.saveSuccess');
    expect(h.set).toHaveBeenCalledWith({
      models: [PREFERRED_PIN, 'cat:xd:codex:tencent/hy3', 'cat:xd:codex:qwen/qwen3.8-flash'],
    });
  });

  // Unit: submit feedback stays beside Save through an unresolved request, a
  // backup rejection, a draft edit and a write error. The transport is mocked.
  it('keeps feedback above the selectors and distinguishes a write failure from a rejected backup', async () => {
    h.get.mockResolvedValueOnce(state({ models: [PREFERRED_PIN], options: OPTIONS }));
    const test = Promise.withResolvers<unknown>();
    h.set.mockReturnValueOnce(test.promise);
    render(<AuxiliaryModelSection />);
    const backup = await screen.findByRole('button', { name: 'settings.auxiliaryModels.fallback1.ariaLabel:select-fallback' });
    fireEvent.click(backup);
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    const pending = await screen.findByText('settings.auxiliaryModels.testingHint');
    expect(pending.compareDocumentPosition(backup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => test.resolve({ ok: false, model: FALLBACK_PIN, reason: 'http_error', httpStatus: 422, upstreamMessage: 'Provider detail.' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('settings.auxiliaryModels.failedKeep');
    expect(alert.textContent).toContain('settings.auxiliaryModels.fallback1.label · Claude Haiku 4.5');
    expect(alert.textContent).toContain('HTTP 422');
    expect(alert.compareDocumentPosition(backup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.fallback1.ariaLabel:automatic' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(backup);
    h.set.mockRejectedValueOnce(new Error('write failed'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('settings.auxiliaryModels.saveFailed');
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('shows all supplier groups while keeping the exact selected catalog pin', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
        options: SUPPLIER_OPTIONS,
      }),
    );
    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByTestId('settings.auxiliaryModels.preferred.ariaLabel:panel')).textContent,
    ).toBe('true:OpenRouter,Anthropic');
    expect(
      screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' }).textContent,
    ).toContain('settings.auxiliaryModels.customize');

    expect(h.set).not.toHaveBeenCalled();
  });

  it('disables a later slot until its preceding slot has a model', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
        options: OPTIONS,
      }),
    );
    render(<AuxiliaryModelSection />);

    const fallback2Select = await screen.findByRole('button', {
      name: 'settings.auxiliaryModels.fallback2.ariaLabel:select',
    });
    expect((fallback2Select as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(fallback2Select);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('does not offer or persist a model already selected in another slot', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN, FALLBACK_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
        options: OPTIONS,
      }),
    );
    render(<AuxiliaryModelSection />);

    expect(
      screen.queryByTestId(
        `settings.auxiliaryModels.preferred.ariaLabel:option:${FALLBACK_PIN}`,
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        `settings.auxiliaryModels.fallback1.ariaLabel:option:${PREFERRED_PIN}`,
      ),
    ).toBeNull();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.fallback1.ariaLabel:select',
      }),
    );
    expect(h.set).not.toHaveBeenCalled();
  });

  it('clears a saved custom chain when automatic is selected', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN, FALLBACK_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
        options: OPTIONS,
      }),
    );
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.automatic');

    await waitFor(() => {
      expect(h.set).toHaveBeenCalledWith({ models: [] });
      expect(
        screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' }).textContent,
      ).toContain('settings.auxiliaryModels.automatic');
    });
  });

  it('restores automatic routing when the preferred slot is cleared', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN, FALLBACK_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
      }),
    );
    render(<AuxiliaryModelSection />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.preferred.ariaLabel:automatic',
      }),
    );
    expect(h.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith({ models: [] }));
  });

  // Unit: a failed reset must leave Save bound to the visible draft.
  it('preserves an edited backup when restoring defaults fails and Save is clicked', async () => {
    h.get.mockResolvedValueOnce(state({ models: [PREFERRED_PIN], options: OPTIONS }));
    h.set.mockRejectedValueOnce(new Error('write failed'));
    render(<AuxiliaryModelSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.auxiliaryModels.fallback1.ariaLabel:select-fallback' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
    expect((await screen.findByRole('alert')).textContent).toBe('settings.defaults.restoreFailed');
    fireEvent.click(screen.getByRole('button', { name: 'settings.auxiliaryModels.save' }));
    await screen.findByText('settings.auxiliaryModels.saveSuccess');
    expect(h.set.mock.calls).toEqual([[{ models: [] }], [{ models: [PREFERRED_PIN, FALLBACK_PIN] }]]);
  });

  it('persists an empty list when restore is used on a saved custom chain', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
      }),
    );
    render(<AuxiliaryModelSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.defaults.restore' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith({ models: [] }));
  });

  // Unit: the settings snapshot must retain the provider detail after a successful fallback.
  it('renders the most recent HTTP error as summary followed by literal message text', async () => {
    const detail = 'Provider Message.\nTry Later!';
    h.health.mockResolvedValueOnce([{ model: 'Small', providerId: 'test', reason: 'http_error',
      status: 'monitoring', httpStatus: 503, upstreamMessage: detail, failureRate: 1, attemptCount: 1,
      ownerStamp: { dataOwnerId: null, ownerGeneration: 0 } }]);
    render(<AuxiliaryModelSection />);
    const summary = await screen.findByText('HTTP 503 · settings.auxiliaryModels.http.server');
    expect(summary.nextElementSibling?.textContent).toBe(detail);
  });

  it('keeps the auxiliary health copy localized in Simplified Chinese', () => {
    const copy = zhCN.settings.auxiliaryModels;
    expect(copy.viewSettings).toBe('查看设置');
    expect(copy.healthRecent).toContain('最近成功率');
    expect(copy.healthWarning).toContain('最近失败');
    expect(copy.healthIsolated).toContain('暂时暂停');
    expect(copy.healthRecovered).toContain('已恢复');
    expect(copy.healthReasons.http_error).toBe('上游请求错误');
  });
});
