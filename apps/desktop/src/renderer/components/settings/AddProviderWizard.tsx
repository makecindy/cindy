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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Info, Plus, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { createCustomProvider, type RuntimeKeys } from '@/lib/customProviders';
import { PROVIDER_SECRET_IDS } from '../../../shared/providerSecrets';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { configuredPresetAgents } from '../../../shared/piRuntimeInitialization';
import { uniqueCustomProviderId } from '@/lib/customProviderId';
import {
  isLocalRuntimeBetaProviderId,
  LOCAL_ADVANCED_PRESET_IDS,
  LOCAL_CONNECT_PRESET_IDS,
  MANAGED_LMSTUDIO_PROVIDER_ID,
  MANAGED_OLLAMA_PROVIDER_ID,
} from '../../../shared/localModelRuntime';
import { extractIpcError } from '@/utils/ipcError';
import { pickWizardRecommend, type WizardRecommend } from './wizardRecommend';
import { localCliDisplayName, type LocalCliDetection } from '../../../shared/localCliDetect';
import { providerMonogram } from '@/lib/providerModels';
import { isChatGptConnectionConnected, useCodexAuth } from '@/hooks/useCodexAuth';
import { useProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { LocalOllamaInstall, offersManagedOllamaInstall } from './LocalOllamaInstall';
import { OAuthDeviceCodeCard } from './OAuthDeviceCodeCard';
import { SettingsTextInput } from './SettingsTextInput';

import {
  isLoopbackProviderUrl,
  isProviderRequestPath,
  presetDisplayName,
  sortPresetsForRegion,
} from '@cindy/model-providers';
import type {
  AgentKind,
  CustomProviderConfig,
  ProviderModelDiscoverySource,
  ProviderModelRouteConfig,
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
  | { kind: 'oauth'; provider: ProviderView }
  | { kind: 'preset'; preset: ProviderPreset }
  /** 内置 API-key 供应商(如 Gemini 图像来源,2026-07):保存 key 即连接,无自定义供应商落库。 */
  | { kind: 'builtinApiKey'; provider: ProviderView }
  | { kind: 'ollama-onboarding' };

type PresetBaseUrls = Partial<Record<AgentKind, string>>;

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

function presetRuntimeBaseUrl(
  preset: ProviderPreset,
  agent: AgentKind,
  edited: PresetBaseUrls,
): string {
  const runtime = preset.runtimes[agent];
  if (!runtime) return '';
  return runtime.baseUrlEditable ? (edited[agent] ?? runtime.baseUrl).trim() : runtime.baseUrl;
}

function isValidEditablePresetBaseUrl(value: string): boolean {
  return parseSafePresetHttpUrl(value) !== null;
}

function parseSafePresetHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      return null;
    return url;
  } catch {
    return null;
  }
}

function isAllowedDiscoveryWireProtocol(
  agent: AgentKind,
  value: unknown,
): value is ProviderModelRouteConfig['wireProtocol'] {
  const supported =
    value === 'anthropic-messages' || value === 'openai-responses' || value === 'openai-chat';
  return supported && (agent !== 'claude-code' || value === 'anthropic-messages');
}

function isDiscoverySourceValidForRuntime(
  agent: AgentKind,
  runtimeBaseUrl: string,
  source: ProviderModelDiscoverySource,
): boolean {
  const runtimeUrl = parseSafePresetHttpUrl(runtimeBaseUrl);
  const sourceUrl = parseSafePresetHttpUrl(source.baseUrl);
  if (
    !runtimeUrl ||
    !sourceUrl ||
    sourceUrl.origin !== runtimeUrl.origin ||
    !isAllowedDiscoveryWireProtocol(agent, source.wireProtocol)
  )
    return false;
  if (source.modelsUrl !== undefined) {
    const modelsUrl = parseSafePresetHttpUrl(source.modelsUrl);
    if (!modelsUrl || modelsUrl.origin !== sourceUrl.origin) return false;
  }
  return source.requestPath === undefined || isProviderRequestPath(source.requestPath);
}

/**
 * bespoke OAuth 渠道的官方 API 预设——授权步「改用 API Key 接入」的替代路径
 * (API 用户没有订阅,OAuth 授权对其是错误路径)。
 *
 * 不能复用 OAuth routing 的 upstream:那是订阅专用端点(openai 是 chatgpt
 * backend)。此处声明官方 API 端点,模型清单以 Step 3 列模型接口实拉为准
 * (缺省由 baseUrl 推导 …/v1/models,见 provider-model-fetch);同时内置少量
 * 推荐模型兜底——拉取因网络/限流失败时降级为「仅推荐模型」仍可完成创建,
 * 不把用户堵死(与目录预设同语义;Greptile P1 反馈 2026-07-24)。
 * 每个 runtime 都独立声明 wire protocol：Anthropic API 同时提供 Claude Code 的
 * Messages 与 Codex 桥接所需的 Messages 端点；openai/xai 声明 Codex 与 Pi 原生协议
 * runtime(两家无 Anthropic 兼容端点),表单会自动展示实际支持的 runtime。
 */
const ANTHROPIC_API_MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000 },
];
const OPENAI_API_MODELS = [
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
];
const XAI_API_MODELS = [
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500_000 },
  { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 1_000_000 },
];

export const OFFICIAL_API_PRESETS: Record<string, ProviderPreset> = {
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
        models: ANTHROPIC_API_MODELS,
      },
      // Codex 通过 Responses → Anthropic Messages 本地桥接访问同一官方 API。
      // 这不是 Claude.ai OAuth 路由：API key 由该 runtime 独立存储，出站只使用
      // x-api-key，Codex 自带的 OpenAI Authorization 永不透传到 Anthropic。
      codex: {
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: ANTHROPIC_API_MODELS,
      },
      pi: {
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: ANTHROPIC_API_MODELS,
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
        models: OPENAI_API_MODELS,
      },
      pi: {
        baseUrl: 'https://api.openai.com/v1',
        wireProtocol: 'openai-responses',
        models: OPENAI_API_MODELS,
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
        // contextWindow 必须与目录一致:拉取失败时 handleFinish 只读预设窗口,
        // 缺省会落 toCatalogModel 的 200k 默认。
        models: XAI_API_MODELS,
      },
      pi: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-chat',
        models: XAI_API_MODELS,
      },
    },
  },
};

/** 供应商卡片图标。 */
function cardIcon(sel: { providerId?: string; name: string }): React.ReactNode {
  if (sel.providerId && hasProviderLogo(sel.providerId)) {
    return <ProviderLogoMark providerId={sel.providerId} size={15} />;
  }
  return <span className="text-12 font-medium leading-none">{providerMonogram(sel.name)}</span>;
}

/**
 * 目录单行(2026-07 定稿:第 1 步由三列卡片宫格改为单列列表)——名称在左、
 * 鉴权方式靠右;行宽给足后不再需要截断测量 + Tip 组合。
 */
function ProviderRow({
  icon,
  name,
  meta,
  beta,
  onClick,
}: {
  icon: React.ReactNode;
  name: string;
  meta: string;
  beta?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        {icon}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-13 font-medium"
        style={{ color: 'var(--settings-section-title)' }}
      >
        {name}
      </span>
      {beta && (
        <span className="shrink-0 rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2 py-[1px] text-10 font-medium uppercase leading-[1.5] tracking-wide text-[var(--text-secondary)]">
          {t('settings.providers.local.beta')}
        </span>
      )}
      {/* meta 可收缩截断:en 等长文案在窄弹窗下不得把名称挤出(PR #1102 review)。 */}
      <span className="min-w-0 truncate text-11" style={{ color: 'var(--text-tertiary)' }}>
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
      className="block px-2 pb-1.5 pt-3 text-11 font-medium uppercase"
      style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
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
  const [sel, setSel] = useState<Selection | null>(() => {
    if (!entryProvider) return null;
    return entryProvider.auth?.method === 'apiKey'
      ? { kind: 'builtinApiKey', provider: entryProvider }
      : { kind: 'oauth', provider: entryProvider };
  });
  // 预设表单态
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [presetBaseUrls, setPresetBaseUrls] = useState<PresetBaseUrls>({});
  const [saving, setSaving] = useState(false);
  const [ollamaCanInstall, setOllamaCanInstall] = useState(() =>
    offersManagedOllamaInstall(window.electronAPI.platform),
  );
  const [loggingIn, setLoggingIn] = useState(false);
  const genericOAuthProviderId =
    sel?.kind === 'oauth' && sel.provider.auth.oauth ? sel.provider.id : null;
  const genericDeviceFlow =
    sel?.kind === 'oauth' && sel.provider.auth.oauth?.flow === 'device-code';
  const {
    deviceCode: genericDeviceCode,
    clearDeviceCode: clearGenericDeviceCode,
    beginOwnedLogin: beginGenericOwnedLogin,
    cancelOwnedLogin: cancelGenericOwnedLogin,
  } = useProviderOAuthDeviceCode(genericOAuthProviderId, {
    observeProgress: genericDeviceFlow,
  });
  // Step 3 拉取态
  const [step, setStep] = useState<1 | 2 | 3>(entryProvider ? 2 : 1);
  const [fetchState, setFetchState] = useState<
    | { status: 'idle' }
    | { status: 'fetching' }
    | { status: 'done'; failed: boolean; empty: boolean }
  >({ status: 'idle' });
  const [manualModelIds, setManualModelIds] = useState<Partial<Record<AgentKind, string>>>({});
  /**
   * 勾选清单:id → { name, checked, recommended, agents }。Map 保序(推荐在前,拉取新增在后)。
   * agents = 该模型归属的 runtime:预设推荐模型归属「预设里列出它的那些 runtime」;拉取新增
   * 归属「实际返回它的那个端点的 runtime」——完成创建时按归属分发,**不**把统一列表复制进
   * 每个 runtime(双 runtime 预设两端模型集可以不同,cc-only 模型不能写进 codex,反之亦然)。
   */
  const [localProbe, setLocalProbe] = useState<{
    ready: boolean;
    appInstalled: boolean;
    modelCount: number;
    memoryGb: number;
    detectedLocalPresetIds: string[];
  }>({
    ready: false,
    appInstalled: false,
    modelCount: 0,
    memoryGb: 0,
    detectedLocalPresetIds: [],
  });
  const [cliDetections, setCliDetections] = useState<LocalCliDetection[]>([]);
  const [picks, setPicks] = useState<
    Map<
      string,
      {
        name: string;
        checked: boolean;
        recommended: boolean;
        agents: AgentKind[];
        /** 列模型端点上报的上下文窗口,**按 agent 分槽**(同一 id 双端可不同,如
         *  cc=1M / codex=272K);完成创建时按所属 runtime 取值,预设值优先、本值兜底。 */
        contextWindows?: Partial<Record<AgentKind, number>>;
        /** 附加目录发现出的模型级路由；主 runtime 目录发现的模型保持缺省路由。 */
        routes?: Partial<Record<AgentKind, ProviderModelRouteConfig>>;
      }
    >
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

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .localModelList()
      .then((result) => {
        if (cancelled) return;
        setLocalProbe({
          ready: true,
          appInstalled: result.status.appInstalled,
          modelCount: result.models.length,
          memoryGb: result.memoryGb ?? 0,
          detectedLocalPresetIds: result.detectedLocalPresetIds ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setLocalProbe((current) => ({ ...current, ready: true }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .scanLocalCli()
      .then((result) => {
        if (!cancelled) setCliDetections(result.detections);
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
  // 内置 API-key 渠道(auth.method 'apiKey' 的 builtin 条目,今天只有 gemini 图像来源):
  // 已连接的不再进向导;声明了媒体清单才展示(纯占位条目没有可配置的能力面)。
  const builtinApiKeyChoices = useMemo(
    () =>
      providers.filter(
        (p) =>
          p.source === 'builtin' &&
          p.auth.method === 'apiKey' &&
          !p.connected &&
          ((p.imageModels?.length ?? 0) > 0 || (p.videoModels?.length ?? 0) > 0),
      ),
    [providers],
  );
  const sortedPresets = useMemo(
    () => sortPresetsForRegion(presets, CURRENT_CINDY_REGION),
    [presets],
  );
  const q = query.trim().toLowerCase();
  const filteredOauth = q
    ? oauthChoices.filter((p) => p.name.toLowerCase().includes(q))
    : oauthChoices;
  const isLocalPresetId = (id: string) =>
    (LOCAL_CONNECT_PRESET_IDS as readonly string[]).includes(id) ||
    (LOCAL_ADVANCED_PRESET_IDS as readonly string[]).includes(id);
  const filteredPresets = (
    q
      ? sortedPresets.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.nameEn?.toLowerCase().includes(q) ?? false) ||
            (p.nameZhTW?.toLowerCase().includes(q) ?? false),
        )
      : sortedPresets
  ).filter((p) => !isLocalPresetId(p.id));
  const localConnectPresets = sortedPresets.filter((p) =>
    (LOCAL_CONNECT_PRESET_IDS as readonly string[]).includes(p.id),
  );
  const localAdvancedPresets = sortedPresets.filter((p) =>
    (LOCAL_ADVANCED_PRESET_IDS as readonly string[]).includes(p.id),
  );
  const filteredLocalConnect = q
    ? localConnectPresets.filter((p) => p.name.toLowerCase().includes(q))
    : localConnectPresets;
  const filteredLocalAdvanced = q
    ? localAdvancedPresets.filter((p) => p.name.toLowerCase().includes(q))
    : localAdvancedPresets;
  const filteredLocalPresets = [...filteredLocalConnect, ...filteredLocalAdvanced];

  const ollamaAlreadyAdded = providers.some((p) => p.id === MANAGED_OLLAMA_PROVIDER_ID);
  const oauthChoiceIds = new Set(oauthChoices.map((p) => p.id));
  const connectedProviderIds = providers.filter((p) => p.connected).map((p) => p.id);
  const cliCandidates = cliDetections
    .filter((detection) => detection.installed && oauthChoiceIds.has(detection.providerId))
    .map((detection) => ({
      providerId: detection.providerId,
      loggedIn: detection.loggedIn,
      cli: detection.cli,
    }));
  const recommendations = localProbe.ready
    ? pickWizardRecommend({
        ollamaAlreadyAdded,
        ollamaAppInstalled: localProbe.appInstalled,
        installedLocalModelCount: localProbe.modelCount,
        memoryGb: localProbe.memoryGb,
        connectedProviderIds,
        cliCandidates,
        fallbackOauthProviderId: oauthChoices[0]?.id ?? null,
      })
    : [];
  const recommendedOauthIds = new Set(
    recommendations
      .filter((item): item is Extract<WizardRecommend, { kind: 'oauth' }> => item.kind === 'oauth')
      .map((item) => item.providerId),
  );
  const recommendsOllama = recommendations.some((item) => item.kind === 'ollama');
  const ollamaMatchesQuery =
    !q ||
    t('settings.providers.local.title').toLowerCase().includes(q) ||
    'ollama'.includes(q);
  const showOllamaInList =
    !ollamaAlreadyAdded &&
    ollamaMatchesQuery &&
    (Boolean(q) || (localProbe.ready && !recommendsOllama));
  const listedOauth = q
    ? filteredOauth
    : filteredOauth.filter((p) => !recommendedOauthIds.has(p.id));
  const detectedLocalPresets = filteredLocalPresets.filter((preset) =>
    localProbe.detectedLocalPresetIds.includes(preset.id),
  );
  const undetectedLocalPresets = filteredLocalPresets.filter((preset) => {
    if (localProbe.detectedLocalPresetIds.includes(preset.id)) return false;
    if (preset.id === 'lmstudio' && providers.some((p) => p.id === MANAGED_LMSTUDIO_PROVIDER_ID)) {
      return false;
    }
    return true;
  });
  const listedLocalPresets = q ? filteredLocalPresets : undetectedLocalPresets;

  /**
   * 拉取请求序号:防过期响应(与 CustomProviderDialog 的 fetchRequestSignature 同模式)。
   * 换选供应商 / 返回目录都会推进序号,慢返回的旧请求结果直接丢弃,不污染新预设的勾选清单。
   */
  const fetchSeqRef = useRef(0);

  const pickOauth = useCallback((provider: ProviderView) => {
    fetchSeqRef.current += 1;
    setManualModelIds({});
    setSel({ kind: 'oauth', provider });
    setStep(2);
  }, []);
  const pickBuiltinApiKey = useCallback((provider: ProviderView) => {
    fetchSeqRef.current += 1;
    setManualModelIds({});
    setSel({ kind: 'builtinApiKey', provider });
    setApiKey('');
    setStep(2);
  }, []);
  const pickPreset = useCallback(
    (preset: ProviderPreset) => {
      if (
        preset.id === 'lmstudio' &&
        providers.some((p) => p.id === MANAGED_LMSTUDIO_PROVIDER_ID)
      ) {
        onDone(MANAGED_LMSTUDIO_PROVIDER_ID);
        return;
      }
      fetchSeqRef.current += 1;
      setManualModelIds({});
      setSel({ kind: 'preset', preset });
      setName(presetDisplayName(preset, i18n.language));
      setApiKey('');
      setPresetBaseUrls(
        Object.fromEntries(
          configuredPresetAgents(preset).map((agent) => [
            agent,
            preset.runtimes[agent]?.baseUrl ?? '',
          ]),
        ) as PresetBaseUrls,
      );
      setStep(2);
    },
    [i18n.language, onDone, providers],
  );

  const connectOllama = useCallback(async () => {
    setSaving(true);
    try {
      let status = await window.electronAPI.maker.localModelStatus();
      if (status.kind === 'stopped' && status.appInstalled) {
        status = await window.electronAPI.maker.localModelStart();
      }
      if (status.kind === 'absent') {
        setOllamaCanInstall(
          offersManagedOllamaInstall(window.electronAPI.platform, status.canInstallRuntime),
        );
        setSel({ kind: 'ollama-onboarding' });
        setStep(2);
        return;
      }
      if (status.kind === 'port-conflict') {
        toast.error(t('settings.providers.local.conflict'));
        return;
      }
      if (status.kind !== 'ready') {
        toast.error(t(`settings.providers.local.status.${status.kind}`));
        return;
      }
      await window.electronAPI.maker.localModelEnsure();
      onDone(MANAGED_OLLAMA_PROVIDER_ID);
    } catch (error) {
      const code = extractIpcError(error)?.code;
      toast.error(
        code === 'PRECONDITION_FAILED'
          ? t('settings.providers.local.notReady')
          : t('settings.providers.local.connectFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, [onDone, t]);

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
  const handleAuthorize = useCallback(
    async (mode: 'browser' | 'device-code' = 'browser') => {
      if (!sel || sel.kind !== 'oauth') return;
      const id = sel.provider.id;
      clearGenericDeviceCode();
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
          if (codexAuth.state.oauthWritesBlocked) {
            toast.error(t('chatgptAuthRecovery.devWriteBlocked'));
            return;
          }
          openaiLoginStartedRef.current = true;
          const outcome = await codexAuth.triggerLogin(mode);
          ok = outcome === 'authenticated';
          if (outcome === 'cancelled') return;
        } else if (id === 'xai') {
          const r = await window.electronAPI.maker.xaiOAuthLogin();
          ok = r.ok;
          if (!r.ok && r.reason === 'login_cancelled') return;
        } else {
          const ownedLogin = beginGenericOwnedLogin();
          try {
            const r = await window.electronAPI.maker.providerOAuthLogin(id, {
              ownerId: ownedLogin.ownerId,
            });
            ok = r.ok;
            if (!r.ok && r.reason === 'login_cancelled') return;
          } finally {
            ownedLogin.finish();
          }
        }
        if (ok) {
          toast.success(
            t('settings.providers.wizard.authorizedToast', { name: sel.provider.name }),
          );
          onDone(id);
        } else {
          toast.error(t('settings.providers.wizard.authorizeFailed', { name: sel.provider.name }));
        }
      } catch {
        toast.error(t('settings.providers.wizard.authorizeFailed', { name: sel.provider.name }));
      } finally {
        setLoggingIn(false);
      }
    },
    [sel, clearGenericDeviceCode, beginGenericOwnedLogin, codexAuth, onDone, t],
  );

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
    else cancelGenericOwnedLogin();
    clearGenericDeviceCode();
    setLoggingIn(false);
  }, [sel, clearGenericDeviceCode, cancelGenericOwnedLogin, codexAuth]);

  /** 关闭向导:授权等待中先取消再关,不留挂起的 login runner。 */
  const handleClose = useCallback(() => {
    if (loggingIn) cancelAuthorize();
    onClose();
  }, [loggingIn, cancelAuthorize, onClose]);

  // 遮罩关闭的防误触:从输入框按下、拖到弹窗外松开时,浏览器把合成 click 派发到
  // 按下点与松开点的最近公共祖先(= 遮罩),target === currentTarget 成立但用户
  // 并无关闭意图。记录按下是否始于遮罩,按下与松开都在遮罩上才关闭
  // (PR #1102 review 第七轮)。
  const overlayMouseDownOnSelfRef = useRef(false);

  // Esc 关闭(DESIGN.md §4:弹窗关闭 = 取消按钮 / Esc / 点遮罩;本弹窗未用 Radix,需自行监听)。
  // CJK 输入法组合期间的 Esc 是「取消候选词」,不是关闭命令(isComposing / 遗留
  // keyCode 229),与仓库其他 CJK 输入场景同口径(PR #1102 review 第六轮)。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

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
    const agents = configuredPresetAgents(preset);
    const editableBaseUrlsValid = agents.every((agent) => {
      const rt = preset.runtimes[agent];
      return (
        !rt?.baseUrlEditable ||
        isValidEditablePresetBaseUrl(presetRuntimeBaseUrl(preset, agent, presetBaseUrls))
      );
    });
    if (!editableBaseUrlsValid) return;
    // 预设推荐模型先入清单(预勾);归属 = 预设里列出该模型的全部 runtime。
    const initial = new Map<
      string,
      {
        name: string;
        checked: boolean;
        recommended: boolean;
        agents: AgentKind[];
        contextWindows?: Partial<Record<AgentKind, number>>;
        routes?: Partial<Record<AgentKind, ProviderModelRouteConfig>>;
      }
    >();
    for (const agent of agents) {
      for (const m of preset.runtimes[agent]?.models ?? []) {
        const existing = initial.get(m.id);
        if (existing) {
          if (!existing.agents.includes(agent)) existing.agents.push(agent);
          if (m.route && !existing.routes?.[agent]) {
            existing.routes = { ...existing.routes, [agent]: m.route };
          }
        } else {
          initial.set(m.id, {
            name: m.name,
            checked: true,
            recommended: true,
            agents: [agent],
            ...(m.route ? { routes: { [agent]: m.route } } : {}),
          });
        }
      }
    }
    setPicks(initial);
    setStep(3);
    setFetchState({ status: 'fetching' });
    const seq = ++fetchSeqRef.current;
    // 并行拉取**每个已配置 runtime** 的列模型端点:双 runtime 预设两端各自发现,
    // 返回结果按「实际返回它的端点」归属合并——某模型两端都返回则归属两端。
    // 同一个 modelsUrl 被多个 runtime 共用、但预设模型集合不同，说明该端点返回的是
    // 跨协议总目录（OpenCode Go 即如此），响应本身无法判定模型属于 Messages 还是 Chat。
    // 这类端点只能用于确认预设已有模型，不能扩大其 agent 归属或加入无法分类的新模型。
    const discoveryAgentsByUrl = new Map<string, AgentKind[]>();
    for (const agent of agents) {
      const modelsUrl = preset.runtimes[agent]?.modelsUrl;
      if (!modelsUrl) continue;
      discoveryAgentsByUrl.set(modelsUrl, [...(discoveryAgentsByUrl.get(modelsUrl) ?? []), agent]);
    }
    const splitDiscoveryUrls = new Set(
      [...discoveryAgentsByUrl.entries()]
        .filter(([, owners]) => {
          if (owners.length < 2) return false;
          const modelSets = new Set(
            owners.map((agent) =>
              (preset.runtimes[agent]?.models ?? [])
                .map((model) => model.id)
                .sort()
                .join('\u0000'),
            ),
          );
          return modelSets.size > 1;
        })
        .map(([modelsUrl]) => modelsUrl),
    );
    const results = await Promise.all(
      agents.flatMap((agent) => {
        const rt = preset.runtimes[agent];
        if (!rt) {
          return [];
        }
        const runtimeBaseUrl = presetRuntimeBaseUrl(preset, agent, presetBaseUrls);
        const sources: {
          baseUrl: string;
          modelsUrl: string | null;
          wireProtocol?: ProviderModelRouteConfig['wireProtocol'];
          route?: ProviderModelRouteConfig;
        }[] = [
          {
            baseUrl: runtimeBaseUrl,
            modelsUrl: rt.modelsUrl ?? null,
            ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
          },
          ...(rt.modelDiscovery ?? [])
            .filter((source) => isDiscoverySourceValidForRuntime(agent, runtimeBaseUrl, source))
            .map((source) => ({
              baseUrl: source.baseUrl,
              modelsUrl: source.modelsUrl ?? null,
              wireProtocol: source.wireProtocol,
              route: {
                baseUrl: source.baseUrl,
                wireProtocol: source.wireProtocol,
                ...(source.requestPath ? { requestPath: source.requestPath } : {}),
              },
            })),
        ];
        return sources.map(async (source) => {
          try {
            const r = await window.electronAPI.maker.fetchProviderModels({
              agent,
              baseUrl: source.baseUrl,
              authMethod: preset.authMethod ?? 'apiKey',
              modelsUrl: source.modelsUrl,
              apiKey: apiKey.trim() || null,
              ...(source.wireProtocol ? { wireProtocol: source.wireProtocol } : {}),
              ...(rt.headers ? { headers: rt.headers } : {}),
            });
            return {
              agent,
              modelsUrl: source.modelsUrl,
              route: source.route,
              ok: !!(r.ok && r.models),
              models: r.models ?? [],
            };
          } catch {
            return {
              agent,
              modelsUrl: source.modelsUrl,
              route: source.route,
              ok: false,
              models: [] as { id: string; name: string; contextWindow?: number }[],
            };
          }
        });
      }),
    );
    // 过期响应丢弃:用户已返回 / 换选了其它供应商,旧结果不得合入当前清单。
    if (seq !== fetchSeqRef.current) return;
    const defaultDiscoveredModels = new Set(
      results
        .filter((result) => !result.route)
        .flatMap((result) => result.models.map((model) => `${result.agent}\u0000${model.id}`)),
    );
    setPicks((prev) => {
      const next = new Map(prev);
      for (const { agent, models, modelsUrl, route } of results) {
        const preservePresetOwnership = !!modelsUrl && splitDiscoveryUrls.has(modelsUrl);
        for (const m of models) {
          const existing = next.get(m.id);
          if (existing) {
            const mergedAgents =
              !preservePresetOwnership && !existing.agents.includes(agent)
                ? [...existing.agents, agent]
                : existing.agents;
            // 端点上报的窗口按 agent 分槽、只补该槽的空(同一 id 双端窗口可以不同,
            // 不能共享一个值;预设推荐模型的窗口在完成创建时以预设为准,这里补的是
            // 「预设没写窗口」的兜底)。
            const backfillWindow =
              existing.contextWindows?.[agent] === undefined && m.contextWindow !== undefined;
            const presetOwnsModel =
              preset.runtimes[agent]?.models.some((model) => model.id === m.id) === true;
            const discoveredRoute =
              route &&
              !presetOwnsModel &&
              !defaultDiscoveredModels.has(`${agent}\u0000${m.id}`) &&
              !existing.routes?.[agent]
                ? route
                : undefined;
            if (mergedAgents !== existing.agents || backfillWindow || discoveredRoute) {
              next.set(m.id, {
                ...existing,
                agents: mergedAgents,
                ...(backfillWindow
                  ? { contextWindows: { ...existing.contextWindows, [agent]: m.contextWindow } }
                  : {}),
                ...(discoveredRoute
                  ? { routes: { ...existing.routes, [agent]: discoveredRoute } }
                  : {}),
              });
            }
          } else if (!preservePresetOwnership) {
            next.set(m.id, {
              name: m.name,
              checked: false,
              recommended: false,
              agents: [agent],
              ...(m.contextWindow !== undefined
                ? { contextWindows: { [agent]: m.contextWindow } }
                : {}),
              ...(route ? { routes: { [agent]: route } } : {}),
            });
          }
        }
      }
      return next;
    });
    // 全部端点都失败才算失败(单端失败仍可按另一端 + 预设推荐完成)。
    setFetchState({
      status: 'done',
      failed: !results.some((r) => r.ok),
      empty: !results.some((r) => r.models.length > 0),
    });
  }, [sel, apiKey, presetBaseUrls]);

  /**
   * 零推荐模型的本机代理（例如 LiteLLM）若 `/models` 不可用或返回空清单，仍允许用户
   * 按 runtime 手填真实模型 ID。归属必须精确到当前 agent，不能把一个 ID 猜测性复制到
   * 双 runtime；同一 ID 分别加入两端时才合并归属。
   */
  const addManualModel = useCallback(
    (agent: AgentKind) => {
      if (!sel || sel.kind !== 'preset' || !sel.preset.runtimes[agent]) return;
      const id = manualModelIds[agent]?.trim() ?? '';
      if (!id) return;
      setPicks((prev) => {
        const next = new Map(prev);
        const existing = next.get(id);
        next.set(
          id,
          existing
            ? {
                ...existing,
                checked: true,
                agents: existing.agents.includes(agent)
                  ? existing.agents
                  : [...existing.agents, agent],
              }
            : {
                name: id,
                checked: true,
                recommended: false,
                agents: [agent],
              },
        );
        return next;
      });
      setManualModelIds((prev) => ({ ...prev, [agent]: '' }));
    },
    [sel, manualModelIds],
  );

  // ── 完成创建(预设)────────────────────────────────────────────────────
  /**
   * 内置 API-key 供应商(如 Gemini):保存 = 把 key 写进该供应商在册的 safeStorage 键
   * (providerSecrets SSoT),连接态(provider-service 的 builtinApiKeyConnected)与
   * 图像通道 ready 都以「key 已存」为准 —— 无自定义供应商落库、无模型拉取步。
   */
  const handleSaveBuiltinApiKey = useCallback(async () => {
    if (!sel || sel.kind !== 'builtinApiKey') return;
    const id = sel.provider.id;
    if (!(PROVIDER_SECRET_IDS as readonly string[]).includes(id)) {
      // 目录出现了未在 providerSecrets 登记的内置 API-key 供应商 = 数据/代码脱节,
      // 明确报错让问题在配置期暴露,不静默写错键。
      toast.error(t('settings.providers.wizard.authorizeFailed', { name: sel.provider.name }));
      return;
    }
    const key = apiKey.trim();
    if (!key) return;
    setSaving(true);
    try {
      // 失败经统一 IPC 错误协议抛出(throwIpcError),这里 catch 即失败。
      await window.electronAPI.builtinApiKeyStore(id, key);
      toast.success(t('settings.providers.wizard.authorizedToast', { name: sel.provider.name }));
      onDone(id);
    } catch {
      toast.error(t('settings.providers.wizard.authorizeFailed', { name: sel.provider.name }));
    } finally {
      setSaving(false);
    }
  }, [sel, apiKey, onDone, t]);

  const handleFinish = useCallback(async () => {
    if (!sel || sel.kind !== 'preset') return;
    const preset = sel.preset;
    const selected = [...picks.entries()]
      .filter(([, v]) => v.checked)
      .map(([id, v]) => ({
        id,
        name: v.name,
        agents: v.agents,
        contextWindows: v.contextWindows,
        routes: v.routes,
      }));
    if (selected.length === 0) {
      toast.error(t('settings.providers.wizard.noModelSelected'));
      return;
    }
    setSaving(true);
    try {
      const existing = new Set(providers.map((p) => p.id));
      const id =
        preset.id === 'lmstudio'
          ? MANAGED_LMSTUDIO_PROVIDER_ID
          : uniqueCustomProviderId(
              name.trim() || presetDisplayName(preset, i18n.language),
              existing,
            );
      if (preset.id === 'lmstudio' && existing.has(MANAGED_LMSTUDIO_PROVIDER_ID)) {
        onDone(MANAGED_LMSTUDIO_PROVIDER_ID);
        return;
      }
      const runtimes: CustomProviderConfig['runtimes'] = {};
      const keys: RuntimeKeys = {};
      for (const agent of configuredPresetAgents(preset)) {
        const rt = preset.runtimes[agent];
        if (!rt) continue;
        // 只写归属该 runtime 的勾选模型;一个模型都没选中的 runtime 整个跳过
        // (空模型 runtime 无意义,且避免把另一端的模型 id 越界写入)。
        const agentModels = selected
          .filter((m) => m.agents.includes(agent))
          .map((m) => {
            const presetModel = rt.models.find((candidate) => candidate.id === m.id);
            // 预设策展值优先;拉取新增模型没有预设条目,落**该 runtime 端点**上报的
            // 发现值(按 agent 分槽,双端窗口可不同),不再无窗口入库退回 200K 默认。
            const contextWindow = presetModel?.contextWindow ?? m.contextWindows?.[agent];
            return {
              id: m.id,
              name: m.name,
              ...(agent === 'pi' && presetModel?.piApi ? { piApi: presetModel.piApi } : {}),
              ...((presetModel?.route ?? m.routes?.[agent])
                ? { route: presetModel?.route ?? m.routes?.[agent] }
                : {}),
              ...(contextWindow !== undefined ? { contextWindow } : {}),
              ...(presetModel?.supportsImageInput === true ? { supportsImageInput: true } : {}),
              ...(presetModel?.reasoning === true && presetModel.reasoningEfforts?.length
                ? {
                    reasoning: true,
                    reasoningEfforts: [...presetModel.reasoningEfforts],
                    ...(presetModel.reasoningDefaultEffort
                      ? { reasoningDefaultEffort: presetModel.reasoningDefaultEffort }
                      : {}),
                  }
                : {}),
            };
          });
        if (agentModels.length === 0) continue;
        runtimes[agent] = {
          baseUrl: presetRuntimeBaseUrl(preset, agent, presetBaseUrls),
          ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
          ...(rt.requestPath ? { requestPath: rt.requestPath } : {}),
          models: agentModels,
          ...(rt.headers ? { headers: rt.headers } : {}),
          ...(rt.modelsUrl ? { modelsUrl: rt.modelsUrl } : {}),
          ...(rt.piCatalogProviderId ? { piCatalogProviderId: rt.piCatalogProviderId } : {}),
        };
        if (preset.authMethod !== 'none') {
          const k = apiKey.trim();
          if (k) keys[agent] = k;
        }
      }
      if (Object.keys(runtimes).length === 0) {
        toast.error(t('settings.providers.wizard.noModelSelected'));
        return;
      }
      await createCustomProvider(
        {
          id,
          name: name.trim() || presetDisplayName(preset, i18n.language),
          ...(preset.authMethod === 'none' ? { auth: { method: 'none' as const } } : {}),
          runtimes,
        },
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
  }, [sel, picks, name, apiKey, presetBaseUrls, providers, onDone, t, i18n.language]);

  // ── 步骤指示 ─────────────────────────────────────────────────────────
  // 目录步默认按完整路径显示三步(选择供应商 → 连接 → 选择模型);选中真的
  // 没有第 3 步的两步流程(OAuth 授权即完成、内置 API Key 保存即连接)才收成
  // 两步。未选择时就显示两步会让「选择模型」凭空消失/出现(2026-07-30 用户反馈)。
  const totalSteps = sel == null || sel.kind === 'preset' ? 3 : 2;
  const stepLabels = [
    t('settings.providers.wizard.stepPick'),
    t('settings.providers.wizard.stepConnect'),
    ...(totalSteps === 3 ? [t('settings.providers.wizard.stepModels')] : []),
  ];

  // 预设单 runtime 时的「仅支持 X」说明(数据驱动的静态灰,见文件头注释)。
  const presetAgents = sel?.kind === 'preset' ? configuredPresetAgents(sel.preset) : [];
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
  const openAiDeviceLoginPending =
    sel?.kind === 'oauth' &&
    sel.provider.id === 'openai' &&
    loggingIn &&
    codexAuth.state.kind === 'login-pending' &&
    codexAuth.state.mode === 'device-code';
  const openAiDeviceCode =
    openAiDeviceLoginPending && codexAuth.state.kind === 'login-pending'
      ? codexAuth.state.deviceCode
      : undefined;

  const checkedCount = [...picks.values()].filter((v) => v.checked).length;
  const presetHasRecommendedModels =
    sel?.kind === 'preset' &&
    presetAgents.some((agent) => (sel.preset.runtimes[agent]?.models.length ?? 0) > 0);
  const showManualModelFallback =
    sel?.kind === 'preset' &&
    fetchState.status === 'done' &&
    (fetchState.failed || fetchState.empty) &&
    !presetHasRecommendedModels;
  const presetNeedsApiKey = sel?.kind === 'preset' && sel.preset.authMethod !== 'none';
  const presetBaseUrlsValid =
    sel?.kind === 'preset' &&
    presetAgents.every((agent) => {
      const runtime = sel.preset.runtimes[agent];
      if (!runtime) return false;
      const value = presetRuntimeBaseUrl(sel.preset, agent, presetBaseUrls);
      if (sel.preset.authMethod === 'none') {
        return (
          isLoopbackProviderUrl(value) &&
          (!runtime.modelsUrl?.trim() || isLoopbackProviderUrl(runtime.modelsUrl.trim()))
        );
      }
      return !runtime.baseUrlEditable || isValidEditablePresetBaseUrl(value);
    });
  const presetCanContinue =
    sel?.kind === 'preset' &&
    presetBaseUrlsValid &&
    (!presetNeedsApiKey || apiKey.trim().length > 0);

  return (
    // DESIGN.md §4 Dialog:关闭 = 底部「取消」/ Esc / 点遮罩,不设右上角 ×(与 ConfirmDialog 同构)。
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--overlay-modal)]"
      onMouseDown={(e) => {
        overlayMouseDownOnSelfRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && overlayMouseDownOnSelfRef.current) handleClose();
        overlayMouseDownOnSelfRef.current = false;
      }}
    >
      <div
        className="flex max-h-[min(640px,85vh)] w-[min(600px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-default)',
        }}
      >
        {/* 头部:标题居左 + 步骤指示居右,同一行(2026-07 定稿原型形态)。 */}
        <div className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
          <h3
            className="min-w-0 truncate text-16 font-medium"
            style={{ color: 'var(--settings-section-title)' }}
          >
            {sel
              ? t('settings.providers.wizard.titleWith', {
                  name:
                    sel.kind === 'preset'
                      ? presetDisplayName(sel.preset, i18n.language)
                      : sel.kind === 'ollama-onboarding'
                        ? t('settings.providers.local.title')
                        : sel.provider.name,
                })
              : t('settings.providers.wizard.title')}
          </h3>
          <div className="flex shrink-0 items-center gap-4">
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

        {/* 主体。第 1 步是「固定搜索 + 限高滚动目录 + 钉底自定义入口」的三段结构
            (滚动区上下以 1px Board 细线与固定区分隔,自定义端点不随目录滚动);
            第 2/3 步保持整体滚动的表单区。 */}
        <div
          className={cn(
            'min-h-[320px] flex-1',
            step === 1
              ? 'flex min-h-0 flex-col overflow-hidden'
              : 'overflow-y-auto border-y px-4 py-4',
          )}
          style={{ borderColor: 'var(--border-default)' }}
        >
          {step === 1 && (
            <>
              <div className="px-4 pb-3">
                <div
                  className="flex h-9 items-center gap-2 rounded-full border px-3.5"
                  style={{
                    borderColor: 'var(--border-default)',
                    backgroundColor: 'var(--surface-elevated)',
                  }}
                >
                  <Search
                    size={14}
                    className="shrink-0"
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('settings.providers.wizard.searchPlaceholder')}
                    className="min-w-0 flex-1 bg-transparent text-13 outline-none placeholder:text-[var(--text-placeholder)]"
                    style={{ color: 'var(--settings-section-title)' }}
                  />
                </div>
              </div>

              {/* 目录:单列列表(2026-07 定稿,替代三列卡片宫格),唯一的滚动区。 */}
              <div
                className="min-h-0 flex-1 overflow-y-auto border-y px-2 pb-2"
                style={{ borderColor: 'var(--border-default)' }}
              >
                {!q && recommendations.length > 0 && (
                  <>
                    <GroupLabel>{t('settings.providers.wizard.groupRecommend')}</GroupLabel>
                    {recommendations.map((item) => {
                      if (item.kind === 'ollama') {
                        return (
                          <ProviderRow
                            key="ollama"
                            icon={cardIcon({ providerId: 'ollama', name: 'Ollama' })}
                            name={t('settings.providers.local.title')}
                            meta={t(`settings.providers.wizard.recommendReason.${item.reason}`)}
                            beta
                            onClick={() => void connectOllama()}
                          />
                        );
                      }
                      const provider = oauthChoices.find((choice) => choice.id === item.providerId);
                      if (!provider) return null;
                      const reasonMeta =
                        item.reason === 'subscription'
                          ? t('settings.providers.wizard.recommendReason.subscription')
                          : t(
                              item.reason === 'cli-logged-in'
                                ? 'settings.providers.detect.hintLoggedIn'
                                : 'settings.providers.detect.hintInstalled',
                              { cli: localCliDisplayName(item.cli) },
                            );
                      return (
                        <ProviderRow
                          key={provider.id}
                          icon={cardIcon({
                            providerId: provider.id,
                            name: provider.name,
                          })}
                          name={provider.name}
                          meta={reasonMeta}
                          onClick={() => pickOauth(provider)}
                        />
                      );
                    })}
                  </>
                )}
                {!q && detectedLocalPresets.length > 0 && (
                  <>
                    <GroupLabel>{t('settings.providers.wizard.groupDetectedLocal')}</GroupLabel>
                    {detectedLocalPresets.map((p) => (
                      <ProviderRow
                        key={p.id}
                        icon={cardIcon({
                          providerId: p.id,
                          name: presetDisplayName(p, i18n.language),
                        })}
                        name={presetDisplayName(p, i18n.language)}
                        meta={t('settings.providers.wizard.metaLocalConnect')}
                        beta={isLocalRuntimeBetaProviderId(p.id)}
                        onClick={() => pickPreset(p)}
                      />
                    ))}
                  </>
                )}
                {listedOauth.length > 0 && (
                  <>
                    <GroupLabel>{t('settings.providers.wizard.groupSubscription')}</GroupLabel>
                    {listedOauth.map((p) => (
                      <ProviderRow
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
                  </>
                )}

                {(filteredPresets.length > 0 ||
                  builtinApiKeyChoices.length > 0 ||
                  showOllamaInList) && (
                  <>
                    <GroupLabel>{t('settings.providers.wizard.groupApiKey')}</GroupLabel>
                    {showOllamaInList && (
                      <ProviderRow
                        icon={cardIcon({ providerId: 'ollama', name: 'Ollama' })}
                        name={t('settings.providers.local.title')}
                        meta={t('settings.providers.local.subtitle')}
                        beta
                        onClick={() => void connectOllama()}
                      />
                    )}
                    {builtinApiKeyChoices
                      .filter((p) => !q || p.name.toLowerCase().includes(q))
                      .map((p) => (
                        <ProviderRow
                          key={p.id}
                          icon={cardIcon({ providerId: p.id, name: p.name })}
                          name={p.name}
                          meta={t('settings.providers.wizard.metaApiKey')}
                          onClick={() => pickBuiltinApiKey(p)}
                        />
                      ))}
                    {filteredPresets.map((p) => (
                      <ProviderRow
                        key={p.id}
                        icon={cardIcon({
                          providerId: p.id,
                          name: presetDisplayName(p, i18n.language),
                        })}
                        name={presetDisplayName(p, i18n.language)}
                        meta={t(
                          p.authMethod === 'none'
                            ? 'settings.providers.wizard.metaNoAuth'
                            : 'settings.providers.wizard.metaApiKey',
                        )}
                        beta={isLocalRuntimeBetaProviderId(p.id)}
                        onClick={() => pickPreset(p)}
                      />
                    ))}
                  </>
                )}
                {listedLocalPresets.length > 0 && (
                  <>
                    <GroupLabel>{t('settings.providers.wizard.moreLocal')}</GroupLabel>
                    {listedLocalPresets.map((p) => (
                      <ProviderRow
                        key={p.id}
                        icon={cardIcon({
                          providerId: p.id,
                          name: presetDisplayName(p, i18n.language),
                        })}
                        name={presetDisplayName(p, i18n.language)}
                        meta={t(
                          (LOCAL_CONNECT_PRESET_IDS as readonly string[]).includes(p.id)
                            ? 'settings.providers.wizard.metaLocalConnect'
                            : 'settings.providers.wizard.metaNoAuth',
                        )}
                        beta={isLocalRuntimeBetaProviderId(p.id)}
                        onClick={() => pickPreset(p)}
                      />
                    ))}
                  </>
                )}
              </div>

              {/* 自定义端点:钉在滚动区外,目录再长也始终可见。 */}
              <div className="flex flex-col gap-2 px-4 pb-1 pt-3">
                <button
                  type="button"
                  onClick={onOpenCustomForm}
                  className="flex items-center gap-2.5 rounded-xl border border-dashed p-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
                  style={{ borderColor: 'var(--settings-btn-secondary-border)' }}
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
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

                <p className="text-11 leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                  {t('settings.providers.wizard.pickHint')}
                </p>
              </div>
            </>
          )}

          {step === 2 && sel?.kind === 'ollama-onboarding' && (
            <div className="flex flex-col gap-4">
              <span
                className="text-14 font-medium"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {t('settings.providers.local.onboardingTitle')}
              </span>
              <LocalOllamaInstall
                canInstall={ollamaCanInstall}
                onReady={() => connectOllama()}
              />
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
                    {t(
                      sel.provider.auth.oauth?.flow === 'device-code'
                        ? 'settings.providers.wizard.deviceOAuthDesc'
                        : 'settings.providers.wizard.oauthDesc',
                    )}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* 等待授权中按钮变「取消」(与详情头对称),不禁用——浏览器流挂起时用户必须能中止重试。 */}
                {loggingIn ? (
                  <button
                    type="button"
                    onClick={cancelAuthorize}
                    className="flex h-9 items-center justify-center gap-2 rounded-full border px-6 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                    style={{
                      backgroundColor: 'var(--settings-btn-secondary-bg)',
                      borderColor: 'var(--settings-btn-secondary-border)',
                      color: 'var(--settings-btn-secondary-text)',
                    }}
                  >
                    <Spinner size={13} />
                    {t('settings.providers.button.cancel')}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleAuthorize('browser')}
                      disabled={
                        sel.provider.id === 'openai' && codexAuth.state.oauthWritesBlocked === true
                      }
                      className="flex h-9 items-center justify-center rounded-full border px-6 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                      style={{
                        backgroundColor: 'var(--settings-btn-secondary-bg)',
                        borderColor: 'var(--settings-btn-secondary-border)',
                        color: 'var(--settings-btn-secondary-text)',
                      }}
                    >
                      {t(
                        sel.provider.id === 'openai' && codexAuth.state.oauthWritesBlocked
                          ? 'chatgptAuthRecovery.devReadOnly'
                          : sel.provider.id === 'openai'
                            ? 'settings.providers.wizard.authorizeInBrowser'
                            : sel.provider.auth.oauth?.flow === 'device-code'
                              ? 'settings.providers.wizard.authorizeWithDeviceCode'
                              : 'settings.providers.button.authorize',
                      )}
                    </button>
                    {sel.provider.id === 'openai' && (
                      <button
                        type="button"
                        onClick={() => void handleAuthorize('device-code')}
                        disabled={codexAuth.state.oauthWritesBlocked === true}
                        className="flex h-9 items-center justify-center rounded-full border px-6 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{
                          backgroundColor: 'transparent',
                          borderColor: 'var(--settings-btn-secondary-border)',
                          color: 'var(--settings-btn-secondary-text)',
                        }}
                      >
                        {t('settings.providers.wizard.authorizeWithDeviceCode')}
                      </button>
                    )}
                  </>
                )}
                {/* 替代路径:API 用户没有订阅,OAuth 对其是错误路径——切到该渠道的
                    官方 API 预设表单(填 key),与从目录选预设完全同一条流水线。
                    与「授权」并排的次级描边按钮(White Pill):小灰字形态用户根本
                    注意不到(2026-07-24 实测)。 */}
                {OFFICIAL_API_PRESETS[sel.provider.id] && (
                  <button
                    type="button"
                    onClick={() => pickPreset(OFFICIAL_API_PRESETS[sel.provider.id])}
                    disabled={loggingIn}
                    className="flex h-9 items-center justify-center rounded-full border px-6 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
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
              {openAiDeviceLoginPending && <OAuthDeviceCodeCard deviceCode={openAiDeviceCode} />}
              {genericDeviceFlow && loggingIn && (
                <OAuthDeviceCodeCard deviceCode={genericDeviceCode} />
              )}
              {oauthSingleAgentNote && <InfoLine text={oauthSingleAgentNote} />}
            </div>
          )}

          {step === 2 && sel?.kind === 'builtinApiKey' && (
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
                    className="text-14 font-semibold"
                    style={{ color: 'var(--settings-section-title)' }}
                  >
                    {sel.provider.name}
                  </span>
                  <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.providers.wizard.builtinApiKey.subtitle')}
                  </span>
                </div>
              </div>
              <InfoLine text={t('settings.providers.wizard.builtinApiKey.note')} />
              <div className="flex flex-col gap-1.5">
                <label className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('settings.providers.custom.fields.apiKey')}
                </label>
                <SettingsTextInput value={apiKey} onChange={setApiKey} size="md" mono secret />
              </div>
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
              {presetNeedsApiKey ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('settings.providers.custom.fields.apiKey')}
                  </label>
                  <SettingsTextInput
                    value={apiKey}
                    onChange={setApiKey}
                    placeholder="sk-…"
                    size="md"
                    mono
                    secret
                  />
                </div>
              ) : (
                <InfoLine text={t('settings.providers.wizard.noAuthNote')} />
              )}
              {/* 官方端点默认只读；本机 / 自托管代理预设可编辑。codex + openai-chat
                  上游标注「Cindy 桥接」，让用户明确该通道是协议转换而非原生。 */}
              <div className="flex flex-col gap-2">
                {presetAgents.map((agent) => {
                  const rt = sel.preset.runtimes[agent];
                  const bridged = agent === 'codex' && rt?.wireProtocol === 'openai-chat';
                  if (rt?.baseUrlEditable) {
                    const value = presetBaseUrls[agent] ?? rt.baseUrl;
                    const valid = isValidEditablePresetBaseUrl(value.trim());
                    return (
                      <label key={agent} className="flex flex-col gap-1.5">
                        <span
                          className="text-12 font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {t('settings.providers.wizard.endpointLabel', {
                            agent: AGENT_LABEL[agent],
                          })}
                        </span>
                        <input
                          type="url"
                          value={value}
                          onChange={(event) =>
                            setPresetBaseUrls((prev) => ({
                              ...prev,
                              [agent]: event.target.value,
                            }))
                          }
                          aria-invalid={!valid}
                          className="h-9 rounded-full border px-4 font-mono text-12 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                          style={{
                            borderColor: valid ? 'var(--border-default)' : 'var(--status-error)',
                            backgroundColor: 'var(--surface-elevated)',
                            color: 'var(--settings-section-title)',
                          }}
                        />
                        {bridged && (
                          <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
                            {t('settings.providers.wizard.bridgedNote')}
                          </span>
                        )}
                      </label>
                    );
                  }
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
                  {picks.size > 0 && (
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
                            'flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
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
                  )}
                  {showManualModelFallback && (
                    <div
                      className="flex flex-col gap-3 rounded-xl border p-3.5"
                      style={{ borderColor: 'var(--border-default)' }}
                    >
                      <InfoLine text={t('settings.providers.wizard.manualModelHint')} />
                      {presetAgents.map((agent) => (
                        <label key={agent} className="flex flex-col gap-1.5">
                          <span
                            className="text-12 font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {t('settings.providers.wizard.manualModelLabel', {
                              agent: AGENT_LABEL[agent],
                            })}
                          </span>
                          <span className="flex items-center gap-2">
                            <input
                              type="text"
                              value={manualModelIds[agent] ?? ''}
                              onChange={(event) =>
                                setManualModelIds((prev) => ({
                                  ...prev,
                                  [agent]: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                event.preventDefault();
                                addManualModel(agent);
                              }}
                              placeholder={t('settings.providers.wizard.manualModelPlaceholder')}
                              className="h-9 min-w-0 flex-1 rounded-full border px-4 font-mono text-12 outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                              style={{
                                borderColor: 'var(--border-default)',
                                backgroundColor: 'var(--surface-elevated)',
                                color: 'var(--settings-section-title)',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => addManualModel(agent)}
                              disabled={!manualModelIds[agent]?.trim()}
                              className="flex h-9 shrink-0 items-center justify-center rounded-full border px-4 text-12 font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
                              style={{
                                borderColor: 'var(--settings-btn-secondary-border)',
                                color: 'var(--settings-btn-secondary-text)',
                              }}
                            >
                              {t('settings.providers.wizard.addManualModel')}
                            </button>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <p className="text-11 leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.providers.wizard.modelsHint')}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* 底部 */}
        {/* 底部操作行:不再加分割线 —— 弹窗内只保留滚动区上下两条细线(原型定稿)。 */}
        <div className="flex items-center justify-between px-4 pb-4 pt-2">
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
              className="flex h-9 items-center justify-center rounded-full border px-6 text-13 font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              {t('settings.providers.wizard.cancel')}
            </button>
            {sel?.kind === 'builtinApiKey' && step === 2 && (
              <button
                type="button"
                onClick={() => void handleSaveBuiltinApiKey()}
                disabled={saving || apiKey.trim().length === 0}
                className={cn(
                  'flex h-9 items-center justify-center gap-2 rounded-full px-5 text-13 font-medium transition-opacity',
                  saving || apiKey.trim().length === 0
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:opacity-90',
                )}
                style={{ backgroundColor: 'var(--accent-cta-bg)', color: 'var(--surface-on-card)' }}
              >
                {saving && <Spinner size={13} />}
                {t('settings.providers.wizard.finish')}
              </button>
            )}
            {sel?.kind === 'preset' && step === 2 && (
              <button
                type="button"
                onClick={() => void startFetch()}
                disabled={!presetCanContinue}
                className={cn(
                  'flex h-9 items-center justify-center rounded-full px-6 text-13 font-medium transition-opacity',
                  !presetCanContinue ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90',
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
                  'flex h-9 items-center justify-center gap-2 rounded-full px-6 text-13 font-medium transition-opacity',
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
