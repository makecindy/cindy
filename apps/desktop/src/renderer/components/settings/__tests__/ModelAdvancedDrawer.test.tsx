// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  setLimit: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  target: vi.fn(),
  limit: null as number | null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.tokens ? `${key} ${values.tokens}` : key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/hooks/useModelContextLimit', () => ({
  useModelContextLimit: (target: unknown) => {
    mocks.target(target);
    return {
      limit: mocks.limit,
      isCustomized: mocks.limit !== null,
      loading: false,
      error: false,
      setLimit: mocks.setLimit,
      reset: mocks.reset,
    };
  },
}));
const imageInputMocks = vi.hoisted(() => ({
  setValue: vi.fn(async () => true),
  target: vi.fn(),
  value: null as boolean | null,
  isCustomized: false,
  diverged: false,
  errorReason: undefined as string | undefined,
  saving: false,
  loading: false,
}));
vi.mock('@/hooks/useModelCatalogImageInput', () => ({
  useModelCatalogImageInput: (target: unknown) => {
    imageInputMocks.target(target);
    return {
      value: imageInputMocks.value,
      isCustomized: imageInputMocks.isCustomized,
      diverged: imageInputMocks.diverged,
      errorReason: imageInputMocks.errorReason,
      loading: imageInputMocks.loading,
      saving: imageInputMocks.saving,
      error: false,
      setValue: imageInputMocks.setValue,
    };
  },
}));
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => 0,
  isModelEnabled: (_agent: unknown, _provider: unknown, model: { defaultEnabled?: boolean }) => model.defaultEnabled !== false,
  isModelVisibilityCustomized: () => false,
  setModelVisibility: vi.fn(),
  resetModelVisibilities: vi.fn(),
}));
vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
  getProviderModelEffort: vi.fn(() => undefined),
  setProviderModelEffort: vi.fn(),
  clearProviderModelEffort: vi.fn(),
}));
vi.mock('../ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));
import { ModelAdvancedDrawer } from '../ModelAdvancedDrawer';
import { setModelVisibility } from '@/state/modelVisibilityPrefs';
import { setProviderModelEffort, getProviderModelEffort, clearProviderModelEffort } from '@/state/providerModelMemory';

const model: CatalogModel = {
  id: 'gpt-6',
  name: 'GPT-6',
  contextWindow: 272_000,
  contextWindowMax: 1_050_000,
  maxOutput: 128_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  modalities: { input: ['text', 'image'], output: ['text'] },
};
const provider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  connected: true,
  agents: ['codex', 'claude-code'],
  models: {},
} as ProviderView;
function drawer(primary = model, bridgeDefault = primary.defaultEffort, bridgeEfforts = primary.efforts, source = provider) {
  const row = {
    id: primary.id,
    name: primary.name,
    avail: ['codex', 'claude-code'] as ('codex' | 'claude-code')[],
    byAgent: {
      codex: primary,
      'claude-code': { ...primary, id: `chatgpt/${primary.id}`, defaultEffort: bridgeDefault, efforts: bridgeEfforts },
    },
  };
  return (
    <ModelAdvancedDrawer
      provider={source}
      row={row}
      open
      onOpenChange={vi.fn()}
      pricePresentationOf={() => null}
      onDisable={vi.fn()}
      disabled={false}
      paymentRequired={false}
    />
  );
}
function draw(primary = model, bridgeDefault = primary.defaultEffort) {
  return render(drawer(primary, bridgeDefault));
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit = null;
  imageInputMocks.value = null;
  imageInputMocks.isCustomized = false;
  imageInputMocks.diverged = false;
  imageInputMocks.errorReason = undefined;
  imageInputMocks.saving = false;
  imageInputMocks.loading = false;
  vi.mocked(getProviderModelEffort).mockReset();
});

describe('model advanced editor', () => {
  it('shows the imported API as a label rather than offering unrelated supplier transports', () => {
    const source = { ...buildUserProvider({ id: 'nous-test', name: 'Hermes', runtimes: {
      pi: { catalogPresetId: 'nous', baseUrl: 'https://inference-api.nousresearch.com/v1', wireProtocol: 'openai-chat', models: [{ id: 'gpt-6', name: 'GPT-6' }] },
    } }), connected: true } as ProviderView;
    const primary = source.models.pi![0];
    render(<ModelAdvancedDrawer provider={source} row={{ id: primary.id, name: primary.name, avail: ['pi'], byAgent: { pi: primary } }} open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
    expect(screen.queryByRole('button', { name: 'Pi · settings.providers.custom.fields.wireProtocol' })).toBeNull();
    expect(screen.getByText(/Chat Completions/)).toBeTruthy();
  });

  it('saves protocol selection to the selected engine and model without writing derived model limits', async () => {
    const update = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'fixture', name: 'Fixture', runtimes: {
      codex: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-responses', requestPath: '/custom/chat',
        models: [{ id: 'gpt-6', name: 'GPT-6', route: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-responses', requestPath: '/custom/chat' } }, { id: 'other', name: 'Other' }] },
    } }), connected: true } as ProviderView;
    try {
      render(drawer(source.models.codex![0], 'high', ['high'], source));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
      await screen.findByRole('menuitemradio', { name: 'Chat Completions' });
      expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['Messages', 'Responses', 'Chat Completions', 'Google Gemini']);
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Chat Completions' }));
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      const config = update.mock.calls[0]![0] as unknown as { runtimes: { codex: { models: Array<Record<string, unknown>> } } };
      expect(config.runtimes.codex.models[0]).toEqual({ id: 'gpt-6', name: 'GPT-6', api: 'openai-completions',
        route: { baseUrl: 'https://supplier.example/v1', wireProtocol: 'openai-chat' } });
      expect(config.runtimes.codex.models[1]).toEqual({ id: 'other', name: 'Other' });
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  it('saves Google selection with its matching wire and official endpoint', async () => {
    const update = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { updateCustomProvider: update } } });
    const source = { ...buildUserProvider({ id: 'fixture', name: 'Fixture', runtimes: {
      codex: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wireProtocol: 'openai-chat',
        models: [{ id: 'new-gemini', name: 'New Gemini' }, { id: 'other', name: 'Other' }] },
    } }), connected: true } as ProviderView;
    try {
      render(drawer(source.models.codex![0], 'high', ['high'], source));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Google Gemini' }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      const config = update.mock.calls[0]![0] as { runtimes: { codex: { models: unknown[] } } };
      expect(config.runtimes.codex.models).toEqual([
        { id: 'new-gemini', name: 'New Gemini', api: 'google-generative-ai', route: {
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireProtocol: 'google-generative-ai',
        } }, { id: 'other', name: 'Other' },
      ]);
    } finally { Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous }); }
  });

  it('rejects new small settings but accepts 100K without rewriting existing small overrides', () => {
    mocks.limit = 1_000;
    draw();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(100_000);
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
  });

  it('keeps the trailing token readout on the typed value until the write lands', async () => {
    // 提交后写入是异步的（hook 先 loading、仍持有旧 limit）。修复前抽屉在 blur 瞬间丢掉草稿，
    // 说明行会先退回旧的 400,000、等回声到了再跳 500,000 —— 用户实测到的「闪一下旧值」。
    mocks.limit = 400_000;
    let release: () => void = () => {};
    mocks.setLimit.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    draw();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('400');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(500_000);
    // 写入在途：说明行必须继续显示刚输入的值。
    expect(screen.getByText(/advanced\.contextLimitRoute 500,000/)).toBeTruthy();
    expect(screen.queryByText(/advanced\.contextLimitRoute 400,000/)).toBeNull();
    // 回声落地（hook 此时已持有新值）后再收口：仍然是新值，不回退。
    mocks.limit = 500_000;
    release();
    await waitFor(() => expect(screen.getByText(/advanced\.contextLimitRoute 500,000/)).toBeTruthy());
    expect(screen.queryByText(/advanced\.contextLimitRoute 400,000/)).toBeNull();
  });

  it.each(['cindy-local-ollama', 'ollama', 'cindy-local-lmstudio'])('keeps %s editable at 1K even when the catalog advertises a large window', (id) => {
    render(drawer(model, model.defaultEffort, model.efforts, { ...provider, id, source: 'user' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(4_000);
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1_000);
  });

  it.each([2_048, 4_096, 8_192, 32_768])('keeps a small model with %s native tokens editable below 100K', (window) => {
    draw({ ...model, contextWindow: window, contextWindowMax: window });
    const input = screen.getByRole('textbox');
    const floor = Math.floor(window / 1000);
    fireEvent.change(input, { target: { value: String(floor - 1) } });
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: String(floor) } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(floor * 1000);
  });


  // 上游未声明容量时不能把「工作默认值」印成「上游最大上下文」：自定义连接的 200K 是兜底，
  // 而运行期窗口其实取模型级上下文上限（用户实测报障：圆环 1.0M / 这里 200K）。
  function withoutCapacity(over: Partial<CatalogModel> = {}): CatalogModel {
    const { contextWindowMax: _omit, ...rest } = model;
    return { ...rest, contextWindow: 200_000, ...over };
  }

  it('shows "not declared" instead of the working default when the provider declares no capacity', () => {
    draw(withoutCapacity());
    // 这一行只报「容量未声明」：不再把工作默认值（200K 兜底，或目录给的 1M）当成容量塞进这一格。
    expect(
      screen.getAllByText('settings.providers.models.advanced.undeclared').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('200,000')).toBeNull();
    expect(screen.queryByText('settings.providers.models.advanced.tokensApprox')).toBeNull();
    // 工作窗口仍然可见 —— 在「上下文上限」那行的说明里（未设上限时取目录默认值）。
    // 那行带插值（t 的 mock 会拼上 tokens），所以用正则而非精确匹配。
    expect(screen.getByText(/advanced\.contextLimitRoute/)).toBeTruthy();
  });

  it('shows the window upstream handed down even when no capacity is declared', () => {
    // opencode-go 的 deepseek-v4.1-flash 就是这种：没有 contextWindowMax，但预设/服务端目录
    // 下发了窗口（buildUserProvider 会带上 contextWindowVerified）→ 这行要显示该窗口，而不是「未声明」。
    draw({ ...withoutCapacity(), contextWindow: 1_048_576, contextWindowVerified: true });
    expect(screen.getByText('1,048,576')).toBeTruthy();
    // 「约 X」只由规格那一行渲染（「未声明」这个 key 在抽屉里另有多处，不能拿它判负）。
    expect(screen.getByText('settings.providers.models.advanced.tokensApprox')).toBeTruthy();
  });

  it('lets the user declare an undeclared image capability from the drawer', async () => {
    // 上游未声明图片能力时 Pi 会在客户端拒收图片，而此前没有任何可点的声明入口。
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    // 未声明时显示「跟随目录」。
    expect(trigger.textContent).toContain('settings.providers.models.advanced.imageInputOverride.inherit');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.declaredTrue',
      }),
    );
    await waitFor(() => expect(imageInputMocks.setValue).toHaveBeenCalledWith(true));
  });

  it('shows a declared capability and can return to following the catalog', async () => {
    imageInputMocks.value = false;
    imageInputMocks.isCustomized = true;
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    expect(trigger.textContent).toContain('settings.providers.models.advanced.imageInputOverride.declaredFalse');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.inherit',
      }),
    );
    await waitFor(() => expect(imageInputMocks.setValue).toHaveBeenCalledWith(null));
  });

  it('allows re-selecting the current value to repair a split across engine keys', async () => {
    // 各引擎键分叉（手工改文件/旧版单键写入的存量数据）时，同值 no-op 会把“重选当前项”
    // 挡掉 —— 分叉永远修不掉，UI 显示一侧而运行期读另一侧。diverged 时必须放行写入。
    imageInputMocks.value = true;
    imageInputMocks.isCustomized = true;
    imageInputMocks.diverged = true;
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.declaredTrue',
      }),
    );
    await waitFor(() => expect(imageInputMocks.setValue).toHaveBeenCalledWith(true));
  });

  it('skips the write when the user picks the state it is already in', async () => {
    imageInputMocks.value = true;
    imageInputMocks.isCustomized = true;
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.declaredTrue',
      }),
    );
    expect(imageInputMocks.setValue).not.toHaveBeenCalled();
  });

  it('keeps the control usable and visually stable while a provider refresh refetches', () => {
    // 写入后 main 广播 PROVIDER_CHANGED，hook 会重读；重读期间值原样保留，
    // 既不禁用也不改透明度 —— 否则一次切换会出现两次明暗跳变（用户报障：闪一下）。
    imageInputMocks.loading = true;
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    expect(trigger).toHaveProperty('disabled', false);
    expect(trigger.className).not.toContain('disabled:opacity');
    expect(trigger.className).not.toContain('opacity-60');
  });

  it('reports a failed declaration instead of silently keeping the optimistic value', async () => {
    const { toast } = await import('@/lib/toast');
    imageInputMocks.setValue.mockResolvedValueOnce(false);
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.declaredTrue',
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'settings.providers.models.advanced.imageInputOverride.saveFailed',
      ),
    );
  });

  it('shows the actionable reason from main when a hand-edited file blocks the write', async () => {
    // store 拒绝写入时给出「先修正 model-catalog-overrides.json」的指引；只显示通用
    // 「保存失败」会让用户反复失败却看不到唯一的修复方式。
    const { toast } = await import('@/lib/toast');
    imageInputMocks.setValue.mockResolvedValueOnce(false);
    imageInputMocks.errorReason = '请先修正 model-catalog-overrides.json';
    draw();
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.declaredTrue',
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'settings.providers.models.advanced.imageInputOverride.saveFailedWithReason',
      ),
    );
  });

  it('covers every harness id of the row when declaring image capability', async () => {
    // openai 行的主展示引擎是 codex（gpt-6），而运行期消费该能力的 Pi 侧 id 是 chatgpt/gpt-6。
    // 只写主引擎的 id 时 Pi 永远读不到声明，UI 却会显示「已声明」。
    const piModel = { ...model, id: 'chatgpt/gpt-6' };
    render(
      <ModelAdvancedDrawer
        provider={provider}
        row={{
          id: model.id,
          name: model.name,
          avail: ['codex', 'pi'],
          byAgent: { codex: model, pi: piModel },
        }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'settings.providers.models.advanced.imageInputOverride.label',
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('menuitemradio', {
        name: 'settings.providers.models.advanced.imageInputOverride.declaredTrue',
      }),
    );
    await waitFor(() => expect(imageInputMocks.setValue).toHaveBeenCalledWith(true));
    // 声明目标必须带上 Pi 侧 id（写盘/读取都按该 id 精确匹配）。
    const targets = imageInputMocks.target.mock.calls.map((call) => call[0]);
    expect(targets).toContainEqual(
      expect.objectContaining({
        providerId: 'openai',
        agent: 'codex',
        modelId: 'gpt-6',
        relatedTargets: [expect.objectContaining({ agent: 'pi', modelId: 'chatgpt/gpt-6' })],
      }),
    );
  });

  it('warns when the limit exceeds a verified upstream window without a declared max', () => {
    // 「已验证窗口但无 contextWindowMax」的模型此前不会告警：填到窗口以上也静默接受。
    mocks.limit = 1_200_000;
    draw({ ...withoutCapacity(), contextWindow: 1_048_576, contextWindowVerified: true });
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
  });

  it('does not offer the local declaration for the server-controlled gateway provider', () => {
    render(drawer(model, model.defaultEffort, model.efforts, { ...provider, id: 'xd' }));
    expect(
      screen.getByRole('button', {
        name: 'settings.providers.models.advanced.imageInputOverride.label',
      }),
    ).toHaveProperty('disabled', true);
  });

  it('does not warn about the limit exceeding an undeclared capacity', () => {
    // 未声明容量时拿 200K 工作默认值当告警基线会误报「已超出当前显示的窗口」。
    mocks.limit = 1_200_000;
    draw(withoutCapacity());
    expect(screen.queryByText('settings.providers.models.advanced.contextLimitOverWindow')).toBeNull();
  });

  it('keeps useful identity fields without exposing internal defaults, normal lifecycle or raw descriptions', () => {
    draw({ ...model, status: 'active', defaultEnabled: false, description: 'GPT for coding tasks' });
    expect(screen.queryByText('active')).toBeNull();
    expect(screen.queryByText('GPT for coding tasks')).toBeNull();
    expect(screen.queryByText('settings.providers.models.advanced.defaultEnabled')).toBeNull();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
  });

  it.each(['alpha', 'deprecated', 'retired'] as const)('localizes the actionable model status %s', (status) => {
    draw({ ...model, status });
    expect(screen.queryByText(status)).toBeNull();
    expect(screen.getByText(`settings.providers.models.advanced.lifecycle.${status}`)).toBeTruthy();
  });

  it('preserves selected harnesses while disconnected, and restores controls after reconnect', () => {
    const view = render(
      <ModelAdvancedDrawer
        provider={{ ...provider, connected: false }}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'GPT-6 · Codex' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(setModelVisibility).not.toHaveBeenCalled();
    expect(screen.getByText('settings.providers.models.manage.connectionRequired')).toBeTruthy();
    view.rerender(drawer());
    expect(
      (screen.getByRole('switch', { name: 'GPT-6 · Codex' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText('settings.providers.models.manage.connectionRequired')).toBeNull();
    expect(screen.getByRole('switch', { name: 'GPT-6 · Codex' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(setModelVisibility).not.toHaveBeenCalled();
  });

  it('shows the exact maximum and includes Codex in shared context edits', () => {
    draw();
    expect(screen.getByText('1,050,000')).toBeTruthy();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    expect((input as HTMLInputElement).value).toBe('272');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(500_000);
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.target).toHaveBeenLastCalledWith({
      providerId: 'openai',
      agent: 'codex',
      modelId: 'gpt-6',
      relatedTargets: [{ providerId: 'openai', agent: 'claude-code', modelId: 'chatgpt/gpt-6' }],
    });
  });

  it('edits a Codex-only route without removing the model specification', () => {
    render(
      <ModelAdvancedDrawer
        provider={provider}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
    expect(screen.getByText('1,050,000')).toBeTruthy();
    expect(screen.queryByText('settings.providers.models.advanced.codexContextHint')).toBeNull();
  });

  it('uses the same context editor for custom Codex providers', () => {
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'custom', source: 'user' }}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
    expect(screen.getAllByText('272K').length).toBeGreaterThan(0);
    expect(screen.queryByText('settings.providers.models.advanced.codexContextHint')).toBeNull();
  });

  it('omits an undeclared manufacturer reference instead of presenting it as broken setup', () => {
    render(drawer({ ...model, nativeApi: undefined }, undefined, undefined, { ...provider, id: 'unknown-provider', source: 'user' }));
    expect(screen.queryByText('settings.providers.models.advanced.protocol.reference')).toBeNull();
  });

  it('renders imported OpenRouter Gemini with only Pi enabled, preserving all three supplier interfaces', () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!;
    const agents = ['claude-code', 'codex', 'pi'] as const;
    const id = 'google/gemini-3.8-flash';
    const source = { ...buildUserProvider({ id: 'openrouter-test', name: 'OpenRouter', runtimes: Object.fromEntries(
      agents.map(agent => [agent, { ...preset.runtimes[agent]!, catalogPresetId: preset.id, models: [{ id, name: 'Gemini' }] }]),
    ) }, { presets: BUNDLED_CATALOG.presets, modelRegistry: BUNDLED_CATALOG.modelRegistry }), connected: true } as ProviderView;
    const byAgent = Object.fromEntries(agents.map(agent => [agent, source.models[agent]![0]]));
    render(<ModelAdvancedDrawer provider={source} row={{ id, name: 'Gemini', avail: [...agents], byAgent }} open
      onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
    for (const agent of ['Claude Code', 'Codex', 'Pi']) {
      const toggle = screen.getByRole('switch', { name: `Gemini · ${agent}` });
      expect(toggle.getAttribute('aria-checked')).toBe(agent === 'Pi' ? 'true' : 'false');
      expect(toggle.hasAttribute('data-compatibility')).toBe(agent !== 'Pi');
    }
    expect(screen.getByText(/^Messages/)).toBeTruthy();
    expect(screen.getByText(/^Responses/)).toBeTruthy();
    expect(screen.getByText(/^Chat Completions/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('1048');
  });

  it('shows whole K without rewriting the exact catalog value on untouched blur', () => {
    draw({ ...model, contextWindow: 1_048_576, contextWindowMax: 1_048_576 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1048');
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitRoute 1,048,576'),
    ).toBeTruthy();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
  });

  it('labels both Google compatibility routes and gives Pi the recommendation', async () => {
    const primary = {
      ...model,
      id: 'google/gemini-future',
      name: 'Gemini',
      nativeApi: 'google-generative-ai' as const,
    };
    const byAgent = {
      'claude-code': primary,
      codex: primary,
      pi: { ...primary, piApi: 'google-generative-ai' as const },
    };
    const agents = ['claude-code', 'codex', 'pi'] as const;
    render(
      <ModelAdvancedDrawer
        provider={{
          ...provider,
          id: 'xd',
          agents: [...agents],
          models: Object.fromEntries(agents.map((agent) => [agent, [byAgent[agent]]])),
          routing: {
            'claude-code': { wireProtocol: 'anthropic-messages' },
            codex: { wireProtocol: 'openai-responses' },
          } as ProviderView['routing'],
        }}
        row={{ id: primary.id, name: primary.name, avail: [...agents], byAgent }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    expect(
      screen.getByText('newChat.modelSelector.unified.recommended').parentElement?.textContent,
    ).toContain('Pi');
    for (const agent of ['Claude Code', 'Codex']) {
      const toggle = screen.getByRole('switch', { name: `Gemini · ${agent}` });
      expect(toggle.getAttribute('data-compatibility')).toBe('true');
      expect(
        document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent,
      ).toContain('protocol.compatibility');
    }
    expect(
      screen.getByRole('switch', { name: 'Gemini · Pi' }).hasAttribute('data-compatibility'),
    ).toBe(false);
    const notices = screen.getAllByRole('button', {
      name: 'settings.providers.models.advanced.protocol.compatibility',
    });
    expect(notices).toHaveLength(2);
    fireEvent.click(notices[0]!);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'protocol.compatibilityHint',
    );
    expect(setModelVisibility).not.toHaveBeenCalled();
  });

  it('preserves an existing precise override, warns above the exact maximum, and resets without rounding writes', () => {
    mocks.limit = 1_048_900;
    draw({ ...model, contextWindow: 1_048_576, contextWindowMax: 1_048_576 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1048');
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }),
    );
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });

  it('shows facts beside controls without disclosure and keeps related window values together', () => {
    draw();
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('details')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'GPT-6' }));
    const input = screen.getByRole('textbox');
    const controlsColumn = input.closest('section')!.parentElement!;
    expect(controlsColumn.textContent).toContain(
      'settings.providers.models.advanced.contextWindow',
    );
    expect(screen.getByText('settings.providers.models.advanced.imageInput')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
    const scrollArea = input.closest('.overflow-y-auto')!;
    expect(
      scrollArea.contains(
        screen.getByRole('button', { name: 'settings.providers.models.disableModel' }),
      ),
    ).toBe(false);
    const close = screen.getByRole('button', { name: 'settings.providers.models.advanced.close' });
    fireEvent.focus(close);
    expect(close.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it.each([
    ['anthropic-claude/claude-opus-4-8', ['claude-code', 'codex', 'pi'], 'Claude Code'],
    ['new-vendor/gpt-9', ['claude-code', 'codex', 'pi'], 'Codex'],
    ['new-labs/next-model', ['pi'], 'Pi'],
  ] as const)('uses the shared recommendation for %s', (id, agents, expected) => {
    const primary = { ...model, id, name: id };
    const models = Object.fromEntries(agents.map((agent) => [agent, [primary]]));
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'xd', agents: [...agents], models }}
        row={{
          id,
          name: id,
          avail: [...agents],
          byAgent: Object.fromEntries(agents.map((agent) => [agent, primary])),
        }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const marker = screen.getByText('newChat.modelSelector.unified.recommended');
    expect(marker.parentElement?.textContent).toContain(expected);
  });

  it('refreshes defaults and controls in an open drawer when the catalog changes', () => {
    const { rerender } = draw();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('272');
    rerender(
      drawer({ ...model, contextWindow: 700_000, efforts: ['high', 'max'], defaultEffort: 'max' }),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('700');
    expect(screen.queryByRole('radio', { name: 'effortLevels.low' })).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'effortLevels.max' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('allows an intentional override above the maximum and rejects invalid input', () => {
    draw();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    fireEvent.change(input, { target: { value: '1200' } });
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1_200_000);
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('retains a mixed saved selection without showing per-engine default labels', () => {
    draw(model, 'low');
    expect(screen.getByText('settings.providers.models.advanced.effortMixed')).toBeTruthy();
    expect(
      screen.queryByText(/settings.providers.models.advanced.engineDefaultEffort/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.high' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-6', 'high');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', 'chatgpt/gpt-6', 'high');
  });

  it('shows one selected depth when another harness needs a supported-level mapping', () => {
    render(drawer(model, 'low', ['low']));
    expect(screen.queryByText('settings.providers.models.advanced.effortMixed')).toBeNull();
    expect(screen.getByRole('radio', { name: 'effortLevels.high' }).getAttribute('aria-checked'))
      .toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.high' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-6', 'high');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', 'chatgpt/gpt-6', 'low');
  });

  it('uses provider-declared image capability ahead of family-name heuristics', () => {
    draw({ ...model, id: 'deepseek-v4', name: 'DeepSeek', supportsImageInput: true });
    expect(screen.getByText('settings.providers.models.advanced.vision.vision')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.inputModalities')).toBeTruthy();
  });
});


it('shows closed Gateway tiers disabled and re-enables them on catalog refresh', () => {
  const restricted: CatalogModel = {
    ...model, efforts: ['high'], defaultEffort: 'high', displayEfforts: ['low', 'high', 'max'],
  };
  const view = render(drawer(restricted));
  const low = screen.getByRole('radio', { name: 'effortLevels.low' }) as HTMLButtonElement;
  expect(low.disabled).toBe(true);
  fireEvent.click(low);
  expect(setProviderModelEffort).not.toHaveBeenCalled();
  view.rerender(drawer({ ...restricted, efforts: ['low', 'high'] }));
  const enabledLow = screen.getByRole('radio', { name: 'effortLevels.low' }) as HTMLButtonElement;
  expect(enabledLow.disabled).toBe(false);
  fireEvent.click(enabledLow);
  expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', model.id, 'low');
  expect((screen.getByRole('radio', { name: 'effortLevels.max' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps the tier row visible when Gateway closes every tier', () => {
  draw({ ...model, efforts: [], defaultEffort: null, displayEfforts: ['low', 'high'] });
  for (const effort of ['low', 'high']) {
    const button = screen.getByRole('radio', { name: `effortLevels.${effort}` }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-checked')).toBe('false');
  }
});


it('describes an absent Harness route as unconfigured rather than unsupported', () => {
  render(<ModelAdvancedDrawer provider={{ ...provider, agents: ['codex', 'claude-code', 'pi'] }}
    row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
    open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()}
    disabled={false} paymentRequired={false} />);
  expect(screen.getByRole('button', { name: 'Pi · settings.providers.models.advanced.engineNotConfigured' })).toBeTruthy();
  expect(screen.queryByLabelText(/engineUnsupported/)).toBeNull();
});

it('limits context and effort reads, writes and resets to the chat runtime', () => {
  vi.mocked(getProviderModelEffort).mockImplementation((agent) => agent === 'codex' ? 'high' : 'low');
  const mixedProvider = { ...provider, id: 'private', source: 'user' as const };
  const row = {
    id: 'shared', name: 'Shared', avail: ['claude-code', 'codex'] as const,
    byAgent: {
      'claude-code': { ...model, id: 'shared', mode: 'image_generation', efforts: ['low'] as typeof model.efforts },
      codex: { ...model, id: 'shared', mode: 'chat' },
    },
  };
  render(<ModelAdvancedDrawer provider={mixedProvider} row={{ ...row, avail: [...row.avail] }} open onOpenChange={vi.fn()} pricePresentationOf={() => null} onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
  expect(mocks.target).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex', relatedTargets: [] }));
  expect(screen.queryByText('settings.providers.models.advanced.effortMixed')).toBeNull();
  expect(vi.mocked(getProviderModelEffort).mock.calls.every(([agent]) => agent === 'codex')).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'effortLevels.low' }));
  expect(setProviderModelEffort).toHaveBeenCalledExactlyOnceWith('codex', 'private', 'shared', 'low');
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }));
  expect(clearProviderModelEffort).toHaveBeenCalledExactlyOnceWith('codex', 'private', 'shared');
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '128' } });
  fireEvent.blur(input);
  expect(mocks.setLimit).toHaveBeenCalledWith(128_000);
  expect(mocks.target).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex', relatedTargets: [] }));
});
