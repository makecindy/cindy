/**
 * AddProviderWizard —— 「添加供应商」三步向导(2026-07 模型供应商重构)。
 *
 *   Step 1 选择供应商:目录画廊,**一家一张卡**(订阅渠道 = 目录里未连接的 OAuth
 *           供应商;API Key 预设 = 目录 presets 段;自定义端点 = 逃生口,直接打开
 *           完整表单 CustomProviderDialog)。鉴权方式由供应商定义决定,不让用户猜。
 *   Step 2 连接:OAuth 渠道 = 一键授权(复用既有鉴权流,成功即完成,模型走动态
 *           发现链路,无第 3 步);预设 = 名称 + API Key(baseUrl 由预设携带)。
 *   Step 3 选择模型(仅预设):自动拉取列模型端点,预设推荐模型预勾;拉取失败
 *           降级为「仅预设推荐模型」仍可完成(不把用户堵死在网络错误上)。
 *
 * codex 兼容性提示:数据驱动 —— 预设/供应商只声明单 runtime 时显示「仅支持 X」
 * 说明行;不在向导里做运行时探测(探测能力在编辑表单的「测试连接」,后续迭代再
 * 上探测式灰态)。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Info, Plus, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { createCustomProvider, type RuntimeKeys } from '@/lib/customProviders';
import { uniqueCustomProviderId } from '@/lib/customProviderId';
import { providerMonogram } from '@/lib/providerModels';
import { isChatGptConnectionConnected, useCodexAuth } from '@/hooks/useCodexAuth';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';

import { presetDisplayName, sortPresetsForLocale } from '@cindy/model-providers';
import type {
  AgentKind,
  CustomProviderConfig,
  ProviderPreset,
  ProviderView,
} from '@cindy/model-providers';

/**
 * 外部直达入口:
 *   - builtin(左栏检测建议 / 引导卡 OAuth 行):直接进入该内置渠道的授权步。
 *   - preset(引导卡「其他供应商」行):presets 异步载入后直达该预设的表单步。
 */
export type WizardEntry =
  { kind: 'builtin'; providerId: string } | { kind: 'preset'; presetId: string };

interface AddProviderWizardProps {
  providers: ProviderView[];
  entry?: WizardEntry;
  /** 「自定义端点」卡片 → 关闭向导并打开完整表单。 */
  onOpenCustomForm: () => void;
  onClose: () => void;
  /** 完成(授权成功 / 预设创建成功);providerId 用于左栏选中新供应商。 */
  onDone: (providerId?: string) => void;
}

type Selection =
  { kind: 'oauth'; provider: ProviderView } | { kind: 'preset'; preset: ProviderPreset };

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/**
 * bespoke OAuth 渠道的官方 API 预设——授权步「改用 API Key 接入」的替代路径
 * (API 用户没有订阅,OAuth 授权对其是错误路径)。
 *
 * 不能复用 OAuth routing 的 upstream:那是订阅专用端点(openai 是 chatgpt
 * backend)。此处声明官方 API 端点,模型清单以 Step 3 列模型接口实拉为准
 * (缺省由 baseUrl 推导 …/v1/models,见 provider-model-fetch);同时内置少量
 * 推荐模型兜底——拉取因网络/限流失败时降级为「仅推荐模型」仍可完成创建,
 * 不把用户堵死(与目录预设同语义;Greptile P1 反馈 2026-07-24)。
 * cc runtime 需 Anthropic 兼容端点、codex 需 OpenAI 兼容端点,故 openai/xai
 * 仅声明 codex(两家无 Anthropic 兼容端点),表单会自动展示「仅支持 X」说明行。
 */
const OFFICIAL_API_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    id: 'anthropic-api',
    name: 'Anthropic API',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    runtimes: {
      'claude-code': {
        baseUrl: 'https://api.anthropic.com',
        // contextWindow 必须与目录(providers.json)一致:保存时它是窗口的唯一来源
        // (拉取的模型列表不带窗口),缺省会落 200k 默认 → toSdkModelString 剥掉
        // 1M 模型的 [1m] 路由,用户拿到 1/5 窗口。
        models: [
          { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000 },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000 },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000 },
        ],
      },
    },
  },
  openai: {
    id: 'openai-api',
    name: 'OpenAI API',
    docsUrl: 'https://platform.openai.com/api-keys',
    runtimes: {
      codex: {
        baseUrl: 'https://api.openai.com/v1',
        models: [
          { id: 'gpt-5.5', name: 'GPT-5.5' },
          { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
        ],
      },
    },
  },
  xai: {
    id: 'xai-api',
    name: 'xAI API',
    docsUrl: 'https://console.x.ai',
    runtimes: {
      codex: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-chat',
        models: [
          { id: 'grok-4.5', name: 'Grok 4.5' },
          { id: 'grok-4.3', name: 'Grok 4.3' },
        ],
      },
    },
  },
};

/** 供应商卡片图标。 */
function cardIcon(sel: { providerId?: string; name: string }): React.ReactNode {
  if (sel.providerId && hasProviderLogo(sel.providerId)) {
    return <ProviderLogoMark providerId={sel.providerId} size={15} />;
  }
  return <span className="text-12 font-semibold leading-none">{providerMonogram(sel.name)}</span>;
}

/** 单行供应商名；只有实际发生截断时才在 hover 后展示完整名称。 */
function ProviderCardName({ name }: { name: string }) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const element = nameRef.current;
    if (!element) return;
    const measure = () => setTruncated(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Tip 启停会改变子树并重挂 span，truncated 变化时必须把 observer 绑定到新节点。
    return () => observer.disconnect();
  }, [name, truncated]);

  const text = (
    <span
      ref={nameRef}
      className="min-w-0 truncate text-13 font-medium"
      style={{ color: 'var(--settings-section-title)' }}
    >
      {name}
    </span>
  );

  return truncated ? (
    <Tip text={name} delay={250} contentClassName="z-[10001] max-w-[320px] [word-break:normal]">
      {text}
    </Tip>
  ) : (
    text
  );
}

function ProviderCard({
  icon,
  name,
  meta,
  onClick,
}: {
  icon: React.ReactNode;
  name: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
      style={{
        borderColor: 'var(--border-default)',
        backgroundColor: 'var(--surface-elevated)',
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{
            backgroundColor: 'var(--settings-integration-avatar-bg)',
            border: '1px solid var(--settings-integration-avatar-border)',
            color: 'var(--settings-integration-avatar-icon)',
          }}
        >
          {icon}
        </span>
        <ProviderCardName name={name} />
      </span>
      <span className="truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
        {meta}
      </span>
    </button>
  );
}

function InfoLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-12" style={{ color: 'var(--text-tertiary)' }}>
      <Info size={13} className="mt-[1px] shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="pb-1.5 pt-3 text-11 font-semibold uppercase"
      style={{ color: 'var(--text-tertiary)', letterSpacing: '0.4px' }}
    >
      {children}
    </span>
  );
}

export function AddProviderWizard({
  providers,
  entry,
  onOpenCustomForm,
  onClose,
  onDone,
}: AddProviderWizardProps) {
  const { t, i18n } = useTranslation();
  const codexAuth = useCodexAuth();

  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [query, setQuery] = useState('');
  // entry(左栏检测建议 / 引导卡直达):目录里找得到该渠道才直达授权步,否则回落目录页。
  const entryProvider =
    entry?.kind === 'builtin' ? providers.find((x) => x.id === entry.providerId) : undefined;
  const [sel, setSel] = useState<Selection | null>(() =>
    entryProvider ? { kind: 'oauth', provider: entryProvider } : null,
  );
  // 预设表单态
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  // Step 3 拉取态
  const [step, setStep] = useState<1 | 2 | 3>(entryProvider ? 2 : 1);
  const [fetchState, setFetchState] = useState<
    { status: 'idle' } | { status: 'fetching' } | { status: 'done'; failed: boolean }
  >({ status: 'idle' });
  /**
   * 勾选清单:id → { name, checked, recommended, agents }。Map 保序(推荐在前,拉取新增在后)。
   * agents = 该模型归属的 runtime:预设推荐模型归属「预设里列出它的那些 runtime」;拉取新增
   * 归属「实际返回它的那个端点的 runtime」——完成创建时按归属分发,**不**把统一列表复制进
   * 每个 runtime(双 runtime 预设两端模型集可以不同,cc-only 模型不能写进 codex,反之亦然)。
   */
  const [picks, setPicks] = useState<
    Map<string, { name: string; checked: boolean; recommended: boolean; agents: AgentKind[] }>
  >(new Map());

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .listProviderPresets()
      .then((r) => {
        if (!cancelled) setPresets(r.presets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 1 数据:未连接的 OAuth 渠道(bespoke 三家 + 目录通用 OAuth;xd 凭据自动下发不进向导)。
  const oauthChoices = useMemo(
    () =>
      providers.filter(
        (p) =>
          p.id !== 'xd' &&
          p.source === 'builtin' &&
          !p.connected &&
          (['anthropic', 'openai', 'xai'].includes(p.id) ||
            (p.auth.method === 'oauth' && !!p.auth.oauth)),
      ),
    [providers],
  );
  const sortedPresets = useMemo(
    () => sortPresetsForLocale(presets, i18n.language),
    [presets, i18n.language],
  );
  const q = query.trim().toLowerCase();
  const filteredOauth = q
    ? oauthChoices.filter((p) => p.name.toLowerCase().includes(q))
    : oauthChoices;
  const filteredPresets = q
    ? sortedPresets.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.nameEn?.toLowerCase().includes(q) ?? false),
      )
    : sortedPresets;

  /**
   * 拉取请求序号:防过期响应(与 CustomProviderDialog 的 fetchRequestSignature 同模式)。
   * 换选供应商 / 返回目录都会推进序号,慢返回的旧请求结果直接丢弃,不污染新预设的勾选清单。
   */
  const fetchSeqRef = useRef(0);

  const pickOauth = useCallback((provider: ProviderView) => {
    fetchSeqRef.current += 1;
    setSel({ kind: 'oauth', provider });
    setStep(2);
  }, []);
  const pickPreset = useCallback(
    (preset: ProviderPreset) => {
      fetchSeqRef.current += 1;
      setSel({ kind: 'preset', preset });
      setName(presetDisplayName(preset, i18n.language));
      setApiKey('');
      setStep(2);
    },
    [i18n.language],
  );

  // entry(preset 直达):presets 异步载入,到位后消费;找不到该预设则留在目录页。
  // 按 presetId 记录已消费值(而非布尔):同一挂载期内 entry 换成另一个 preset
  // (如深链二次进入)仍能直达,同一 entry 不重复触发。
  const presetEntryConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (entry?.kind !== 'preset' || presetEntryConsumedRef.current === entry.presetId) return;
    if (presets.length === 0) return;
    presetEntryConsumedRef.current = entry.presetId;
    const preset = presets.find((p) => p.id === entry.presetId);
    if (preset) pickPreset(preset);
  }, [entry, presets, pickPreset]);

  /**
   * 本向导内是否发起过 OpenAI 登录。codexAuth 反映的是整机 ChatGPT 凭证,不含
   * 「凭证归哪个账号」的 native binding —— 换账号后本机可能已有别人绑定的登录,
   * 此时 codexAuth 一挂载就是 connected;若不加此限定,检测建议直达打开的向导会
   * 挂载即自关,既不弹任何 UI 也不给当前账号补绑定,「去授权」永远点不出效果。
   */
  const openaiLoginStartedRef = useRef(false);

  // ── OAuth 授权(复用既有鉴权流;成功即完成,无第 3 步)────────────────────
  const handleAuthorize = useCallback(async () => {
    if (!sel || sel.kind !== 'oauth') return;
    const id = sel.provider.id;
    setLoggingIn(true);
    try {
      let ok = false;
      if (id === 'anthropic') {
        const r = await window.electronAPI.maker.claudeOAuthLogin();
        ok = r.ok;
        if (!r.ok && r.reason === 'not_a_subscription') {
          toast.error(t('settings.connections.claude.toast.notSubscription'));
          return;
        }
        if (!r.ok && r.reason === 'login_cancelled') return;
      } else if (id === 'openai') {
        openaiLoginStartedRef.current = true;
        const outcome = await codexAuth.triggerLogin();
        ok = outcome === 'authenticated';
        if (outcome === 'cancelled') return;
      } else if (id === 'xai') {
        const r = await window.electronAPI.maker.xaiOAuthLogin();
        ok = r.ok;
        if (!r.ok && r.reason === 'login_cancelled') return;
      } else {
        const r = await window.electronAPI.maker.providerOAuthLogin(id);
        ok = r.ok;
        if (!r.ok && r.reason === 'login_cancelled') return;
      }
      if (ok) {
        toast.success(t('settings.providers.wizard.authorizedToast', { name: sel.provider.name }));
        onDone(id);
      } else {
        toast.error(t('settings.providers.wizard.authorizeFailed', { name: sel.provider.name }));
      }
    } catch {
      toast.error(t('settings.providers.wizard.authorizeFailed', { name: sel.provider.name }));
    } finally {
      setLoggingIn(false);
    }
  }, [sel, codexAuth, onDone, t]);

  /**
   * 取消进行中的 OAuth(与详情头的行为对称):等待授权期间点按钮 / 关弹窗 / 返回
   * 都必须能中止 main 侧 login runner,否则浏览器流挂起时用户无法重试。
   */
  const cancelAuthorize = useCallback(() => {
    if (!sel || sel.kind !== 'oauth') return;
    const id = sel.provider.id;
    if (id === 'anthropic') void window.electronAPI.maker.claudeOAuthCancel();
    else if (id === 'openai') void codexAuth.cancelLogin();
    else if (id === 'xai') void window.electronAPI.maker.xaiOAuthCancel();
    else void window.electronAPI.maker.providerOAuthCancel(id);
    setLoggingIn(false);
  }, [sel, codexAuth]);

  /** 关闭向导:授权等待中先取消再关,不留挂起的 login runner。 */
  const handleClose = useCallback(() => {
    if (loggingIn) cancelAuthorize();
    onClose();
  }, [loggingIn, cancelAuthorize, onClose]);

  // OpenAI 走 useCodexAuth:hook 状态翻 connected 时视为完成(triggerLogin 也会返回,
  // oneshot ref 保证只收口一次)。只收口本向导内发起的登录(openaiLoginStartedRef),
  // 不把「本机已有凭证」误当成完成 —— 见 openaiLoginStartedRef 的注释。
  const openaiDoneRef = useRef(false);
  useEffect(() => {
    if (openaiDoneRef.current || !openaiLoginStartedRef.current) return;
    if (
      sel?.kind === 'oauth' &&
      sel.provider.id === 'openai' &&
      isChatGptConnectionConnected(codexAuth.state, false)
    ) {
      openaiDoneRef.current = true;
      onDone('openai');
    }
  }, [codexAuth.state, sel, onDone]);

  // ── 预设:进入 Step 3 时自动拉取模型 ─────────────────────────────────────
  const startFetch = useCallback(async () => {
    if (!sel || sel.kind !== 'preset') return;
    const preset = sel.preset;
    // 预设推荐模型先入清单(预勾);归属 = 预设里列出该模型的全部 runtime。
    const initial = new Map<
      string,
      { name: string; checked: boolean; recommended: boolean; agents: AgentKind[] }
    >();
    for (const agent of Object.keys(preset.runtimes) as AgentKind[]) {
      for (const m of preset.runtimes[agent]?.models ?? []) {
        const existing = initial.get(m.id);
        if (existing) {
          if (!existing.agents.includes(agent)) existing.agents.push(agent);
        } else {
          initial.set(m.id, { name: m.name, checked: true, recommended: true, agents: [agent] });
        }
      }
    }
    setPicks(initial);
    setStep(3);
    setFetchState({ status: 'fetching' });
    const seq = ++fetchSeqRef.current;
    // 并行拉取**每个已配置 runtime** 的列模型端点:双 runtime 预设两端各自发现,
    // 返回结果按「实际返回它的端点」归属合并——某模型两端都返回则归属两端。
    const agents = Object.keys(preset.runtimes) as AgentKind[];
    const results = await Promise.all(
      agents.map(async (agent) => {
        const rt = preset.runtimes[agent];
        if (!rt) return { agent, ok: false, models: [] as { id: string; name: string }[] };
        try {
          const r = await window.electronAPI.maker.fetchProviderModels({
            agent,
            baseUrl: rt.baseUrl,
            modelsUrl: rt.modelsUrl ?? null,
            apiKey: apiKey.trim() || null,
            ...(rt.headers ? { headers: rt.headers } : {}),
          });
          return { agent, ok: !!(r.ok && r.models), models: r.models ?? [] };
        } catch {
          return { agent, ok: false, models: [] as { id: string; name: string }[] };
        }
      }),
    );
    // 过期响应丢弃:用户已返回 / 换选了其它供应商,旧结果不得合入当前清单。
    if (seq !== fetchSeqRef.current) return;
    setPicks((prev) => {
      const next = new Map(prev);
      for (const { agent, models } of results) {
        for (const m of models) {
          const existing = next.get(m.id);
          if (existing) {
            if (!existing.agents.includes(agent)) {
              next.set(m.id, { ...existing, agents: [...existing.agents, agent] });
            }
          } else {
            next.set(m.id, { name: m.name, checked: false, recommended: false, agents: [agent] });
          }
        }
      }
      return next;
    });
    // 全部端点都失败才算失败(单端失败仍可按另一端 + 预设推荐完成)。
    setFetchState({ status: 'done', failed: !results.some((r) => r.ok) });
  }, [sel, apiKey]);

  // ── 完成创建(预设)────────────────────────────────────────────────────
  const handleFinish = useCallback(async () => {
    if (!sel || sel.kind !== 'preset') return;
    const preset = sel.preset;
    const selected = [...picks.entries()]
      .filter(([, v]) => v.checked)
      .map(([id, v]) => ({ id, name: v.name, agents: v.agents }));
    if (selected.length === 0) {
      toast.error(t('settings.providers.wizard.noModelSelected'));
      return;
    }
    setSaving(true);
    try {
      const existing = new Set(providers.map((p) => p.id));
      const id = uniqueCustomProviderId(
        name.trim() || presetDisplayName(preset, i18n.language),
        existing,
      );
      const runtimes: CustomProviderConfig['runtimes'] = {};
      const keys: RuntimeKeys = {};
      for (const agent of Object.keys(preset.runtimes) as AgentKind[]) {
        const rt = preset.runtimes[agent];
        if (!rt) continue;
        // 只写归属该 runtime 的勾选模型;一个模型都没选中的 runtime 整个跳过
        // (空模型 runtime 无意义,且避免把另一端的模型 id 越界写入)。
        const agentModels = selected
          .filter((m) => m.agents.includes(agent))
          .map((m) => {
            const presetModel = rt.models.find((candidate) => candidate.id === m.id);
            return {
              id: m.id,
              name: m.name,
              ...(presetModel?.contextWindow !== undefined
                ? { contextWindow: presetModel.contextWindow }
                : {}),
            };
          });
        if (agentModels.length === 0) continue;
        runtimes[agent] = {
          baseUrl: rt.baseUrl,
          ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
          models: agentModels,
          ...(rt.headers ? { headers: rt.headers } : {}),
          ...(rt.modelsUrl ? { modelsUrl: rt.modelsUrl } : {}),
        };
        const k = apiKey.trim();
        if (k) keys[agent] = k;
      }
      if (Object.keys(runtimes).length === 0) {
        toast.error(t('settings.providers.wizard.noModelSelected'));
        return;
      }
      await createCustomProvider(
        { id, name: name.trim() || presetDisplayName(preset, i18n.language), runtimes },
        keys,
      );
      toast.success(
        t('settings.providers.wizard.createdToast', {
          name: name.trim() || presetDisplayName(preset, i18n.language),
        }),
      );
      onDone(id);
    } catch {
      toast.error(t('settings.providers.wizard.createFailed'));
    } finally {
      setSaving(false);
    }
  }, [sel, picks, name, apiKey, providers, onDone, t, i18n.language]);

  // ── 步骤指示(OAuth 路径只有 2 步)─────────────────────────────────────
  const totalSteps = sel?.kind === 'preset' ? 3 : 2;
  const stepLabels = [
    t('settings.providers.wizard.stepPick'),
    t('settings.providers.wizard.stepConnect'),
    ...(totalSteps === 3 ? [t('settings.providers.wizard.stepModels')] : []),
  ];

  // 预设单 runtime 时的「仅支持 X」说明(数据驱动的静态灰,见文件头注释)。
  const presetAgents =
    sel?.kind === 'preset' ? (Object.keys(sel.preset.runtimes) as AgentKind[]) : [];
  const presetSingleAgentNote =
    sel?.kind === 'preset' && presetAgents.length === 1
      ? t('settings.providers.wizard.onlyAgentNote', { agent: AGENT_LABEL[presetAgents[0]] })
      : null;
  const oauthSingleAgentNote =
    sel?.kind === 'oauth' && sel.provider.agents.length === 1
      ? t('settings.providers.wizard.onlyAgentNote', {
          agent: AGENT_LABEL[sel.provider.agents[0]],
        })
      : null;

  const checkedCount = [...picks.values()].filter((v) => v.checked).length;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--overlay-modal)]">
      <div
        className="flex max-h-[85vh] w-[600px] flex-col overflow-hidden rounded-xl border"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-default)',
        }}
      >
        {/* 头部:标题 + 步骤指示 */}
        <div className="flex flex-col gap-3 px-6 pb-4 pt-5">
          <div className="flex items-center justify-between">
            <h3
              className="text-16 font-semibold"
              style={{ color: 'var(--settings-section-title)' }}
            >
              {sel
                ? t('settings.providers.wizard.titleWith', {
                    name:
                      sel.kind === 'oauth'
                        ? sel.provider.name
                        : presetDisplayName(sel.preset, i18n.language),
                  })
                : t('settings.providers.wizard.title')}
            </h3>
            <button
              type="button"
              onClick={handleClose}
              aria-label={t('settings.providers.wizard.closeAria')}
              className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex items-center gap-4">
            {stepLabels.map((label, i) => {
              const n = i + 1;
              const isCur = n === step || (n === totalSteps && step > totalSteps);
              const isDone = n < step;
              return (
                <span
                  key={label}
                  className="flex items-center gap-1.5 text-12"
                  style={{
                    color: isCur ? 'var(--settings-section-title)' : 'var(--text-tertiary)',
                  }}
                >
                  <span
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full border text-10 font-medium"
                    style={
                      isCur
                        ? {
                            backgroundColor: 'var(--accent-cta-bg)',
                            color: 'var(--surface-on-card)',
                            borderColor: 'var(--accent-cta-bg)',
                          }
                        : isDone
                          ? {
                              backgroundColor: 'var(--surface-chip)',
                              borderColor: 'var(--surface-chip)',
                              color: 'var(--text-secondary)',
                            }
                          : { borderColor: 'var(--border-default)' }
                    }
                  >
                    {isDone ? <Check size={10} /> : n}
                  </span>
                  <span className={cn(isCur && 'font-medium')}>{label}</span>
                </span>
              );
            })}
          </div>
        </div>

        {/* 主体 */}
        <div
          className="min-h-[320px] flex-1 overflow-y-auto border-t px-6 py-4"
          style={{ borderColor: 'var(--border-default)' }}
        >
          {step === 1 && (
            <div className="flex flex-col">
              <div
                className="flex h-9 items-center gap-2 rounded-full border px-3.5"
                style={{
                  borderColor: 'var(--border-default)',
                  backgroundColor: 'var(--surface-elevated)',
                }}
              >
                <Search size={14} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('settings.providers.wizard.searchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-13 outline-none placeholder:text-[var(--text-placeholder)]"
                  style={{ color: 'var(--settings-section-title)' }}
                />
              </div>

              {filteredOauth.length > 0 && (
                <>
                  <GroupLabel>{t('settings.providers.wizard.groupSubscription')}</GroupLabel>
                  <div className="grid grid-cols-3 gap-2">
                    {filteredOauth.map((p) => (
                      <ProviderCard
                        key={p.id}
                        icon={cardIcon({ providerId: p.id, name: p.name })}
                        name={p.name}
                        meta={t(
                          OFFICIAL_API_PRESETS[p.id]
                            ? 'settings.providers.wizard.metaOAuthOrApi'
                            : 'settings.providers.wizard.metaOAuth',
                        )}
                        onClick={() => pickOauth(p)}
                      />
                    ))}
                  </div>
                </>
              )}

              {filteredPresets.length > 0 && (
                <>
                  <GroupLabel>{t('settings.providers.wizard.groupApiKey')}</GroupLabel>
                  <div className="grid grid-cols-3 gap-2">
                    {filteredPresets.map((p) => (
                      <ProviderCard
                        key={p.id}
                        icon={cardIcon({
                          providerId: p.id,
                          name: presetDisplayName(p, i18n.language),
                        })}
                        name={presetDisplayName(p, i18n.language)}
                        meta={t('settings.providers.wizard.metaApiKey')}
                        onClick={() => pickPreset(p)}
                      />
                    ))}
                  </div>
                </>
              )}

              <GroupLabel>{t('settings.providers.wizard.groupCustom')}</GroupLabel>
              <button
                type="button"
                onClick={onOpenCustomForm}
                className="flex items-center gap-2.5 rounded-xl border border-dashed p-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
                style={{ borderColor: 'var(--settings-btn-secondary-border)' }}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{
                    border: '1px solid var(--settings-integration-avatar-border)',
                    color: 'var(--settings-section-desc)',
                  }}
                >
                  <Plus size={13} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className="text-13 font-medium"
                    style={{ color: 'var(--settings-section-title)' }}
                  >
                    {t('settings.providers.wizard.customTitle')}
                  </span>
                  <span className="truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.providers.wizard.customMeta')}
                  </span>
                </span>
              </button>

              <p className="pt-4 text-11 leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.providers.wizard.pickHint')}
              </p>
            </div>
          )}

          {step === 2 && sel?.kind === 'oauth' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: 'var(--settings-integration-avatar-bg)',
                    border: '1px solid var(--settings-integration-avatar-border)',
                    color: 'var(--settings-integration-avatar-icon)',
                  }}
                >
                  {cardIcon({ providerId: sel.provider.id, name: sel.provider.name })}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span
                    className="text-14 font-medium"
                    style={{ color: 'var(--settings-section-title)' }}
                  >
                    {sel.provider.name}
                  </span>
                  <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.providers.wizard.oauthDesc')}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* 等待授权中按钮变「取消」(与详情头对称),不禁用——浏览器流挂起时用户必须能中止重试。 */}
                <button
                  type="button"
                  onClick={() => {
                    if (loggingIn) cancelAuthorize();
                    else void handleAuthorize();
                  }}
                  className="flex h-9 items-center justify-center gap-2 rounded-full border px-5 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                  style={{
                    backgroundColor: 'var(--settings-btn-secondary-bg)',
                    borderColor: 'var(--settings-btn-secondary-border)',
                    color: 'var(--settings-btn-secondary-text)',
                  }}
                >
                  {loggingIn && <Spinner size={13} />}
                  {t(
                    loggingIn
                      ? 'settings.providers.button.cancel'
                      : 'settings.providers.button.authorize',
                  )}
                </button>
                {/* 替代路径:API 用户没有订阅,OAuth 对其是错误路径——切到该渠道的
                    官方 API 预设表单(填 key),与从目录选预设完全同一条流水线。
                    与「授权」并排的次级描边按钮(White Pill):小灰字形态用户根本
                    注意不到(2026-07-24 实测)。 */}
                {OFFICIAL_API_PRESETS[sel.provider.id] && (
                  <button
                    type="button"
                    onClick={() => pickPreset(OFFICIAL_API_PRESETS[sel.provider.id])}
                    disabled={loggingIn}
                    className="flex h-9 items-center justify-center rounded-full border px-5 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
                    style={{
                      backgroundColor: 'transparent',
                      borderColor: 'var(--settings-btn-secondary-border)',
                      color: 'var(--settings-btn-secondary-text)',
                    }}
                  >
                    {t('settings.providers.wizard.useApiKey')}
                  </button>
                )}
              </div>
              {oauthSingleAgentNote && <InfoLine text={oauthSingleAgentNote} />}
            </div>
          )}

          {step === 2 && sel?.kind === 'preset' && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('settings.providers.wizard.nameLabel')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 rounded-full border px-4 text-13 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                  style={{
                    borderColor: 'var(--border-default)',
                    backgroundColor: 'var(--surface-elevated)',
                    color: 'var(--settings-section-title)',
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('settings.providers.custom.fields.apiKey')}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  className="h-9 rounded-full border px-4 font-mono text-13 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                  style={{
                    borderColor: 'var(--border-default)',
                    backgroundColor: 'var(--surface-elevated)',
                    color: 'var(--settings-section-title)',
                  }}
                />
              </div>
              {/* baseUrl 由预设携带,只读展示(要改走保存后的编辑表单)。
                  codex + openai-chat 上游标注「Cindy 桥接」,让用户明确该通道是协议转换而非原生。 */}
              <div className="flex flex-col gap-1">
                {presetAgents.map((agent) => {
                  const rt = sel.preset.runtimes[agent];
                  const bridged = agent === 'codex' && rt?.wireProtocol === 'openai-chat';
                  return (
                    <span
                      key={agent}
                      className="truncate text-12"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {AGENT_LABEL[agent]} · {rt?.baseUrl}
                      {bridged ? ` · ${t('settings.providers.wizard.bridgedNote')}` : ''}
                    </span>
                  );
                })}
              </div>
              {presetSingleAgentNote && <InfoLine text={presetSingleAgentNote} />}
              {sel.preset.docsUrl && (
                <a
                  href={sel.preset.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-12 underline-offset-2 hover:underline"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {t('settings.providers.wizard.docsLink')}
                </a>
              )}
            </div>
          )}

          {step === 3 && sel?.kind === 'preset' && (
            <div className="flex flex-col gap-3">
              {fetchState.status === 'fetching' ? (
                <div
                  className="flex items-center justify-center gap-2 py-16 text-13"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Spinner size={14} />
                  {t('settings.providers.wizard.fetching')}
                </div>
              ) : (
                <>
                  {fetchState.status === 'done' && fetchState.failed && (
                    <InfoLine text={t('settings.providers.wizard.fetchFailed')} />
                  )}
                  <div
                    className="flex flex-col overflow-hidden rounded-xl border"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    {[...picks.entries()].map(([id, v], i) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() =>
                          setPicks((prev) => {
                            const next = new Map(prev);
                            const cur = next.get(id);
                            if (cur) next.set(id, { ...cur, checked: !cur.checked });
                            return next;
                          })
                        }
                        className={cn(
                          'flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]',
                          i > 0 && 'border-t',
                        )}
                        style={{ borderColor: 'var(--border-default)' }}
                      >
                        <span
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                          style={
                            v.checked
                              ? {
                                  backgroundColor: 'var(--accent-cta-bg)',
                                  borderColor: 'var(--accent-cta-bg)',
                                  color: 'var(--surface-on-card)',
                                }
                              : { borderColor: 'var(--text-tertiary)' }
                          }
                        >
                          {v.checked && <Check size={11} strokeWidth={3} />}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-13"
                          style={{ color: 'var(--settings-section-title)' }}
                        >
                          {v.name}
                        </span>
                        {/* 双 runtime 预设里单端归属的模型,标注能力事实(与管理页同措辞)。 */}
                        {presetAgents.length > 1 && v.agents.length === 1 && (
                          <span
                            className="shrink-0 text-12"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {t('settings.providers.models.capabilityNote', {
                              agent:
                                AGENT_LABEL[
                                  v.agents[0] === 'claude-code' ? 'codex' : 'claude-code'
                                ],
                            })}
                          </span>
                        )}
                        {v.recommended && (
                          <span
                            className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium"
                            style={{
                              backgroundColor: 'var(--surface-chip)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {t('settings.providers.wizard.recommended')}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <p className="text-11 leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.providers.wizard.modelsHint')}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div
          className="flex items-center justify-between border-t px-6 py-3.5"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <button
            type="button"
            onClick={() => {
              if (step === 3) setStep(2);
              else if (step === 2) {
                // 返回目录前中止等待中的授权,不留挂起的 login runner;
                // 同时推进拉取序号,让在途的旧模型请求结果作废。
                if (loggingIn) cancelAuthorize();
                fetchSeqRef.current += 1;
                setSel(null);
                setStep(1);
              }
            }}
            className={cn(
              'text-13 font-medium transition-opacity hover:opacity-80',
              step === 1 && 'invisible',
            )}
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('settings.providers.wizard.back')}
          </button>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleClose}
              className="flex h-9 items-center justify-center rounded-full border px-5 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              {t('settings.providers.wizard.cancel')}
            </button>
            {sel?.kind === 'preset' && step === 2 && (
              <button
                type="button"
                onClick={() => void startFetch()}
                disabled={apiKey.trim().length === 0}
                className={cn(
                  'flex h-9 items-center justify-center rounded-full px-5 text-13 font-medium transition-opacity',
                  apiKey.trim().length === 0 ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90',
                )}
                style={{ backgroundColor: 'var(--accent-cta-bg)', color: 'var(--surface-on-card)' }}
              >
                {t('settings.providers.wizard.next')}
              </button>
            )}
            {sel?.kind === 'preset' && step === 3 && (
              <button
                type="button"
                onClick={() => void handleFinish()}
                disabled={saving || fetchState.status === 'fetching' || checkedCount === 0}
                className={cn(
                  'flex h-9 items-center justify-center gap-2 rounded-full px-5 text-13 font-medium transition-opacity',
                  saving || fetchState.status === 'fetching' || checkedCount === 0
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:opacity-90',
                )}
                style={{ backgroundColor: 'var(--accent-cta-bg)', color: 'var(--surface-on-card)' }}
              >
                {saving && <Spinner size={13} />}
                {t('settings.providers.wizard.finish')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
