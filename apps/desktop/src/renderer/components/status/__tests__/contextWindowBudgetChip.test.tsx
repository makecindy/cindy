// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpdate = vi.fn();
const mockGetModelsForVendor = vi.fn();
const mockToastError = vi.fn();
const mockGatewayPricing = vi.fn();
const mockModelContextLimit = vi.fn();
const mockModelContextLimitTarget = vi.fn();

vi.mock('@/lib/sessionService', () => ({
  update: (...args: unknown[]) => mockUpdate(...args),
}));
vi.mock('@/lib/modelDefinitions', () => ({
  getModelsForVendor: (...args: unknown[]) => mockGetModelsForVendor(...args),
}));
vi.mock('@/lib/toast', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() },
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => mockGatewayPricing(),
  useReferenceModelPricing: () => null,
}));
// 同路由的模型级「上下文上限」：默认未设置，个别用例覆盖。
vi.mock('@/hooks/useModelContextLimit', () => ({
  useModelContextLimit: (target: unknown) => {
    mockModelContextLimitTarget(target);
    return mockModelContextLimit();
  },
}));
// 本组件不依赖真实词条；翻译 mock 把插值参数原样暴露，断言只落在「档位 / 提交值 / 提示是否出现」。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}#${JSON.stringify(opts)}` : key,
  }),
}));
// Radix 浮层在 jsdom 里不参与交互；按下拉菜单契约替换成最小可控实现（同仓库其它
// 浮层单测的做法），让断言只落在「档位集合 / 提交值」上。
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  const RadioContext = React.createContext<(value: string) => void>(() => {});
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="budget-menu">{children}</div>
    ),
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange?: (value: string) => void;
    }) => (
      <RadioContext.Provider value={onValueChange ?? (() => {})}>
        <div>{children}</div>
      </RadioContext.Provider>
    ),
    DropdownMenuRadioItem: ({
      children,
      value,
      disabled,
    }: {
      children: React.ReactNode;
      value: string;
      disabled?: boolean;
    }) => {
      const onValueChange = React.useContext(RadioContext);
      return (
        <button
          type="button"
          data-token={value}
          disabled={disabled}
          onClick={() => onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

import { ContextWindowBudgetChip, resetRemoteContextWindowBoundsCache } from '../ContextWindowBudgetChip';

const SESSION_ID = 'session-1';

/** 分档计费：<512K 一条价带，≥512K 另一条（价带切换点正好落在 512K 档）。 */
const tieredPricingCatalog = {
  xd: {
    'grok-4.6': {
      providerId: 'xd',
      modelId: 'grok-4.6',
      currency: 'USD' as const,
      source: 'gateway' as const,
      approximate: false,
      inputPerMtok: 0.4,
      outputPerMtok: 1.6,
      inputTokenPriceBands: [
        { minInputTokens: 0, maxInputTokens: 512_000, inputPerMtok: 0.4 },
        { minInputTokens: 512_000, inputPerMtok: 1.2 },
      ],
    },
  },
};

/** 唯一路由（providerId 已限定）→ 默认窗口与上限都按路由解析。 */
const routeCatalog = {
  providers: [
    {
      id: 'xd',
      routing: { 'claude-code': {} },
      models: {
        'claude-code': [
          { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 1_000_000, contextWindowVerified: true },
        ],
      },
    },
  ],
} as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];

/**
 * 打开档位卡并返回档位行：卡片是指针悬浮展开的 `Popover`，**内容只在打开时挂载**；
 * 行是 `role="radio"`（单选语义），不是普通 button。
 */
/** 当前档位行的 token 列表（每次重新查询，`waitFor` 里能看见重渲染后的行）。 */
function tierTokens(): Array<string | null> {
  return (screen.queryAllByRole('radio') as HTMLElement[]).map((el) => el.getAttribute('data-token'));
}

async function openTierCard(): Promise<HTMLElement[]> {
  const rows = (): HTMLElement[] => screen.queryAllByRole('radio') as HTMLElement[];
  if (rows().length > 0) return rows();
  const trigger = document.querySelector('[data-context-window-budget-chip]');
  if (!trigger) throw new Error('context window chip trigger is missing');
  fireEvent.click(trigger);
  await waitFor(() => { expect(rows().length).toBeGreaterThan(0); });
  return rows();
}

/** 触发器不再显示数值：当前档位的可读出处是 aria-label（`triggerLabel`）。 */
function triggerLabel(chip: Element | null): string {
  return chip?.getAttribute('aria-label') ?? '';
}

/**
 * 档位行里出现的百分比（按行序）。i18n 在用例里被换成 `key#{"percent":N}`，
 * 所以直接从行文本里抓 N；抓不到的行（基准未知、只显绝对值）不计入。
 */
function percentsIn(rows: HTMLElement[]): number[] {
  return rows.flatMap((row) => [...(row.textContent ?? '').matchAll(/"percent":(\d+)/g)]
    .map((match) => Number(match[1])));
}

/** 权威边界的形状（本地 `maker:get-context-window-bounds` / 远程 device-link 同名 channel）。 */
function boundsView(
  over: Partial<
    Record<
      "budget" | "budgetCustomized" | "defaultWindow" | "maxWindow" | "modelLimit" | "defaultEffectiveWindow" | "maxEffectiveWindow" | "effectiveWindowsReported",
      unknown
    >
  > = {},
) {
  return {
    providerId: "xd",
    defaultWindow: 1_000_000,
    maxWindow: null,
    modelLimit: null,
    budget: null,
    budgetCustomized: false,
    defaultEffectiveWindow: null,
    maxEffectiveWindow: null,
    // 新主进程/新被控端会显式申报；老端没有这两个字段（用例里显式传 false 模拟）。
    effectiveWindowsReported: true,
    ...over,
  };
}

/** 装一份带指定 bounds mock 的 electronAPI（本地会话走 maker，远程走 deviceLink）。 */
function installElectronApi(getBounds: unknown): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deviceLink: { invoke: vi.fn().mockResolvedValue(null) },
    maker: { getSessionContextWindowBounds: getBounds },
  };
}

function renderChip(
  overrides: Partial<React.ComponentProps<typeof ContextWindowBudgetChip>> & { budget?: number | null } = {},
) {
  const { budget, ...rest } = overrides;
  // 任务预算这次由**权威边界查询**带回（偏好文件里的条目，本地 main / 远程被控端算），
  // 不再是会话快照上的字段：给了档位就把它放进边界响应里。不给 = 边界不可用，
  // chip 按 renderer 自解析兑底（未存过任何档）。
  if (budget) {
    (
      window.electronAPI.maker.getSessionContextWindowBounds as unknown as {
        mockResolvedValue: (value: unknown) => void;
      }
    ).mockResolvedValue({
      providerId: 'xd',
      defaultWindow: 1_000_000,
      maxWindow: null,
      modelLimit: null,
      budget,
      budgetCustomized: true,
    });
  }
  return render(
    <ContextWindowBudgetChip
      sessionId={SESSION_ID}
      contextTokens={0}
      model="grok-4.6"
      providerId="xd"
      agentKind="cc"
      providers={routeCatalog}
      {...rest}
    />,
  );
}

beforeEach(() => {
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({ id: SESSION_ID });
  mockGetModelsForVendor.mockReset();
  mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 1_000_000 }]);
  mockToastError.mockReset();
  mockGatewayPricing.mockReset();
  mockGatewayPricing.mockReturnValue(null);
  mockModelContextLimit.mockReset();
  mockModelContextLimit.mockReturnValue({ limit: null, isCustomized: false });
  mockModelContextLimitTarget.mockReset();
  resetRemoteContextWindowBoundsCache();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    // 默认：被控端不支持该只读查询（或返回不可用）→ 远程保持「只允许收紧」。
    deviceLink: { invoke: vi.fn().mockResolvedValue(null) },
    maker: { getSessionContextWindowBounds: vi.fn().mockResolvedValue(null) },
  };
});

afterEach(() => {
  cleanup();
});

describe('ContextWindowBudgetChip', () => {
  it('renders the catalog default window when no budget is saved', () => {
    renderChip();
    const chip = document.querySelector('[data-context-window-budget-chip]');
    expect(triggerLabel(chip)).toContain('1M');
  });

  it('offers the ladder plus the model default, and reports an explicit tier', async () => {
    renderChip();
    const options = await openTierCard();
    expect(options.map((el) => el.getAttribute('data-token'))).toEqual([
      '250000',
      '500000',
      '1000000',
    ]);
    const defaultOption = options.find((el) => el.getAttribute('data-token') === '1000000');
    expect(defaultOption?.textContent).toContain('optionDefault');

    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '500000')!);
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(SESSION_ID, { contextWindowBudget: 500_000 });
    });
  });

  it('marks the trigger with a text bracket pair plus the current percentage', () => {
    // 用户拍板：底栏不挂文字标签，但要「窗口框 + 百分比」；百分比与卡片行同口径（默认档 = 100%）。
    renderChip();
    const chip = document.querySelector('[data-context-window-budget-chip]');
    // 文本标记（↕，与 `¥` / `1%` 同字号同基线），不是图标、不是括号。
    expect(chip?.textContent).toContain('↕');
    expect(chip?.textContent).toContain('optionPercent#{"percent":100}');
    expect(chip?.textContent).not.toContain('menuTitle');
    expect(chip?.querySelector('svg')).toBeNull();
    // 当前值进可访问名：读屏要能听到绝对窗口。
    expect(chip?.getAttribute('aria-label')).toBe(
      'ccAgent.contextWindowBudget.triggerLabel#{"window":"1M"}',
    );
    const cls = String(chip?.className);
    expect(cls).toContain('text-12');
    expect(cls).toContain('font-medium');
    expect(cls).toContain('text-[var(--msg-tool-card-chevron)]');
    expect(cls).not.toContain('text-[var(--text-tertiary)]');
  });

  it('keeps the card open when the trigger is clicked after hover opened it', async () => {
    // 与底栏用量 chip（TodaySpendChip）一致：展开/收起只由 hover、焦点与 outside-click
    // 驱动，点击不当作开关。用户实测：左边卡片悬浮展开后点击不会收起，本卡却会 —— 两张
    // 底栏卡片的交互必须一样。
    renderChip();
    const trigger = document.querySelector('[data-context-window-budget-chip]')!;
    // 悬浮路径：打开延迟是 300ms，真实定时器下等它落地。
    fireEvent.pointerEnter(trigger);
    await waitFor(() => {
      expect(screen.queryAllByRole('radio').length).toBeGreaterThan(0);
    }, { timeout: 1500 });
    // 悬浮已展开后点击触发器：卡片必须仍然在（Radix 的 toggle 被 preventDefault 拦住）。
    fireEvent.click(trigger);
    expect(screen.queryAllByRole('radio').length).toBeGreaterThan(0);
    // 指针仍在卡内/触发器上时，点击也不应该排下一次关闭。
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryAllByRole('radio').length).toBeGreaterThan(0);
  });

  it('keeps the trigger focusable when the task is read-only', async () => {
    // 用户实测：Tab 到左边用量卡后按多少次 Tab 都回不到本卡 —— 原生 `disabled` 会把触发器
    // 整个移出 Tab 序列（左边用量卡没有这道门）。只读任务仍应能“看一眼当前档位与价带”，
    // 落档能力由档位行自己禁用拦住，并在卡内说明原因。
    installElectronApi(vi.fn(async () => boundsView({ budget: 500_000, budgetCustomized: true })));
    renderChip({ disabled: true, providers: null });
    const trigger = document.querySelector(
      '[data-context-window-budget-chip]',
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    // 可聚焦 = 不被 Tab 跳过（原生 disabled 属性必须不存在）。
    expect(trigger!.disabled).toBe(false);
    expect(trigger!.getAttribute('aria-disabled')).toBe('true');
    // 仍可展开；档位行全部不可选，且有「只读」说明。
    fireEvent.click(trigger!);
    const rows = screen.queryAllByRole('radio') as HTMLButtonElement[];
    await waitFor(() => { expect(rows.length).toBeGreaterThan(0); });
    for (const row of rows) expect(row.disabled).toBe(true);
    expect(screen.getByText('ccAgent.contextWindowBudget.readOnlyHint')).toBeTruthy();
  });

  it('shows the saved tier percentage next to the marker', async () => {
    // 存了 25% 档 → 触发器读 `↕ 25%`（绝对值在 aria-label / 卡片里）。
    // 档位来自权威边界查询（偏好文件里的条目），所以这里要等那次查询回来。
    renderChip({ budget: 250_000 });
    const chip = document.querySelector('[data-context-window-budget-chip]');
    await waitFor(() => {
      expect(chip?.textContent).toContain('optionPercent#{"percent":25}');
    });
  });

  // 乐观记账的作用域与收口（Greptile 复审 P1）：预算是「按会话」存的偏好条目、与路由无关，
  // 所以切模型不该丢掉刚写的值；但同一张卡换到别的会话/设备时必须失效，而且只有**提交之后**
  // 回来的权威回答才有资格把它收口（保存后的那次 refresh 会丢弃之前 in-flight 的结果）。
/** 触发器文本（`↕ 25%`）：百分比在文本里，绝对值在 aria-label（triggerLabel）里。 */
function chipText(): string {
  return document.querySelector('[data-context-window-budget-chip]')?.textContent ?? '';
}

  it('keeps the saved tier while the post-save authoritative answer is still in flight', async () => {
    const getBounds = vi
      .fn()
      .mockResolvedValueOnce(boundsView({ budget: null }))
      // 保存后触发的那次查询永不返回：chip 仍要显示刚提交的档位，而不是回退到旧值。
      .mockImplementation(() => new Promise(() => {}));
    installElectronApi(getBounds);

    renderChip();
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '250000')!);
    await waitFor(() => {
      expect(chipText()).toContain('optionPercent#{"percent":25}');
    });
  });

  it('uses the model-level limit as the effective default when the catalog only has a fallback window', async () => {
    // 自定义连接（未声明窗口）的真实形态：目录 working default 只有兜底 200K，用户把模型级
    // 「上下文上限」设成了 1.05M。运行期窗口 = 模型级上限（main 的 resolveConfiguredContextWindow
    // 在无任务预算时就用它，且刻意不按目录夹），所以 chip 的当前档与档位基准都必须是 1.05M ——
    // 否则会跟圆环报的窗口打架（用户实测报障：圆环 1.0M / chip 200K）。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: null,
      modelLimit: 1_048_000,
      defaultEffectiveWindow: 1_048_000,
    })));

    // providers=null：模拟真实形态里 renderer 侧也拿不到该路由的目录上限（只有 main 的权威边界）。
    renderChip({ providers: null });
    const options = await openTierCard();
    const defaultOption = options.find((el) => el.getAttribute('data-token') === '1048000');
    expect(defaultOption?.textContent).toContain('optionDefault');
    await waitFor(() => {
      expect(chipText()).toContain('optionPercent#{"percent":100}');
    });
  });

  it('clamps the effective default to the physical max the way main does', async () => {
    // Greptile 复审 P1 的形态：已核实路由上模型级上限（1.05M）高于物理上限（200K）时，
    // main 的 resolveVerifiedContextWindow 会夹到物理上限；chip 不能把 1.05M 当成默认档，
    // 否则会显示/选中一个运行期根本达不到的窗口。生效窗口由 main 下发，这里只消费。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: 200_000,
      modelLimit: 1_048_000,
      defaultEffectiveWindow: 200_000,
    })));

    renderChip({ providers: null });
    const options = await openTierCard();
    expect(tierTokens()).not.toContain('1048000');
    const defaultOption = options.find((el) => el.getAttribute('data-token') === '200000');
    expect(defaultOption?.textContent).toContain('optionDefault');
    await waitFor(() => {
      expect(chipText()).toContain('optionPercent#{"percent":100}');
    });
  });

  it('labels the model-default tier with the window after clearing the task budget', async () => {
    // Greptile 复审 P1：默认档不能带当前任务预算。目录默认 200K、模型级上限 800K、当前预算是
    // 500K 时，菜单里的「模型默认」必须是清掉预算后的 200K（选它写 null → 运行期就回到 200K），
    // 而 500K 只能作为「当前档」出现。
    // 路由未声明物理上限（自定义连接）：目录默认 200K 只是兜底，模型级上限 800K 才是上限。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: null,
      modelLimit: 800_000,
      budget: 500_000,
      budgetCustomized: true,
      defaultEffectiveWindow: 800_000,
    })));

    renderChip({ providers: null });
    const options = await openTierCard();
    const defaultOption = options.find((el) => el.textContent?.includes('optionDefault'));
    expect(defaultOption?.getAttribute('data-token')).toBe('800000');
    // 当前档（500K）仍在，且**不是**「模型默认」——点默认档会写 null，运行期回到 800K。
    expect(tierTokens()).toContain('500000');
    expect(options.find((el) => el.getAttribute('data-token') === '500000')?.textContent)
      .not.toContain('optionDefault');
  });

  it('caps the ladder by the physical max main applies even when the catalog omits contextWindowMax', async () => {
    // 已核实但没声明 contextWindowMax 的路由：main 会用 contextWindow 当物理上限
    // （resolveVerifiedContextWindow 的 contextWindowMax ?? contextWindow）。renderer 看不到
    // contextWindowVerified，所以基准必须用 main 下发的 maxEffectiveWindow，否则档位表会给出
    // 运行期被夹回 200K 的 800K 档。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: null,
      modelLimit: 800_000,
      maxEffectiveWindow: 200_000,
      defaultEffectiveWindow: 200_000,
    })));

    renderChip({ providers: null });
    const options = await openTierCard();
    expect(tierTokens()).not.toContain('800000');
    expect(options.find((el) => el.textContent?.includes('optionDefault'))?.getAttribute('data-token'))
      .toBe('200000');
  });

  it('falls back to the conservative (tighten-only) ladder when an old controlled device reports nothing', async () => {
    // Greptile 复审 P1：老被控端不申报生效窗口时，目录没声明 contextWindowMax 也不能把
    // modelLimit 当成物理上限 —— 被控端运行期还会被 contextWindow 夹一次（200K），
    // 本地却按 800K 出档会给出运行期根本达不到的档位与价带。
    installElectronApi(vi.fn().mockResolvedValue({
      providerId: 'xd',
      defaultWindow: 200_000,
      maxWindow: null,
      modelLimit: 800_000,
      budget: null,
      budgetCustomized: false,
      // 老端：没有 defaultEffectiveWindow / maxEffectiveWindow。
      effectiveWindowsReported: false,
    }));

    renderChip({ providers: null });
    const options = await openTierCard();
    expect(tierTokens()).not.toContain('800000');
    expect(options.find((el) => el.textContent?.includes('optionDefault'))?.getAttribute('data-token'))
      .toBe('200000');
  });

  it('lets a post-save authoritative answer override the optimistic tier', async () => {
    // 别的控制端改过值 / 写被夹紧 → 保存后回来的权威值与本机乐观值不同：以权威值收口。
    let calls = 0;
    const getBounds = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? boundsView({ budget: null })
        : boundsView({ budget: 500_000, budgetCustomized: true });
    });
    installElectronApi(getBounds);

    renderChip();
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '250000')!);
    await waitFor(() => {
      expect(chipText()).toContain('optionPercent#{"percent":50}');
    });
  });

  it('does not carry the optimistic tier into another task', async () => {
    installElectronApi(vi.fn(async () => boundsView({ budget: null })));

    const view = renderChip();
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '250000')!);
    await waitFor(() => {
      expect(chipText()).toContain('optionPercent#{"percent":25}');
    });

    // 同一张卡换到另一个会话（新会话未存过档位）：乐观值必须失效，显示回默认档。
    view.rerender(
      <ContextWindowBudgetChip
        sessionId="another-session"
        contextTokens={0}
        model="grok-4.6"
        providerId="xd"
        agentKind="cc"
        providers={routeCatalog}
      />,
    );
    await waitFor(() => {
      expect(chipText()).toContain('optionPercent#{"percent":100}');
    });
  });

  it('uses the quota-card caption gray for every secondary line in the menu', async () => {
    // 说明行与注解（模型默认 / 单价）统一走 `--text-secondary` —— 就是「用量明细」卡（货币符号
    // 那个界面）里说明文字的同一档灰（实测 rgb(111,111,111)）；面板里只有一种「次要灰」。
    renderChip();
    await openTierCard();
    const hint = screen.getByText('ccAgent.contextWindowBudget.menuHint');
    const defaultTag = screen.getByText('ccAgent.contextWindowBudget.optionDefault');
    for (const el of [hint, defaultTag]) {
      expect(String(el.className)).toContain('text-[var(--text-secondary)]');
      expect(String(el.className)).not.toContain('text-[var(--text-tertiary)]');
      expect(String(el.className)).not.toContain('text-[var(--msg-tool-card-chevron)]');
    }
  });

  it('renders every row as「percentage · absolute」with the model default at 100%', async () => {
    // 视觉统一（用户实测反馈）：默认档不再「绝对值在前」，比例档不再「百分比单独上色」——
    // 每一行都是同一个形态、同一种颜色（百分比与绝对值同色，继承行色）。
    renderChip();
    const options = await openTierCard();
    const textOf = (tokens: string): string =>
      options.find((el) => el.getAttribute('data-token') === tokens)?.textContent ?? '';
    expect(textOf('250000')).toContain('optionPercent#{"percent":25}');
    expect(textOf('250000')).toContain('250K');
    expect(textOf('500000')).toContain('optionPercent#{"percent":50}');
    expect(textOf('1000000')).toContain('optionPercent#{"percent":100}');
    expect(textOf('1000000')).toContain('1M');
    expect(textOf('1000000')).toContain('optionDefault');
    // 百分比在前、绝对值在后（默认档也一样）。
    expect(textOf('1000000').indexOf('optionPercent')).toBeLessThan(textOf('1000000').indexOf('1M'));
    // 百分比与绝对值在同一个文本节点里（同一种颜色），不再拆成两个 span 拼色。
    expect(String(textOf('250000'))).toBe(
      'ccAgent.contextWindowBudget.optionPercent#{"percent":25} · 250K',
    );
  });

  it('never renders the model-default tier above 100% when the route has no declared window', async () => {
    // 用户实测报障（2026-09-22）：自定义连接未声明窗口（目录只有 200K 兜底）且用户把模型级
    // 上限设成 1M。旧口径把 200K 当物理上限下发，基准被钉在 200K，于是「模型默认 1M」被
    // 算成 500%。这一例用**修好后 main 应下发的诚实边界**（maxWindow=null），
    // 并补上远程端实测形态：已存任务档 200K 时应看到四行。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: null,
      modelLimit: 1_000_000,
      defaultEffectiveWindow: 1_000_000,
      budget: 200_000,
      budgetCustomized: true,
    })));

    renderChip({ providers: null });
    const options = await openTierCard();
    // 没有声明上限 → 模型级上限 1M 就是显式预算能买到的最大值：100% 档 = 模型默认。
    expect(tierTokens()).toEqual(['200000', '250000', '500000', '1000000']);
    expect(percentsIn(options)).toEqual([20, 25, 50, 100]);
    const textOf = (tokens: string): string =>
      options.find((el) => el.getAttribute('data-token') === tokens)?.textContent ?? '';
    expect(textOf('1000000')).toContain('optionDefault');
  });

  it('does not offer percent tiers above the ceiling main clamps explicit budgets to', async () => {
    // Greptile P1（2026-09-24）：目录**声明了** contextWindowMax=200K 的未核实路由，用户把
    // 模型级上限设成 1M。默认档写 null 走模型级逃生口 → 真的生效在 1M；但 main 会把任何
    // **显式**预算按声明上限夹到 200K，所以菜单不得出现 250K/500K 这种达不到的档
    // （否则窗口与输入价带一起说谎）。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: 200_000,
      modelLimit: 1_000_000,
      defaultEffectiveWindow: 1_000_000,
    })));

    renderChip({ providers: null });
    const options = await openTierCard();
    expect(tierTokens()).toEqual(['200000', '1000000']);
    expect(tierTokens()).not.toContain('250000');
    expect(tierTokens()).not.toContain('500000');
    // 默认档可以合法高于上限：它的百分比按 max(上限, 默认档) 算，不会冒出 >100%。
    expect(percentsIn(options)).toEqual([20, 100]);
    const defaultRow = options.find((el) => el.textContent?.includes('optionDefault'));
    expect(defaultRow?.getAttribute('data-token')).toBe('1000000');
  });

  it('shows absolute values only when the route has no known ceiling at all', async () => {
    // 未核实 + 未声明上限 + 没有模型级上限 = main 没有任何上限可报，而已存预算可能大于默认
    // （旧版本、手改偏好、或另一个控制端写的）。此时没有可信分母，就只显绝对值：
    // 照旧拿 200K 当分母会把 1M 显示成「500%」。
    installElectronApi(vi.fn(async () => boundsView({
      defaultWindow: 200_000,
      maxWindow: null,
      modelLimit: null,
      defaultEffectiveWindow: null,
      budget: 1_000_000,
      budgetCustomized: true,
    })));

    renderChip({ providers: null });
    const options = await openTierCard();
    expect(tierTokens()).toContain('1000000');
    for (const el of options) {
      expect(el.textContent).not.toContain('optionPercent');
    }
    expect(document.querySelector('[data-context-window-budget-chip]')?.textContent)
      .not.toContain('optionPercent');
  });

  it('gives the tier that came from a saved value its own percentage too', async () => {
    // 旧值不在档位集合里时补的「当前档」也走同一形态：按真实占比算百分比。
    renderChip({ budget: 300_000 });
    const options = await openTierCard();
    const current = options.find((el) => el.getAttribute('data-token') === '300000');
    expect(current?.textContent).toContain('optionPercent#{"percent":30}');
    expect(current?.textContent).toContain('300K');
  });

  it('reports null when the model default tier is chosen again', async () => {
    renderChip({ budget: 300_000 });
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '1000000')!);
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(SESSION_ID, { contextWindowBudget: null });
    });
  });

  it('does not re-submit the tier that is already saved', async () => {
    renderChip({ budget: 500_000 });
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '500000')!);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('warns when the chosen tier is below the current context usage', async () => {
    renderChip({ budget: 100_000, contextTokens: 400_000 });
    await openTierCard();
    expect(screen.getByText(/400K/)).toBeTruthy();
  });

  it('surfaces a save failure and keeps the previous selection', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));
    renderChip();
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '250000')!);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    const chip = document.querySelector('[data-context-window-budget-chip]');
    expect(triggerLabel(chip)).toContain('1M');
  });

  it('does not render when the route window is unknown', () => {
    // 路由目录与扁平表都给不出默认窗口 → 没有档位可给，不渲染兜底控件。
    mockGetModelsForVendor.mockReturnValue([]);
    renderChip({ providers: null, model: 'other-model' });
    expect(document.querySelector('[data-context-window-budget-chip]')).toBeNull();
  });

  it('offers the route max tier so a session can raise the window again', async () => {
    // 服务端压低过默认值的路由（默认 200K / 上限 1M）：不提供上限档就无法“调大”。
    // 上限必须来自**路由**（providers），不能来自跨 provider 去重的扁平表。
    const loweredRoute = {
      providers: [
        {
          id: 'xd',
          routing: { 'claude-code': {} },
          models: {
            'claude-code': [
              {
                id: 'grok-4.6',
                name: 'Grok 4.6',
                contextWindow: 200_000,
                contextWindowMax: 1_000_000,
                contextWindowVerified: true,
              },
            ],
          },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 200_000 }]);
    renderChip({ providers: loweredRoute });
    const options = await openTierCard();
    expect(options.at(-1)?.getAttribute('data-token')).toBe('1000000');
    fireEvent.click(options.at(-1)!);
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(SESSION_ID, { contextWindowBudget: 1_000_000 });
    });
  });

  it('keeps only the clamped default when a tight model-level limit is set', async () => {
    // 100K 模型级上限 → 基准 100K：25%/50% 都低于 200K 阈值，100% 就是被压住的默认档。
    mockModelContextLimit.mockReturnValue({ limit: 100_000, isCustomized: true });
    renderChip();
    const options = await openTierCard();
    expect(options.map((el) => el.getAttribute('data-token'))).toEqual(['100000']);
  });

  it('omits the max tier when the route is ambiguous across providers', async () => {
    // 同一 model id 由两个 provider 提供且未限定 providerId：取谁的上限都是猜，只能收紧。
    const ambiguousCatalog = {
      providers: [
        {
          id: 'xd',
          routing: { 'claude-code': {} },
          models: { 'claude-code': [{ id: 'grok-4.6', name: 'Grok', contextWindow: 300_000 }] },
        },
        {
          id: 'xai',
          routing: { 'claude-code': {} },
          models: { 'claude-code': [{ id: 'grok-4.6', name: 'Grok', contextWindow: 300_000 }] },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 300_000 }]);
    renderChip({ providers: ambiguousCatalog, providerId: null });
    const options = await openTierCard();
    // 无可信基准时退回默认窗口 300K：其 25%/50%（75K/150K）低于 200K 阈值，只给默认档。
    expect(options.map((el) => el.getAttribute('data-token'))).toEqual(['300000']);
  });

  it('takes the default from the route for Pi even though the flat table is the only fallback', () => {
    // resolveSessionContextWindow 对 pi/codex 恒返回 null（那是「运行时上报才可信」的
    // 快照口径）；档位锚点不能用它，否则 Pi/Codex 任务永远显示扁平表（跨 provider 首见）的值。
    const piRoute = {
      providers: [
        {
          id: 'xd',
          routing: { pi: {} },
          models: { pi: [{ id: 'grok-4.6', name: 'Grok', contextWindow: 300_000 }] },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 1_000_000 }]);
    renderChip({ agentKind: 'pi', providers: piRoute });
    const chip = document.querySelector('[data-context-window-budget-chip]');
    expect(triggerLabel(chip)).toContain('300K');
    expect(triggerLabel(chip)).not.toContain('1M');
  });

  it('takes the local ladder ceiling from main instead of the renderer-side route guess', async () => {
    // 跨 provider 同 id：renderer 解不出来源（拿不到模型级上限），main 能 —— 档位表必须读
    // main 的权威边界，否则会给出 main 一定会夹掉的档（显示 ≠ 生效）。
    const getBounds = vi.fn().mockResolvedValue({
      providerId: 'xd',
      defaultWindow: 200_000,
      maxWindow: 1_000_000,
      modelLimit: 100_000,
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deviceLink: { invoke: vi.fn().mockResolvedValue(null) },
      maker: { getSessionContextWindowBounds: getBounds },
    };
    const ambiguousCatalog = {
      providers: [
        {
          id: 'xd',
          routing: { 'claude-code': {} },
          models: { 'claude-code': [{ id: 'grok-4.6', name: 'Grok', contextWindow: 1_000_000 }] },
        },
        {
          id: 'xai',
          routing: { 'claude-code': {} },
          models: { 'claude-code': [{ id: 'grok-4.6', name: 'Grok', contextWindow: 1_000_000 }] },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 1_000_000 }]);
    renderChip({ providerId: null, providers: ambiguousCatalog });
    await openTierCard();
    await waitFor(() => {
      expect(tierTokens()).toEqual(['100000']);
    });
    // 查询必须带上**界面上正在显示的路由**：延迟切换期间会话行还是旧路由，
    // 不带路由会被按旧模型回答。
    expect(getBounds).toHaveBeenCalledWith(SESSION_ID, {
      agent: 'claude-code', providerId: null, model: 'grok-4.6',
    });
  });

  it('normalizes a dirty saved budget instead of offering an unsavable tier', async () => {
    // 手改 DB 的浮点值：写入口对非整数直接拒绝，档位表不能把它当成一个可选档。
    renderChip({ budget: 250_000.4 });
    const options = await openTierCard();
    const tokens = options.map((el) => el.getAttribute('data-token'));
    expect(tokens).toContain('250000');
    expect(tokens).not.toContain('250000.4');
  });

  it('falls back to tighten-only when the device answers a malformed bounds payload', async () => {
    const invoke = vi.fn().mockResolvedValue({ defaultWindow: '200000', maxWindow: -1 });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deviceLink: { invoke },
      maker: { getSessionContextWindowBounds: vi.fn().mockResolvedValue(null) },
    };
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 200_000 }]);
    renderChip({ deviceId: 'device-1' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });
    // 畸形值不构成上限：退回默认窗口 200K（其 25%/50% 都低于阈值）→ 只剩默认档，并保留如实说明。
    const options = await openTierCard();
    expect(options.at(-1)?.getAttribute('data-token')).toBe('200000');
    expect(screen.getByText('ccAgent.contextWindowBudget.remoteTightenOnly')).toBeTruthy();
  });

  it('offers the controlled device bounds when the device answers the read-only query', async () => {
    const invoke = vi.fn().mockResolvedValue({
      providerId: 'xd',
      defaultWindow: 200_000,
      maxWindow: 1_000_000,
      modelLimit: null,
    });
    (window as unknown as { electronAPI: { deviceLink: { invoke: unknown } } }).electronAPI = {
      deviceLink: { invoke },
    };
    const localCatalog = {
      providers: [
        {
          id: 'xd',
          routing: { 'claude-code': {} },
          models: {
            'claude-code': [
              { id: 'grok-4.6', name: 'Grok', contextWindow: 200_000, contextWindowMax: 1_000_000 },
            ],
          },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 200_000 }]);
    renderChip({ deviceId: 'device-1', providers: localCatalog });
    // 边界来自被控端 → 上限档出现，且不再显示「只能调小」的说明。
    await openTierCard();
    await waitFor(() => {
      expect(tierTokens().at(-1)).toBe('1000000');
    });
    // 远程查询同样带上显示路由（被控端按它解析，而不是按可能滞后的会话行）。
    expect(invoke).toHaveBeenCalledWith('device-1', 'maker:get-context-window-bounds', [
      SESSION_ID,
      { agent: 'claude-code', providerId: 'xd', model: 'grok-4.6' },
    ]);
    expect(screen.queryByText('ccAgent.contextWindowBudget.remoteTightenOnly')).toBeNull();
  });

  it('stays tighten-only on a remote task instead of trusting the local catalog', async () => {
    // device-link 远程任务的路由/上限在被控端：用本机目录会造出「看到的档位 ≠ 被控端生效值」，
    // 因此只按被控端能力缓存里的默认值允许收紧，不给上限档、也不读本机的模型级上限。
    const localCatalog = {
      providers: [
        {
          id: 'xd',
          routing: { 'claude-code': {} },
          models: {
            'claude-code': [
              { id: 'grok-4.6', name: 'Grok', contextWindow: 200_000, contextWindowMax: 1_000_000 },
            ],
          },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    mockGetModelsForVendor.mockReturnValue([{ id: 'grok-4.6', contextWindow: 200_000 }]);
    renderChip({ deviceId: 'device-1', providers: localCatalog });
    const options = await openTierCard();
    expect(options.at(-1)?.getAttribute('data-token')).toBe('200000');
    expect(mockModelContextLimitTarget).not.toHaveBeenCalledWith(expect.anything());
    // 文案必须如实说明“只能调小”，不能留给用户“能调大”的预期。
    expect(screen.getByText('ccAgent.contextWindowBudget.remoteTightenOnly')).toBeTruthy();
  });

  it('resolves the route provider so the model-level limit still applies without providerId', async () => {
    mockModelContextLimit.mockReturnValue({ limit: 100_000, isCustomized: true });
    // 唯一候选 → chip 自己解出来源，与 main 侧 resolveDesktopModelContextProviderId 同口径。
    const ambiguousFreeCatalog = {
      providers: [
        {
          id: 'xd',
          routing: { 'claude-code': {} },
          models: { 'claude-code': [{ id: 'grok-4.6', name: 'Grok', contextWindow: 1_000_000 }] },
        },
      ],
    } as unknown as React.ComponentProps<typeof ContextWindowBudgetChip>['providers'];
    renderChip({ providerId: null, providers: ambiguousFreeCatalog });
    expect(mockModelContextLimitTarget).toHaveBeenCalledWith({
      agent: 'claude-code',
      providerId: 'xd',
      modelId: 'grok-4.6',
    });
    const options = await openTierCard();
    expect(options.map((el) => el.getAttribute('data-token'))).toEqual(['100000']);
  });

  it('shows the price band each tier lands in', async () => {
    mockGatewayPricing.mockReturnValue(tieredPricingCatalog);
    renderChip();
    const options = await openTierCard();
    const cheap = options.find((el) => el.getAttribute('data-token') === '250000');
    const boundary = options.find((el) => el.getAttribute('data-token') === '1000000');
    expect(cheap?.textContent).toMatch(/\$0\.4/);
    // 512K 及以上进入第二条价带（maxInputTokens 是开区间）。
    expect(boundary?.textContent).toMatch(/\$1\.2/);
  });

  it('ships a remote (device-link) change through the tunnel command, not the local DB', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { electronAPI: { deviceLink: { invoke: typeof invoke } } }).electronAPI = {
      deviceLink: { invoke },
    };
    renderChip({ deviceId: 'device-a' });
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '500000')!);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('device-a', 'maker:set-context-window-budget', [
        SESSION_ID,
        500_000,
      ]);
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('tells the user when the controlled device is too old for the tunnel command', async () => {
    const invoke = vi.fn().mockRejectedValue(
      Object.assign(new Error('channel not allowed'), {
        code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
      }),
    );
    (window as unknown as { electronAPI: { deviceLink: { invoke: typeof invoke } } }).electronAPI = {
      deviceLink: { invoke },
    };
    renderChip({ deviceId: 'device-a' });
    const options = await openTierCard();
    fireEvent.click(options.find((el) => el.getAttribute('data-token') === '250000')!);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining('remoteUnsupported'),
      );
    });
  });

  it('answers bounds for the route being displayed, not the lagging session row', async () => {
    // 用户实测报障：同一引擎内换模型在**发送边界**才落库，期间会话行还是旧模型。
    // 若边界查询只带 sessionId，被控端/主进程会按旧行回答 —— 262K 的千问切到 1M 的
    // deepseek 后 chip 与档位表都停在 262.1K（旧模型的唯一档位）。
    const getBounds = vi.fn(async (_sessionId: string, route?: { model?: string }) =>
      route?.model === 'deepseek/deepseek-v4.1-flash'
        ? { providerId: 'commandcode', defaultWindow: 1_000_000, maxWindow: 1_000_000, modelLimit: null }
        : { providerId: 'commandcode', defaultWindow: 262_144, maxWindow: 262_144, modelLimit: null });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deviceLink: { invoke: vi.fn().mockResolvedValue(null) },
      maker: { getSessionContextWindowBounds: getBounds },
    };
    mockGetModelsForVendor.mockReturnValue([]);
    const view = renderChip({ model: 'Qwen/Qwen3.8-27B', providerId: 'commandcode', providers: null });
    const chip = () => document.querySelector('[data-context-window-budget-chip]');
    await waitFor(() => {
      expect(triggerLabel(chip())).toContain('262.1K');
    });

    // 模型选择器已切到目标模型（会话行还没落库）：chip 必须跟着换档位表与显示值。
    view.rerender(
      <ContextWindowBudgetChip
        sessionId={SESSION_ID}
        contextTokens={0}
        model="deepseek/deepseek-v4.1-flash"
        providerId="commandcode"
        agentKind="pi"
        providers={null}
      />,
    );
    await waitFor(() => {
      expect(triggerLabel(chip())).toContain('1M');
    });
    await openTierCard();
    await waitFor(() => {
      expect(tierTokens()).toEqual(['250000', '500000', '1000000']);
    });
    expect(getBounds).toHaveBeenLastCalledWith(SESSION_ID, {
      agent: 'pi', providerId: 'commandcode', model: 'deepseek/deepseek-v4.1-flash',
    });
  });

  it('gives the radio group a single tab stop, starting on the checked tier', async () => {
    renderChip({ budget: 500_000 });
    const options = await openTierCard();
    const stops = options.filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.getAttribute('data-token')).toBe('500000');
  });

  it('moves focus with arrow keys without committing a new tier', async () => {
    renderChip();
    const options = await openTierCard();
    const [first, second] = options;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await waitFor(() => { expect(document.activeElement).toBe(second); });
    // 焦点移动不是选择：扫过一遍档位不该连写好几次库。
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');
  });

  it('wraps around at both ends and honours Home / End', async () => {
    renderChip();
    const options = await openTierCard();
    const first = options[0];
    const last = options[options.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    await waitFor(() => { expect(document.activeElement).toBe(first); });
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    await waitFor(() => { expect(document.activeElement).toBe(last); });
    fireEvent.keyDown(last, { key: 'Home' });
    await waitFor(() => { expect(document.activeElement).toBe(first); });
    fireEvent.keyDown(first, { key: 'End' });
    await waitFor(() => { expect(document.activeElement).toBe(last); });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('still commits with click / Enter on a focused row', async () => {
    renderChip();
    const options = await openTierCard();
    const target = options[options.length - 2];
    fireEvent.click(target);
    await waitFor(() => { expect(mockUpdate).toHaveBeenCalledTimes(1); });
  });

  it('rekeys the bounds cache when only the provider changes', async () => {
    // 同一模型跨来源的上限可能不同：缓存键少了 providerId 会把 A 来源的边界当成 B 来源的权威值。
    const getBounds = vi.fn(async (_sessionId: string, route?: { providerId?: string | null }) =>
      route?.providerId === 'xd'
        ? { providerId: 'xd', defaultWindow: 1_000_000, maxWindow: 1_000_000, modelLimit: null }
        : { providerId: 'cpa', defaultWindow: 200_000, maxWindow: 200_000, modelLimit: null });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      deviceLink: { invoke: vi.fn().mockResolvedValue(null) },
      maker: { getSessionContextWindowBounds: getBounds },
    };
    mockGetModelsForVendor.mockReturnValue([]);
    const view = renderChip({ providers: null });
    await waitFor(() => {
      expect(triggerLabel(document.querySelector('[data-context-window-budget-chip]'))).toContain('1M');
    });

    view.rerender(
      <ContextWindowBudgetChip
        sessionId={SESSION_ID}
        contextTokens={0}
        model="grok-4.6"
        providerId="cpa"
        agentKind="cc"
        providers={null}
      />,
    );
    await waitFor(() => {
      expect(triggerLabel(document.querySelector('[data-context-window-budget-chip]')))
        .toContain('200K');
    });
  });
});
