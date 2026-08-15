/**
 * 草稿默认模型的可用性校准。
 *
 * 回归的是「全新用户首屏就撞墙」：种子默认模型写死在产品默认里（cc → Opus），与本机
 * 连了哪些来源无关；可连来源不提供那个 id 时，Send 直接禁用、只能弹「当前模型没有已
 * 连接的来源」。校准只作用于**没被显式选过**的默认值。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import {
  calibrateDraftModel,
  pickConnectedModelForAgent,
  resolveDraftSessionProviderId,
  type DraftModelCalibrationInput,
} from '../lib/draftModelCalibration';

/**
 * 两个只取 model id 的薄壳 —— 校准现在同时给出 (模型, 来源)，而绝大多数用例只关心挑中了
 * 哪个模型。来源那一维由本文件末尾的「校准结果要带上供应商」一组用例直接断言原函数。
 */
const pickId = (
  ...args: Parameters<typeof pickConnectedModelForAgent>
): string | null => pickConnectedModelForAgent(...args)?.model ?? null;
const calibratedId = (input: DraftModelCalibrationInput): string =>
  calibrateDraftModel(input).model;

function model(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    group: 'test',
    sortOrder: 0,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
    supportsFastMode: false,
    status: 'active',
    ...over,
  } as CatalogModel;
}

function provider(
  id: string,
  connected: boolean,
  models: Record<string, CatalogModel[]>,
  /** 供应商准入类型；'subscription' 参与「优先订阅」排序（见 providersByPreference）。 */
  access: 'subscription' | 'managed' | 'api' = 'managed',
): ProviderView {
  const agents = Object.keys(models);
  return {
    id,
    name: id,
    source: 'builtin',
    agents,
    models,
    // Provider availability now requires an enabled runtime, not only an entry in `agents`.
    routing: Object.fromEntries(
      agents.map((agent) => [
        agent,
        { upstream: 'https://provider.test', authStrategy: 'none' },
      ]),
    ),
    auth: { method: 'oauth' },
    access: access === 'subscription' ? { kind: 'subscription', product: id } : { kind: access },
    connected,
  } as unknown as ProviderView;
}

const gatewayWithoutOpus = provider('xd', true, {
  'claude-code': [model('claude-sonnet-5'), model('claude-haiku-4-5')],
});
const disconnectedAnthropic = provider('anthropic', false, {
  'claude-code': [model('claude-opus-4-8')],
});
/** 已连接但零模型 —— 正是动态发现失败的 anthropic 的形态。 */
const connectedButEmpty = provider('anthropic', true, { 'claude-code': [] });

describe('pickConnectedModelForAgent', () => {
  it('默认模型本身可用时原样保留,不无谓换模型', () => {
    const providers = [provider('xd', true, { 'claude-code': [model('claude-opus-4-8')] })];
    expect(pickId(providers, 'claude-code', 'claude-opus-4-8')).toBe(
      'claude-opus-4-8',
    );
  });

  it('默认模型没有已连接来源时落到已连接来源的第一个模型', () => {
    expect(
      pickId(
        [gatewayWithoutOpus, disconnectedAnthropic],
        'claude-code',
        'claude-opus-4-8',
      ),
    ).toBe('claude-sonnet-5');
  });

  it('已连接但零模型的来源不算数(动态发现失败的 anthropic)', () => {
    expect(
      pickId([connectedButEmpty], 'claude-code', 'claude-opus-4-8'),
    ).toBeNull();
    // 同时存在一个真有模型的来源时,挑那个。
    expect(
      pickId(
        [connectedButEmpty, gatewayWithoutOpus],
        'claude-code',
        'claude-opus-4-8',
      ),
    ).toBe('claude-sonnet-5');
  });

  it('一个已连接来源都没有时返回 null,交给零来源空态', () => {
    expect(
      pickId([disconnectedAnthropic], 'claude-code', 'claude-opus-4-8'),
    ).toBeNull();
  });

  it('跳过非聊天模型(issue #882 第 3 点,2026-07 review):唯一调用方已预先过滤,但本函数是导出的公共工具,自己也要防', () => {
    const withNonChat = provider('xd', true, {
      'claude-code': [
        { ...model('gpt-image-2'), mode: 'image_generation' },
        model('claude-sonnet-5'),
      ],
    });
    // preferredModelId 本身就是非聊天模型 → 不接受,落到第一个聊天模型
    expect(pickId([withNonChat], 'claude-code', 'gpt-image-2')).toBe('claude-sonnet-5');
    // 首个可用模型兜底同样跳过非聊天模型
    expect(pickId([withNonChat], 'claude-code', 'claude-opus-4-8')).toBe('claude-sonnet-5');
  });

  it('用户自定义供应商显式配置的模型不被 id 启发式误杀(2026-07 review 第 25 轮)', () => {
    // flux-image-x 的 id 撞上 /image/ 启发式,但它来自 source:'user' 的自定义供应商且
    // group 是未知的 custom:*,isAgentSelectableModel 有意放行 —— 校准不得把它当能力模型跳过。
    const userProvider = {
      ...provider('custom-p', true, {
        'claude-code': [model('flux-image-x', { group: 'custom:custom-p' })],
      }),
      source: 'user',
    } as unknown as ProviderView;
    expect(pickId([userProvider], 'claude-code', 'flux-image-x')).toBe('flux-image-x');
    expect(pickId([userProvider], 'claude-code', 'claude-opus-4-8')).toBe('flux-image-x');
  });

  it('取该供应商模型里排序第一个,而不是清单里排前面的那个', () => {
    // 产品定稿：「可用的里面选第一个」= 目录排序第一，不是数组顺序第一。
    const gateway = provider('xd', true, {
      'claude-code': [
        model('claude-haiku-4-5', { sortOrder: 9 }),
        model('claude-opus-5', { sortOrder: 0 }),
        model('claude-sonnet-5', { sortOrder: 6 }),
      ],
    });
    expect(pickId([gateway], 'claude-code', 'claude-opus-4-8')).toBe(
      'claude-opus-5',
    );
  });

  it('供应商优先订阅的 —— 网关折扣路由排得再靠前也不当默认', () => {
    // 折扣路由（codex/ 前缀）在目录里 sortOrder 比官方原版小。拍平所有模型排序会让默认
    // 落到它：那要网关已连接才可用，计费也走网关而不是用户已经付过钱的订阅额度。
    const subscription = provider(
      'openai',
      true,
      { codex: [model('gpt-5.6-sol', { sortOrder: 18 }), model('gpt-5.6-luna', { sortOrder: 17 })] },
      'subscription',
    );
    const gateway = provider('xd', true, {
      codex: [model('codex/gpt-5.6-sol', { sortOrder: 8, group: 'gpt-budget' })],
    });

    expect(pickId([gateway, subscription], 'codex', 'gpt-nonexistent')).toBe(
      'gpt-5.6-luna',
    );
  });

  it('多个订阅供应商时按目录序 —— Claude 订阅在场时 cc tab 落 Claude 系', () => {
    const anthropic = provider(
      'anthropic',
      true,
      { 'claude-code': [model('claude-opus-5', { sortOrder: 0 })] },
      'subscription',
    );
    const openai = provider(
      'openai',
      true,
      { 'claude-code': [model('chatgpt/gpt-5.6-sol', { sortOrder: 18 })] },
      'subscription',
    );

    // 目录序 anthropic → openai，两家都是订阅 → 取 anthropic。
    expect(
      pickId([anthropic, openai], 'claude-code', 'claude-opus-4-8'),
    ).toBe('claude-opus-5');
  });

  it('没有订阅供应商时才落到网关等非订阅来源', () => {
    const gateway = provider('xd', true, {
      codex: [model('codex/gpt-5.6-sol', { sortOrder: 8 }), model('gpt-5.6-sol', { sortOrder: 18 })],
    });
    expect(pickId([gateway], 'codex', 'gpt-nonexistent')).toBe(
      'codex/gpt-5.6-sol',
    );
  });

  it('默认收起的模型不当默认 —— 用户在清单里看不到它', () => {
    // 这正是旧代码写死 gpt-5.5 / gpt-5.4 的实际后果：两个值不一致，且都是目录里
    // defaultEnabled:false 的条目，于是种子默认模型压根不在选择器里。
    const gateway = provider('xd', true, {
      codex: [
        model('gpt-5.4', { sortOrder: 1, defaultEnabled: false }),
        model('gpt-5.6-sol', { sortOrder: 18 }),
      ],
    });
    expect(pickId([gateway], 'codex', 'gpt-nonexistent')).toBe('gpt-5.6-sol');
  });

  it('整组都默认收起时退回纯排序第一,不让该供应商落空', () => {
    const gateway = provider('xd', true, {
      codex: [
        model('gpt-5.4-mini', { sortOrder: 22, defaultEnabled: false }),
        model('gpt-5.4', { sortOrder: 21, defaultEnabled: false }),
      ],
    });
    expect(pickId([gateway], 'codex', 'gpt-nonexistent')).toBe('gpt-5.4');
  });

  it('默认模型可用时,排序与订阅优先都不得抢走它', () => {
    // 第 1 步的优先级不能被择优逻辑破坏 —— 否则首屏会莫名换模型。
    const gateway = provider('xd', true, {
      'claude-code': [
        model('claude-opus-4-8', { sortOrder: 2 }),
        model('claude-opus-5', { sortOrder: 0 }),
      ],
    });
    expect(pickId([gateway], 'claude-code', 'claude-opus-4-8')).toBe(
      'claude-opus-4-8',
    );
  });

  it('不修改传入 provider 的清单顺序（排序必须走副本）', () => {
    const models = [model('b', { sortOrder: 9 }), model('a', { sortOrder: 0 })];
    const gateway = provider('xd', true, { codex: models });
    pickId([gateway], 'codex', 'nonexistent');
    // 展示层依赖 ProviderView 里的原始顺序，原地 sort 会把选择器的分组顺序搅乱。
    expect(models.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('pickConnectedModelForAgent — newSessionDefault 标记优先（步骤 0）', () => {
  it('被标记为新对话默认的模型优先，即便种子模型本身可用', () => {
    const providers = [
      provider('xd', true, {
        'claude-code': [
          model('claude-opus-5', { sortOrder: 0 }),
          model('deepseek', { sortOrder: 44, newSessionDefault: ['claude-code'] }),
        ],
      }),
    ];
    // 种子是可用的 opus-5，但目录/服务端把 deepseek 标为新对话默认 → 落到 deepseek。
    expect(pickId(providers, 'claude-code', 'claude-opus-5')).toBe('deepseek');
  });

  it('没有标记时行为不变：种子可用则保留', () => {
    const providers = [
      provider('xd', true, {
        'claude-code': [model('claude-opus-5'), model('claude-sonnet-5')],
      }),
    ];
    expect(pickId(providers, 'claude-code', 'claude-opus-5')).toBe('claude-opus-5');
  });

  it('标记只在 XD 条目上时，同 ID 来源仍按订阅优先', () => {
    const gateway = provider('xd', true, {
      'claude-code': [model('deepseek', { newSessionDefault: ['claude-code'] })],
    });
    const sub = provider(
      'anthropic',
      true,
      { 'claude-code': [model('deepseek')] },
      'subscription',
    );
    const picked = pickConnectedModelForAgent([gateway, sub], 'claude-code', 'seed');
    expect(picked?.model).toBe('deepseek');
    expect(picked?.providerId).toBe('anthropic');
  });

  it('pi accepts its explicit v3 marker', () => {
    const providers = [
      provider('xd', true, {
        pi: [
          model('claude-sonnet-5', { sortOrder: 0 }),
          model('deepseek', { sortOrder: 44, newSessionDefault: ['pi'] }),
        ],
      }),
    ];
    expect(pickId(providers, 'pi', 'claude-sonnet-5')).toBe('deepseek');
  });

  it('pi does not borrow a claude-code default marker', () => {
    const providers = [
      provider('anthropic', true, {
        pi: [
          model('claude-sonnet-5', { sortOrder: 0 }),
          model('claude-opus-5', { sortOrder: 44, newSessionDefault: ['claude-code'] }),
        ],
      }),
    ];
    expect(pickId(providers, 'pi', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('被标记但默认收起(defaultEnabled:false)时不选', () => {
    const providers = [
      provider('xd', true, {
        'claude-code': [
          model('visible', { sortOrder: 5 }),
          model('hidden', {
            sortOrder: 0,
            defaultEnabled: false,
            newSessionDefault: ['claude-code'],
          }),
        ],
      }),
    ];
    expect(pickId(providers, 'claude-code', 'visible')).toBe('visible');
  });

  it('用户显式选过时，标记不覆盖用户选择', () => {
    const providers = [
      provider('xd', true, {
        'claude-code': [model('my-pick'), model('deepseek', { newSessionDefault: ['claude-code'] })],
      }),
    ];
    expect(
      calibratedId({
        providers,
        agent: 'claude-code',
        model: 'my-pick',
        chosenByUser: true,
        providersLoading: false,
      }),
    ).toBe('my-pick');
  });

  it('当前来源有偏好时，区域默认只在该来源内部校准，不会静默丢来源', () => {
    const providers = [
      provider(
        'anthropic',
        true,
        {
          'claude-code': [model('my-pick')],
        },
        'subscription',
      ),
      provider('xd', true, {
        'claude-code': [model('deepseek', { newSessionDefault: ['claude-code'] })],
      }),
    ];
    expect(
      calibrateDraftModel({
        providers,
        agent: 'claude-code',
        model: 'my-pick',
        chosenByUser: false,
        preferredProviderId: 'anthropic',
        providersLoading: false,
      }),
    ).toEqual({ model: 'my-pick', providerId: 'anthropic' });
  });

  it('区域 marker 只在 XD 声明时，选定来源仍可承接其提供的同 ID 模型', () => {
    const providers = [
      provider(
        'anthropic',
        true,
        {
          'claude-code': [model('deepseek')],
        },
        'subscription',
      ),
      provider('xd', true, {
        'claude-code': [
          model('deepseek', { newSessionDefault: ['claude-code'] }),
          model('old-default'),
        ],
      }),
    ];
    expect(
      calibrateDraftModel({
        providers,
        agent: 'claude-code',
        model: 'old-default',
        chosenByUser: false,
        preferredProviderId: 'anthropic',
        providersLoading: false,
      }),
    ).toEqual({ model: 'deepseek', providerId: 'anthropic' });
  });

  it('陈旧的来源偏好不阻塞区域默认，回退完整的已连接候选', () => {
    const providers = [
      provider('xd', true, {
        'claude-code': [model('deepseek', { newSessionDefault: ['claude-code'] })],
      }),
    ];
    expect(
      calibrateDraftModel({
        providers,
        agent: 'claude-code',
        model: 'old-model',
        chosenByUser: false,
        preferredProviderId: 'disconnected-provider',
        providersLoading: false,
      }),
    ).toEqual({ model: 'deepseek', providerId: 'xd' });
  });
});

describe('calibrateDraftModel', () => {
  const base = {
    providers: [gatewayWithoutOpus, disconnectedAnthropic],
    agent: 'claude-code' as const,
    model: 'claude-opus-4-8',
    providersLoading: false,
  };

  it('校准从未被显式选过的种子默认', () => {
    expect(calibratedId({ ...base, chosenByUser: false })).toBe('claude-sonnet-5');
  });

  it('绝不改写用户显式选过的模型', () => {
    expect(calibratedId({ ...base, chosenByUser: true })).toBe('claude-opus-4-8');
  });

  it('供应商清单加载期不校准,避免首帧闪模型', () => {
    expect(calibratedId({ ...base, chosenByUser: false, providersLoading: true })).toBe(
      'claude-opus-4-8',
    );
  });

  it('没有任何可用来源时原样返回,不返回空', () => {
    expect(
      calibratedId({ ...base, providers: [disconnectedAnthropic], chosenByUser: false }),
    ).toBe('claude-opus-4-8');
  });

  it('候选来源由调用方先过滤 —— SSH 草稿不该被推荐仅本地可桥接的来源', () => {
    // 调用方(NewMakerDraftRoute)按 filterChatBridgedCodexProviders 先剔除 chat-bridged
    // codex 来源;校准只在剩下的候选里挑,不会把远端根本路由不出去的模型选成默认。
    const localOnlyBridge = provider('chatgpt', true, {
      codex: [model('gpt-5.5-bridge')],
    });
    const routableEverywhere = provider('xd', true, { codex: [model('gpt-5.5')] });

    // 未过滤(本地草稿):bridge 来源可用。
    expect(
      calibratedId({
        providers: [localOnlyBridge, routableEverywhere],
        agent: 'codex',
        model: 'gpt-nonexistent',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('gpt-5.5-bridge');

    // 已过滤(SSH 草稿):只会落到远端也能路由的来源。
    expect(
      calibratedId({
        providers: [routableEverywhere],
        agent: 'codex',
        model: 'gpt-nonexistent',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('gpt-5.5');
  });

  it('候选须由调用方逐模型预过滤 —— 供应商级过滤盖不住同一供应商里的混合清单', () => {
    // 同一个已连接供应商里既有订阅直连模型(远端 bridge 不可达)又有可路由模型。
    // 过滤放在候选构造上而不是这里:同一份候选还要喂给来源解析,只在挑模型时过滤会让
    // 来源解析仍看见被剔除的条目,从而选中一个用户已排除掉该模型的来源。
    const models = [model('chatgpt/gpt-5.5'), model('claude-sonnet-5')];
    const input = {
      agent: 'claude-code' as const,
      model: 'claude-opus-4-8',
      chosenByUser: false,
      providersLoading: false,
    };

    // 本地草稿:候选未剔除,取清单里的第一个。
    expect(
      calibratedId({
        ...input,
        providers: [provider('xd', true, { 'claude-code': models })],
      }),
    ).toBe('chatgpt/gpt-5.5');

    // SSH 草稿:候选已剔除订阅直连,落到真正可路由的模型。
    expect(
      calibratedId({
        ...input,
        providers: [
          provider('xd', true, {
            'claude-code': models.filter((m) => !m.id.startsWith('chatgpt/')),
          }),
        ],
      }),
    ).toBe('claude-sonnet-5');
  });

  it('候选里剔掉用户隐藏的条目后就不会被选成默认(与选择器可见性同口径)', () => {
    const visibleOnly = [model('claude-sonnet-5')];
    expect(
      calibratedId({
        providers: [provider('xd', true, { 'claude-code': visibleOnly })],
        agent: 'claude-code',
        model: 'claude-opus-4-8',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('claude-sonnet-5');
  });

  it('某来源的模型被剔光后整条来源不再是候选,不会被解析成生效来源', () => {
    // 调用方会把「过滤后零模型」的来源整条丢掉;这里断言即便传进来也不会被选中。
    const emptied = provider('xd', true, { 'claude-code': [] });
    const usable = provider('anthropic', true, { 'claude-code': [model('claude-sonnet-5')] });
    expect(
      calibratedId({
        providers: [emptied, usable],
        agent: 'claude-code',
        model: 'claude-opus-4-8',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('claude-sonnet-5');
  });
});

describe('校准结果要带上供应商', () => {
  // 回归 PR #1076 review:只交出 model id 时,下游 nativeDefaultSourceId 对 claude-code
  // 无条件优先 XD 网关 —— 校准好的「anthropic 订阅提供的模型」会被重新指回网关,计费落
  // 网关而不是用户已付费的订阅额度,「订阅优先」在最后一步被推翻。
  const anthropicSub = provider(
    'anthropic',
    true,
    { 'claude-code': [model('claude-opus-5', { sortOrder: 0 })] },
    'subscription',
  );
  const gatewaySameModel = provider('xd', true, {
    'claude-code': [model('claude-opus-5', { sortOrder: 0 })],
  });

  it('两家都提供同一个模型时,来源给的是订阅那家', () => {
    const picked = pickConnectedModelForAgent(
      [gatewaySameModel, anthropicSub],
      'claude-code',
      'claude-opus-4-8',
    );
    expect(picked).toEqual({ model: 'claude-opus-5', providerId: 'anthropic' });
  });

  it('默认值本身可用时也给出订阅来源(第 1 步不该丢掉来源维度)', () => {
    const picked = pickConnectedModelForAgent(
      [gatewaySameModel, anthropicSub],
      'claude-code',
      'claude-opus-5',
    );
    expect(picked).toEqual({ model: 'claude-opus-5', providerId: 'anthropic' });
  });

  it('用户已显式选过 / 清单在加载 / 无可用来源时不给来源结论', () => {
    const base = {
      providers: [anthropicSub],
      agent: 'claude-code' as const,
      model: 'claude-opus-5',
      chosenByUser: false,
      providersLoading: false,
    };
    expect(calibrateDraftModel({ ...base, chosenByUser: true }).providerId).toBeNull();
    expect(calibrateDraftModel({ ...base, providersLoading: true }).providerId).toBeNull();
    expect(
      calibrateDraftModel({ ...base, providers: [disconnectedAnthropic] }).providerId,
    ).toBeNull();
  });

  it('存量草稿里持久化的隐藏默认模型要被校准掉,而不是因「有来源提供」就留下', () => {
    // 回归 PR #1076 review 第三轮:存量用户的草稿存着旧代码写死的 gpt-5.4 / gpt-5.5,
    // 而这两个 id 在目录里都是 defaultEnabled:false。modelChosenByVendor 仍为 false,
    // 正是这套校准要迁移的那批;只判「某来源提供它」会把它们原样留下,用户继续用一个
    // 在默认选择器里看不到的模型。
    const gateway = provider('xd', true, {
      codex: [
        model('gpt-5.4', { sortOrder: 21, defaultEnabled: false }),
        model('gpt-5.6-sol', { sortOrder: 18 }),
      ],
    });

    expect(pickId([gateway], 'codex', 'gpt-5.4')).toBe('gpt-5.6-sol');
    expect(
      calibratedId({
        providers: [gateway],
        agent: 'codex',
        model: 'gpt-5.4',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('gpt-5.6-sol');
  });

  it('用户真选过的模型即便默认收起也一律不动', () => {
    // chosenByUser 在 calibrateDraftModel 里更早短路 —— 上一条的收紧不能连坐到它。
    const gateway = provider('xd', true, {
      codex: [
        model('gpt-5.4', { sortOrder: 21, defaultEnabled: false }),
        model('gpt-5.6-sol', { sortOrder: 18 }),
      ],
    });
    expect(
      calibratedId({
        providers: [gateway],
        agent: 'codex',
        model: 'gpt-5.4',
        chosenByUser: true,
        providersLoading: false,
      }),
    ).toBe('gpt-5.4');
  });

  it('校准出结论时 model 与 providerId 成对给出', () => {
    const result = calibrateDraftModel({
      providers: [gatewaySameModel, anthropicSub],
      agent: 'claude-code',
      model: 'claude-opus-4-8',
      chosenByUser: false,
      providersLoading: false,
    });
    expect(result).toEqual({ model: 'claude-opus-5', providerId: 'anthropic' });
  });
});

describe('resolveDraftSessionProviderId', () => {
  it('唯一已连接来源是用户 Provider 时仍显式保留，避免 Claude 回退 Cindy gateway', () => {
    const codingPlan = {
      ...provider('coding-plan', true, {
        'claude-code': [model('ark-code-latest')],
      }),
      source: 'user',
    } as ProviderView;

    expect(
      resolveDraftSessionProviderId({
        providers: [codingPlan],
        agent: 'claude-code',
        model: 'ark-code-latest',
        explicitProviderId: null,
        effectiveProviderId: 'coding-plan',
      }),
    ).toBe('coding-plan');
  });

  it('XD 已连接但不提供当前模型时,不能省略校准选中的 Anthropic 来源(issue #1196)', () => {
    const gateway = provider('xd', true, {
      'claude-code': [model('claude-sonnet-5')],
    });
    const anthropic = provider(
      'anthropic',
      true,
      { 'claude-code': [model('claude-opus-5')] },
      'subscription',
    );

    expect(
      resolveDraftSessionProviderId({
        providers: [gateway, anthropic],
        agent: 'claude-code',
        model: 'claude-opus-5',
        explicitProviderId: null,
        effectiveProviderId: 'anthropic',
      }),
    ).toBe('anthropic');
  });

  it('只有 Anthropic 已连接时仍可省略来源,保留默认路由语义', () => {
    const anthropic = provider(
      'anthropic',
      true,
      { 'claude-code': [model('claude-opus-5')] },
      'subscription',
    );

    expect(
      resolveDraftSessionProviderId({
        providers: [anthropic],
        agent: 'claude-code',
        model: 'claude-opus-5',
        explicitProviderId: null,
        effectiveProviderId: 'anthropic',
      }),
    ).toBeNull();
  });

  it('XD 被停用时仍按 main 的 spawn 默认语义保留 Anthropic 来源', () => {
    const suspendedGateway = {
      ...provider('xd', true, {
        'claude-code': [model('claude-opus-5')],
      }),
      suspended: true,
    } as ProviderView;
    const anthropic = provider(
      'anthropic',
      true,
      { 'claude-code': [model('claude-opus-5')] },
      'subscription',
    );

    expect(
      resolveDraftSessionProviderId({
        providers: [suspendedGateway, anthropic],
        agent: 'claude-code',
        model: 'claude-opus-5',
        explicitProviderId: null,
        effectiveProviderId: 'anthropic',
      }),
    ).toBe('anthropic');
  });

  it('Codex 折扣模型只由 XD 提供时显式保留 XD,锁定既有实际落点', () => {
    const openai = provider(
      'openai',
      true,
      { codex: [model('gpt-5.6-sol')] },
      'subscription',
    );
    const gateway = provider('xd', true, {
      codex: [model('codex/gpt-5.6-sol')],
    });

    expect(
      resolveDraftSessionProviderId({
        providers: [openai, gateway],
        agent: 'codex',
        model: 'codex/gpt-5.6-sol',
        explicitProviderId: null,
        effectiveProviderId: 'xd',
      }),
    ).toBe('xd');
  });

  it('用户显式选择且仍有效时始终保留该来源', () => {
    const gateway = provider('xd', true, {
      'claude-code': [model('claude-opus-5')],
    });

    expect(
      resolveDraftSessionProviderId({
        providers: [gateway],
        agent: 'claude-code',
        model: 'claude-opus-5',
        explicitProviderId: 'xd',
        effectiveProviderId: 'xd',
      }),
    ).toBe('xd');
  });
});
