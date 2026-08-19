import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Info, TriangleAlert, X } from 'lucide-react';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isModelSelectableForNewRoute,
  modelSupportsFastMode,
  providerOffersModel,
} from '@cindy/model-providers';

import { FastModeToggle } from '@/components/new-chat/FastModeToggle';
import { FullAccessConfirmContent } from '@/components/new-chat/FullAccessConfirmContent';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import { agentKindToVendor } from '@/components/sidebar/VendorIcon';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { filterChatBridgedCodexProviders } from '@/lib/providerModels';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { cn } from '@/lib/utils';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import {
  getProviderModelEffort,
  getProviderModelFast,
  setProviderModelChoice,
  setProviderModelEffort,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import {
  DEFAULT_WORKER_CREATION_PREFS,
  readWorkerCreationPrefs,
  writeWorkerCreationPrefs,
  type WorkerCreationPrefs,
} from '@/state/workerCreationPrefs';
import type { Effort } from '@/lib/userPreferences.types';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import {
  DEFAULT_ORCA_WORKER_PERMISSION_MODE,
  ORCA_WORKER_PERMISSION_MODES,
  type OrcaWorkerPermissionMode,
} from '../../../shared/orca-worker-permission-mode';
import { selectWorkerModels } from './workerModelAvailability';

const PREDEFINED_ROLES = ['developer', 'designer', 'reviewer', 'tester', 'merger'] as const;
const AUTO_ONLY_WORKER_PERMISSION_MODES = ['auto'] as const;

export interface CreateWorkerForm {
  role: string;
  agent: 'claude-code' | 'codex' | 'pi';
  model: string;
  effort?: Effort;
  fast?: boolean;
  /** 显式选定的模型来源;null = 未显式,由 main 侧按默认路由解析。 */
  providerId: string | null;
  initialTask: string;
  /** 本次 Worker 权限；提交后同时成为下一次创建 Worker 的默认值。 */
  workerPermissionMode?: OrcaWorkerPermissionMode;
}

export interface CreateWorkerPopoverProps {
  open: boolean;
  onClose: () => void;
  onCreate: (form: CreateWorkerForm) => void | Promise<void>;
  title?: string;
  submitLabel?: string;
  className?: string;
  /** device-link controlled device; omitted for a local Lead session. */
  deviceId?: string;
  /**
   * SSH 远程 Lead(session.remoteHostId 非空):模型清单按 SSH 口径过滤 ——
   * 订阅直连(chatgpt/ / xai/)与 openai-chat 桥接 Codex 供应商的桥只挂在本地
   * proxy,远端不经翻译,选了必被 main 侧 remote-worker guard 拒绝
   * (codex review R28)。提交前就在面板里藏掉,与 ChatInput 同口径。
   */
  sshRemote?: boolean;
  /** 开启新协同时必须确认执行端支持权限偏好；已有旧版远程 Team 创建 Worker 仍兼容旧行为。 */
  requireWorkerPermissionModeSupport?: boolean;
}

export function CreateWorkerPopover({
  open,
  onClose,
  onCreate,
  title,
  submitLabel,
  className,
  deviceId,
  sshRemote,
  requireWorkerPermissionModeSupport = false,
}: CreateWorkerPopoverProps) {
  const { t } = useTranslation();
  const { confirm: confirmDialog } = useConfirmDialog();
  const navigate = useNavigate();
  const [role, setRole] = useState('developer');
  const [customRole, setCustomRole] = useState('');
  const [agent, setAgent] = useState<'claude-code' | 'codex' | 'pi'>('codex');
  const [model, setModel] = useState(DEFAULT_WORKER_CREATION_PREFS.codex.model);
  const [effort, setEffort] = useState<Effort>(DEFAULT_WORKER_CREATION_PREFS.codex.effort);
  const [fast, setFast] = useState(DEFAULT_WORKER_CREATION_PREFS.codex.fast);
  // 显式选定的模型来源(标准面板供应商分段);null = 未显式。device-link 远程创建
  // 面板退化为被控端纯列表(无来源维度),恒为 null。
  const [providerSource, setProviderSource] = useState<string | null>(null);
  const [initialTask, setInitialTask] = useState('');
  const [selectedWorkerPermissionMode, setSelectedWorkerPermissionMode] =
    useState<OrcaWorkerPermissionMode>(DEFAULT_ORCA_WORKER_PERMISSION_MODE);
  const [prefs, setPrefs] = useState<WorkerCreationPrefs>(DEFAULT_WORKER_CREATION_PREFS);
  const [prefsRestored, setPrefsRestored] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const ccCaps = useAgentCapabilities('claude-code', deviceId);
  const codexCaps = useAgentCapabilities('codex', deviceId);
  const piCaps = useAgentCapabilities('pi', deviceId);
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const providersLoading = deviceId ? remoteProviders.loading : localProviders.loading;
  const providersError = deviceId ? remoteProviders.error : null;
  const visibilityVersion = useModelVisibilityVersion();
  const activeCapabilitiesState = agent === 'codex' ? codexCaps : agent === 'pi' ? piCaps : ccCaps;
  const activeCaps = activeCapabilitiesState.capabilities;
  const supportsWorkerPermissionModeSelection =
    !deviceId || activeCaps?.supportsOrcaWorkerPermissionMode === true;
  const remoteWorkerPermissionModeUnsupported =
    !!deviceId
    && activeCaps !== null
    && activeCaps?.supportsOrcaWorkerPermissionMode !== true;
  const activeModels = useMemo(() => {
    return selectWorkerModels({
      agent,
      capabilities: activeCaps,
      deviceId,
      providers,
      providersLoading,
      providersError,
      providersUnsupported: deviceId ? remoteProviders.unsupported : false,
      excludeSubscriptionDirect: sshRemote === true,
      excludeChatBridgedCodex: sshRemote === true,
      isVisible: deviceId
        ? undefined
        : (providerId, catalogModel) => isModelEnabled(agent, providerId, catalogModel),
    });
  }, [
    activeCaps,
    agent,
    deviceId,
    providers,
    providersError,
    providersLoading,
    remoteProviders.unsupported,
    sshRemote,
    visibilityVersion,
  ]);
  const currentModel = activeModels.find((m) => m.id === model);
  const modelCatalogLoading = activeCapabilitiesState.loading || providersLoading;
  const remoteModelListBlocked =
    !!deviceId &&
    (activeCapabilitiesState.loading ||
      activeCapabilitiesState.error !== null ||
      providersLoading ||
      (!!providersError && !remoteProviders.unsupported));

  // 显式来源仅在「已连接、确实提供该模型、且该 (来源, 模型) 未被**停用**」时有效;
  // 其余(断开/下架/停用/换了模型)收窄为 null 交回默认路由解析。停用判据 =
  // buildRegistry 烘焙的 model.disabled(供应商级 suspended 已被
  // connectedProvidersForAgent 剔除)。「隐藏」不再收窄 —— 隐藏只是陈列过滤,
  // 记忆来源被隐藏仍然合法可路由(2026-07 启用/显示双轴拆分)。device-link 恒 null。
  const routableProviders = useMemo(
    () =>
      filterChatBridgedCodexProviders(
        connectedProvidersForAgent(providers, agent),
        agent,
        sshRemote === true && !deviceId,
      ),
    [agent, deviceId, providers, sshRemote],
  );
  const narrowProviderSource = useCallback(
    (candidate: string | null, modelId: string): string | null => {
      if (!candidate || deviceId) return null;
      const provider = routableProviders.find((p) => p.id === candidate);
      if (!provider || !providerOffersModel(provider, modelId, agent)) return null;
      const catalogModel = getModel(provider, modelId, agent);
      // 非聊天模型不该被当成 worker 的有效显式来源(issue #882 第 3 点,2026-07
      // review):providerOffersModel 只看 id 是否存在,不看 mode——记忆来源的这份
      // 具体条目若是非聊天,即便面板列表(activeModels,来自另一个来源的聊天分类)
      // 里还看得到同 id,也不能提交这个来源,否则请求会发到 image/audio 端点。
      // 停用(disabled)判据同上方 routableProviders 注:隐藏不再收窄(2026-07
      // 启用/显示双轴拆分),故不查 isModelEnabled——记忆来源被隐藏仍合法可路由。
      return catalogModel &&
        isModelSelectableForNewRoute(catalogModel, { userProvider: provider.source === 'user' })
        ? candidate
        : null;
    },
    [agent, deviceId, routableProviders],
  );

  // per-provider Fast 能力:同一 model id 在不同来源下 supportsFastMode 可不同(见
  // CatalogModel)。显式选了来源按该来源条目查;未显式(null)也要先解析**生效默认
  // 来源**再查它自己的条目(codex review:拍平并集是首来源 wins,默认来源不支持时
  // 会把 stale true 一路带到提交)。device-link 同规则按被控端 provider 快照的生效
  // 默认来源判定(与被控端 main 的 fastModels re-gate 同口径);仅快照不可用(旧
  // peer 无 provider 镜像,解析不出来源)才回落拍平并集(codex review)。
  const providerFastSupported = useCallback(
    (candidate: string | null, modelId: string): boolean => {
      // device-link 面板无来源维度,candidate 恒 null,走默认来源解析。
      const sourceId =
        candidate ?? effectiveSourceIdForModel(routableProviders, null, modelId, agent);
      if (!sourceId) {
        return deviceId
          ? !!activeModels.find((m) => m.id === modelId)?.supportsFastMode
          : false;
      }
      const provider = routableProviders.find((p) => p.id === sourceId);
      return modelSupportsFastMode(provider, modelId, agent);
    },
    [activeModels, agent, deviceId, routableProviders],
  );
  // Fast 判定先对 providerSource 收窄:记忆来源刚失效(断开/掉模型/被隐藏)而收敛
  // effect 尚未把 state 置 null 的同一渲染里,直接用旧值会得到 false 并把记忆的
  // fast=true 清掉,回退默认来源支持 Fast 也不会恢复(codex review)。收窄后按
  // 「实际会生效的来源」口径判定,不经历 false 窗口。
  const currentModelSupportsFast = Boolean(
    (agent === 'codex' || agent === 'pi') &&
      activeCaps?.hasFastMode &&
      providerFastSupported(narrowProviderSource(providerSource, model), model),
  );
  // 实际路由来源的 effort 档位表:**显示收敛与提交共用同一口径**,保证面板显示的
  // effort 就是派发的 effort —— 只在提交口改写会出现「显示 high、创建 low」的静默
  // 不一致(codex review,device-link 与本地恢复路径同病)。显式来源(收窄后)优先,
  // 否则生效默认来源(local/remote 快照同规则);来源条目缺失或无档位元数据回落
  // 拍平条目(旧 peer 无快照),main 侧重归一兜底。
  const routeEffortMetaFor = useCallback(
    (modelId: string): { efforts: readonly string[]; defaultEffort: string | null } | undefined => {
      const flat = activeModels.find((m) => m.id === modelId);
      const sourceId = deviceId
        ? effectiveSourceIdForModel(providers, null, modelId, agent)
        : narrowProviderSource(providerSource, modelId)
          ?? effectiveSourceIdForModel(routableProviders, null, modelId, agent);
      const provider = sourceId
        ? (deviceId ? connectedProvidersForAgent(providers, agent) : routableProviders).find(
            (p) => p.id === sourceId,
          )
        : undefined;
      const entry = provider ? getModel(provider, modelId, agent) : undefined;
      return entry?.efforts ? entry : flat;
    },
    [
      activeModels,
      agent,
      deviceId,
      narrowProviderSource,
      providerSource,
      providers,
      routableProviders,
    ],
  );
  const noAvailableLocalModels =
    prefsRestored &&
    !deviceId &&
    !modelCatalogLoading &&
    (activeCaps !== null || activeCapabilitiesState.error !== null) &&
    activeModels.length === 0;

  // 打开弹窗时恢复上次选择；initial task 不记忆，避免把旧任务误带到下一次创建。
  useEffect(() => {
    if (!open) {
      setPrefsRestored(false);
      return;
    }
    const stored = readWorkerCreationPrefs();
    const agentPrefs = stored[stored.lastAgent];
    setPrefs(stored);
    setAgent(stored.lastAgent);
    setModel(agentPrefs.model);
    setEffort(agentPrefs.effort);
    setFast(agentPrefs.fast);
    setProviderSource(deviceId ? null : agentPrefs.providerId);
    setInitialTask('');
    setSelectedWorkerPermissionMode(stored.workerPermissionMode);
    setPrefsRestored(true);
  }, [deviceId, open]);

  useEffect(() => {
    if (
      !supportsWorkerPermissionModeSelection
      && selectedWorkerPermissionMode !== 'auto'
    ) {
      setSelectedWorkerPermissionMode('auto');
    }
  }, [selectedWorkerPermissionMode, supportsWorkerPermissionModeSelection]);

  // capabilities 可能尚未加载或模型被移除；加载后把当前选择收敛到可用模型和 effort。
  useEffect(() => {
    if (!open || !prefsRestored || modelCatalogLoading) return;
    const models = activeModels;
    if (models.length === 0) return;
    let selected = models.find((m) => m.id === model);
    if (!selected) {
      // Provider loading has settled, so activeModels is authoritative for both local and remote
      // creation. A capability entry alone does not make a disconnected provider's model usable.
      selected = models[0];
      setModel(selected.id);
    }
    // effort 收敛按**实际路由来源档位表**(routeEffortMetaFor,与提交同口径):
    // 按拍平条目收敛会留下「显示 high、提交时被对账成 low」的静默不一致
    // (codex review)。
    const effortMeta = routeEffortMetaFor(selected.id) ?? selected;
    const metaEfforts: readonly string[] = effortMeta.efforts;
    if (metaEfforts.length > 0 && !metaEfforts.includes(effort)) {
      setEffort(effortMeta.defaultEffort ?? metaEfforts[metaEfforts.length - 1]);
    }
    // 恢复出来的显式来源可能已断开或不提供收敛后的模型 —— 目录就绪后同步收窄。
    if (providerSource !== null) {
      const narrowed = narrowProviderSource(providerSource, selected.id);
      if (narrowed !== providerSource) setProviderSource(narrowed);
    }
  }, [
    activeModels,
    agent,
    effort,
    model,
    modelCatalogLoading,
    narrowProviderSource,
    open,
    prefsRestored,
    providerSource,
    routeEffortMetaFor,
  ]);

  useEffect(() => {
    if (currentModel && !currentModelSupportsFast && fast) {
      setFast(false);
    }
  }, [currentModel, currentModelSupportsFast, fast]);

  const vendorKey = agentKindToVendor(agent);
  const updateAgent = useCallback(
    (nextAgent: 'claude-code' | 'codex' | 'pi') => {
      if (nextAgent === agent) return;
      // 切走前把当前 agent 的 live 编辑(模型/effort/Fast/来源)快照进内存 prefs:
      // 恢复读的是 prefs,不快照会把「改了还没提交就切了个 tab」的编辑静默回滚到
      // 打开弹窗时的旧值(codex review)。只更新内存态,localStorage 仍只在提交时
      // 写 —— 关闭弹窗不持久化未提交编辑,语义不变。
      const snapshot: WorkerCreationPrefs = {
        ...prefs,
        [agent]: {
          model,
          effort,
          fast,
          // device-link 面板无来源维度(providerSource 恒 null),保留本地记忆原值,
          // 与提交路径同规则。
          providerId: deviceId ? prefs[agent].providerId : providerSource,
        },
      };
      setPrefs(snapshot);
      setAgent(nextAgent);
      const remembered = snapshot[nextAgent];
      setModel(remembered.model);
      setEffort(remembered.effort);
      setFast(remembered.fast);
      setProviderSource(deviceId ? null : remembered.providerId);
    },
    [agent, deviceId, effort, fast, model, prefs, providerSource],
  );

  const updateModel = useCallback(
    (nextModel: string) => {
      setModel(nextModel);
      // flat 面板换模型(device-link 退化路径):effort 同样按路由来源档位表收敛,
      // 与收敛 effect / 提交同口径,不留显示与派发不一致的窗口。
      const effortMeta = routeEffortMetaFor(nextModel);
      const metaEfforts: readonly string[] = effortMeta?.efforts ?? [];
      if (effortMeta && metaEfforts.length > 0 && !metaEfforts.includes(effort)) {
        setEffort(effortMeta.defaultEffort ?? metaEfforts[metaEfforts.length - 1]);
      }
      // 仅换模型:当前显式来源不提供新模型时收窄,避免形成不可能组合;
      // Fast 与选行路径同判据(providerFastSupported,per-provider),不用拍平并集值。
      const narrowed = narrowProviderSource(providerSource, nextModel);
      setProviderSource(narrowed);
      if (!providerFastSupported(narrowed, nextModel)) {
        setFast(false);
      }
    },
    [effort, narrowProviderSource, providerFastSupported, providerSource, routeEffortMetaFor],
  );

  // 分段行原子选择 (来源, 模型):与 composer 的 handleProviderChange 同语义。
  // 面板选行只回传 (providerId, modelId) 两参,目标模型记忆的 effort/Fast 要在这里
  // 主动从模型级全局预设恢复(codex review:否则用户在非选中行 hover 配置的
  // effort/Fast 在选中该行后被丢弃);Fast 还要叠加该来源条目的 per-provider 能力。
  const handleProviderChange = useCallback(
    (providerId: string | null, modelId?: string, reconciledEffort?: Effort) => {
      const nextModel = modelId ?? model;
      const narrowed = narrowProviderSource(providerId, nextModel);
      // 「钉/重选当前生效来源」与「切到恰好提供同一模型的另一来源」必须区分
      // (codex review):前者保留表单 live 值(仅把生效来源钉成显式);后者是真实
      // 来源切换,要恢复目标行显示的预设。判据 = 目标来源是否就是切换前的生效来源
      // (显式值,未显式时为解析出的默认来源),不能只看模型是否相同。
      const effectiveBefore = deviceId
        ? null
        : providerSource ?? effectiveSourceIdForModel(routableProviders, null, model, agent);
      setProviderSource(narrowed);
      if (!modelId) return;
      if (modelId === model && narrowed !== null && narrowed === effectiveBefore) {
        // 钉当前生效来源也是一次真实选定:live effort/Fast 保留,但 (来源, 模型)
        // 要记入全局 choice —— 该来源槽的 lastModel 可能还指着别的模型,不记会让
        // 其它标准选择器切到该来源时恢复 stale 模型(codex review)。无档模型跳过,
        // 与下方真实切换路径同规则。
        if (currentModel && currentModel.efforts.length > 0) {
          setProviderModelChoice(agent, narrowed, modelId, effort);
        }
        return;
      }
      setModel(modelId);
      const available = activeModels.find((m) => m.id === modelId);
      if (!available) return;
      // 档位表按选中来源自己的目录条目:activeModels 是首来源 wins 的拍平清单,
      // 同 id 模型的 efforts/defaultEffort 跨来源可分叉,按拍平条目校验会保留/赋予
      // 选中来源不支持的档位,提交后被 main 侧路由来源校验拒掉(codex review)。
      // 未收窄出显式来源时取生效默认来源的条目;来源条目缺失或无档位元数据时
      // 回落拍平条目(device-link 无本地目录,handleProviderChange 本就不接线)。
      const effortSourceId =
        narrowed ?? effectiveSourceIdForModel(routableProviders, null, modelId, agent);
      const effortSourceProvider = effortSourceId
        ? routableProviders.find((p) => p.id === effortSourceId)
        : undefined;
      const sourceEntry = effortSourceProvider
        ? getModel(effortSourceProvider, modelId, agent)
        : undefined;
      const effortMeta = sourceEntry?.efforts ? sourceEntry : available;
      // 宽化为 string 数组做 includes:目录条目的 efforts 是 model-providers 包的
      // 字面量联合,与本组件的 Effort(string)不同源,语义同为档位 id。
      const validEfforts: readonly string[] = effortMeta.efforts;
      const remembered =
        reconciledEffort ??
        (providerId ? getProviderModelEffort(agent, providerId, modelId) : undefined);
      let nextEffort: Effort | null = null;
      if (remembered && validEfforts.includes(remembered)) {
        nextEffort = remembered;
      } else if (validEfforts.length > 0) {
        // 该模型无共享预设(如 workerCreationPrefs 早于预设 store 的老数据)时,对齐
        // 目标行显示的 defaultEffort(非活跃行的 effort 徽标 = 预设 ?? defaultEffort,
        // 见 ModelSelector 行级 effort 派生):旧 live 值恰好也被目标支持时保留它,
        // 会让创建参数与行上显示的档位不一致(codex review);与下方 Fast 的
        // 「无预设 = 对齐显示」同规则。钉/重选当前生效来源已在上方早退,live 值
        // 不受本分支影响。
        nextEffort = effortMeta.defaultEffort ?? effortMeta.efforts[effortMeta.efforts.length - 1];
      }
      if (nextEffort) setEffort(nextEffort);
      // 真实选定 (来源, 模型) 要写 choice:更新该来源槽的 lastModel(composer 与
      // 其它标准选择器的 resolveSourceSwitch 用它做切来源落点),否则本面板的显式
      // 选择不进全局记忆,别处切到该来源仍恢复旧模型(codex review)。无档模型
      // 跳过 —— store 的 lastModel 依附 effort 记录。
      if (effortSourceId && nextEffort) {
        setProviderModelChoice(agent, effortSourceId, modelId, nextEffort);
      }
      if (!providerFastSupported(narrowed, modelId)) {
        setFast(false);
      } else {
        // 面板行的 Fast 闪电按全局预设显示,无预设 = 关:选行后必须对齐显示,
        // 不能沿用上一个模型的 true(codex review)。
        const rememberedFast = providerId
          ? getProviderModelFast(agent, providerId, modelId)
          : undefined;
        setFast(rememberedFast === true);
      }
    },
    [
      activeModels,
      agent,
      currentModel,
      deviceId,
      effort,
      model,
      narrowProviderSource,
      providerFastSupported,
      providerSource,
      routableProviders,
    ],
  );

  // 活跃行的 effort/Fast 编辑走 onEffortChange/onFastModeChange 而非 modelMemory
  // (ModelSelector 有意区分两条通道),必须同步写回模型级全局预设 —— 否则切走再
  // 切回时 handleProviderChange 按旧全局值恢复,刚做的编辑被静默丢弃(codex review)。
  // 记忆槽位对显式来源先收窄(与 Fast 判定同口径):恢复读的是全局预设槽不受 key
  // 影响,但来源槽兼容副本按实际生效来源落 key,不在收敛 effect 前的窗口里写给已
  // 失效来源(copilot review;ChatInput 的 effectiveSourceId 同语义);收窄空则回落
  // 该模型的生效默认来源(全局预设本就是跨来源共享)。
  const activeMemorySourceId = deviceId
    ? null
    : narrowProviderSource(providerSource, model)
      ?? effectiveSourceIdForModel(routableProviders, null, model, agent);
  const updateEffort = useCallback(
    (next: Effort) => {
      setEffort(next);
      if (activeMemorySourceId && model) {
        setProviderModelEffort(agent, activeMemorySourceId, model, next);
      }
    },
    [activeMemorySourceId, agent, model],
  );
  const updateFast = useCallback(
    (enabled: boolean) => {
      setFast(enabled);
      if (activeMemorySourceId && model) {
        setProviderModelFast(agent, activeMemorySourceId, model, enabled);
      }
    },
    [activeMemorySourceId, agent, model],
  );

  // 非选中行 hover 配置(推理强度/Fast)与 composer 共用同一份模型级全局预设。
  // device-link 远程创建不传:被控端记忆需镜像通道,宁可无记忆也不掺控制端本机。
  const modelMemory = useMemo(
    () =>
      deviceId
        ? undefined
        : {
            getEffort: getProviderModelEffort,
            setEffort: setProviderModelEffort,
            setChoice: setProviderModelChoice,
            getFast: getProviderModelFast,
            setFast: setProviderModelFast,
          },
    [deviceId],
  );

  const activeRole = customRole || role;
  const customRoleError =
    customRole.length > 0 &&
    PREDEFINED_ROLES.includes(customRole as (typeof PREDEFINED_ROLES)[number])
      ? t('orca.createWorker.customRolePredefinedError')
      : null;
  const canCreate =
    !isSubmitting &&
    activeRole.length >= 1 &&
    activeRole.length <= 32 &&
    !customRoleError &&
    !remoteModelListBlocked &&
    (!requireWorkerPermissionModeSupport || !remoteWorkerPermissionModeUnsupported) &&
    !!currentModel;
  const resolvedTitle = title ?? t('orca.createWorker.title');
  const resolvedSubmitLabel = submitLabel ?? t('orca.createWorker.submit');

  const updateWorkerPermissionMode = useCallback(
    async (nextMode: OrcaWorkerPermissionMode) => {
      if (requiresFullAccessConfirmation(selectedWorkerPermissionMode, nextMode)) {
        const confirmed = await confirmDialog({
          title: t('newChat.chatInput.fullAccessConfirmation.title'),
          description: t('newChat.chatInput.fullAccessConfirmation.description'),
          content: <FullAccessConfirmContent />,
          describeContent: true,
          maxWidth: 440,
          confirmText: t('newChat.chatInput.fullAccessConfirmation.confirm'),
          cancelText: t('newChat.chatInput.fullAccessConfirmation.cancel'),
          confirmIcon: <TriangleAlert size={14} />,
        });
        if (!confirmed) return;
      }
      setSelectedWorkerPermissionMode(nextMode);
    },
    [confirmDialog, selectedWorkerPermissionMode, t],
  );

  const handleCreate = useCallback(async () => {
    if (!canCreate || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    // 提交前对 (来源, 模型) 再收窄一次:收敛 effect 与提交之间目录可能已变化。
    const submitProviderId = narrowProviderSource(providerSource, model);
    const nextPrefs: WorkerCreationPrefs = {
      ...prefs,
      lastAgent: agent,
      workerPermissionMode: supportsWorkerPermissionModeSelection
        ? selectedWorkerPermissionMode
        : prefs.workerPermissionMode,
      [agent]: {
        model,
        effort,
        fast,
        // device-link 创建不覆盖本地来源记忆(远程面板没有来源维度)。
        providerId: deviceId ? prefs[agent].providerId : submitProviderId,
      },
    };
    setPrefs(nextPrefs);
    writeWorkerCreationPrefs(nextPrefs);
    // 提交 effort 按**实际路由来源档位表**对账(codex/copilot review):恢复路径的
    // stale effort、以及路由来源条目无档而拍平条目有档的组合,直接把 live 值
    // explicit 下发会被 main 侧路由来源校验拒掉(INVALID_PARAMS 阻断创建)。条目
    // 无档 → 省略(main 按该来源 defaultEffort=null 落);live 值不在其档位表 →
    // 落其 defaultEffort。收敛 effect 与本对账共用 routeEffortMetaFor,显示与派发
    // 同口径,这里只是提交瞬间的兜底(收敛后目录仍可能变化)。
    const submitEffortMeta = routeEffortMetaFor(model) ?? currentModel;
    const submitEfforts: readonly string[] = submitEffortMeta?.efforts ?? [];
    const submitEffort = submitEfforts.length === 0
      ? undefined
      : submitEfforts.includes(effort)
        ? effort
        : (submitEffortMeta?.defaultEffort ?? undefined);
    try {
      await onCreate({
        role: activeRole,
        agent,
        model,
        effort: submitEffort,
        fast: currentModelSupportsFast ? fast : undefined,
        providerId: submitProviderId,
        initialTask,
        ...(supportsWorkerPermissionModeSelection
          ? { workerPermissionMode: selectedWorkerPermissionMode }
          : {}),
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    canCreate,
    prefs,
    activeRole,
    agent,
    deviceId,
    model,
    effort,
    fast,
    providerSource,
    narrowProviderSource,
    currentModel,
    currentModelSupportsFast,
    initialTask,
    onCreate,
    routeEffortMetaFor,
    selectedWorkerPermissionMode,
    supportsWorkerPermissionModeSelection,
  ]);

  if (!open) return null;

  return (
    <div className={cn('fixed inset-0 z-50 flex items-center justify-center', className)}>
      <div className="absolute inset-0 bg-[var(--overlay-modal)]" onClick={onClose} />
      <div
        className="relative z-10 w-[500px] rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6"
        style={{ boxShadow: 'var(--shadow-menu)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <span className="text-16 font-medium text-[var(--text-primary)]">{resolvedTitle}</span>
          <button
            type="button"
            aria-label={t('orca.createWorker.closeAria')}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <div className="mb-2 flex items-center gap-1">
            <span className="text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
              {t('orca.createWorker.roleLabel')}
            </span>
            <Tip
              text={t('orca.createWorker.roleHint')}
              side="top"
              contentClassName="max-w-[280px] whitespace-normal break-words text-left"
            >
              <button
                type="button"
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0',
                  'text-[var(--text-tertiary)] outline-none transition-colors',
                  'hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
                  'focus:bg-[var(--surface-hover)] focus:text-[var(--text-secondary)]',
                )}
                aria-label={t('orca.createWorker.roleHintAria')}
              >
                <Info size={13} aria-hidden />
              </button>
            </Tip>
          </div>
          <div className="flex flex-wrap gap-2">
            {PREDEFINED_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                className={cn(
                  'rounded-full px-3 py-1.5 text-13 leading-none border transition-colors',
                  activeRole === r
                    ? 'bg-[var(--surface-chip)] border-[var(--text-secondary)] text-[var(--text-primary)] font-medium'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]',
                )}
                onClick={() => {
                  setRole(r);
                  setCustomRole('');
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="mt-2 w-full rounded-full border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-13 leading-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--text-secondary)]"
            placeholder={t('orca.createWorker.customRolePlaceholder')}
            value={customRole}
            maxLength={32}
            onChange={(e) => {
              setCustomRole(e.target.value);
              setRole('');
            }}
          />
          {customRoleError && (
            <div className="mt-1 text-11 text-[var(--error-fg)]">{customRoleError}</div>
          )}
        </div>

        <div className="mb-4 grid grid-cols-[220px_minmax(0,1fr)] gap-4">
          <div className="min-w-0">
            <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
              {t('orca.createWorker.agentLabel')}
            </div>
            {/* 应用标准 Agent 分段控件(替换此前手写的按钮组;与 New Maker / IM 目录偏好同款,
                「不自建选择 UI」的组件复用原则)。 */}
            <VendorSegmentedSwitcher
              value={vendorKey}
              width={220}
              ariaLabel={t('orca.createWorker.agentLabel')}
              onChange={(next) =>
                updateAgent(next === 'codex' ? 'codex' : next === 'pi' ? 'pi' : 'claude-code')
              }
            />
          </div>

          <div className="min-w-0">
            <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
              {t('orca.createWorker.modelLabel')}
            </div>
            {/* composer 同款全功能标准面板(2026-07 用户定稿基准:全软件一个模型选择面板,
                处处同行为):供应商分段、订阅来源、推理强度、Fast(行级配置列,替代此前的
                外置开关)全开;选定来源随创建参数显式下发,由 OrcaWorkerCreationService
                精确 preflight。device-link 远程创建维持既有退化:被控端纯列表、无来源维度,
                且面板行级 Fast 依赖来源分段(fastEditable 走 connected 目录),故远程仍用
                外置 FastModeToggle,不能删。 */}
            <div className="flex min-w-0 items-center gap-2">
              {deviceId && currentModelSupportsFast && (
                <FastModeToggle enabled={fast} onToggle={() => setFast((v) => !v)} />
              )}
              <ModelSelector
                modelId={model}
                effort={effort}
                onModelChange={updateModel}
                onEffortChange={updateEffort}
                vendorKey={vendorKey}
                deviceId={deviceId}
                // SSH 远程 Lead:与 ChatInput 同口径藏掉仅本地可桥接的模型/来源
                // (订阅直连接本地 compat-proxy,openai-chat 桥接 Codex 接本地
                // codex-proxy,远端都不经翻译)—— 否则提交才被 main 侧 guard 拒绝。
                excludeSubscriptionDirect={sshRemote === true}
                excludeChatBridgedCodex={sshRemote === true}
                popoverSide="bottom"
                currentProviderId={
                  deviceId
                    ? undefined
                    : sshRemote === true
                      ? narrowProviderSource(providerSource, model)
                      : providerSource
                }
                onProviderChange={deviceId ? undefined : handleProviderChange}
                // providerSource=null 时面板高亮的是**解析出来的生效默认来源**,点它的
                // 语义是「把默认来源钉成显式偏好」,必须照常回调(codex review)——否则
                // 用户点了没反应,之后默认路由一变创建就静默换来源。显式同值幂等无害。
                reselectEmitsChange
                // 分离侧栏窗口固定在 /sidebar-window 壳路由,本地 navigate 会把辅助
                // 窗口整壳替换成主设置路由(codex review)——与 OrcaWorkerPanel 的
                // settingsEnabled={!isSidebarWindow()} 同禁用口径,不接线跳转。
                onNavigateToProviders={
                  deviceId || isSidebarWindow()
                    ? undefined
                    : () => {
                        onClose();
                        navigate('/settings?tab=providers');
                      }
                }
                modelMemory={modelMemory}
                // worker 创建链的显式 Fast 派发支持 Codex 与 Pi(resolveWorkerConfig 对二者
                // 消费 input.fast,并按模型 supportsFastMode 收口):cc 层面为 no-op,不接线,
                // 面板就不显示 Fast 开关,避免「开关能开、提交被丢」的名不副实(codex review)。
                fastMode={deviceId || !(agent === 'codex' || agent === 'pi') ? undefined : fast}
                onFastModeChange={
                  deviceId || !(agent === 'codex' || agent === 'pi') ? undefined : updateFast
                }
              />
            </div>
            {noAvailableLocalModels ? (
              <p className="mt-1.5 text-11 leading-snug text-[var(--error-fg)]" role="status">
                {t('orca.createWorker.noAvailableModels', {
                  agent: agent === 'codex' ? 'Codex' : agent === 'pi' ? 'Pi' : 'Claude Code',
                })}
              </p>
            ) : null}
          </div>
        </div>

        {remoteWorkerPermissionModeUnsupported ? (
          requireWorkerPermissionModeSupport ? (
            <div
              data-testid="worker-permission-mode"
              className="mb-4 rounded-xl border border-[var(--border-default)] px-3.5 py-3"
            >
            <p className="text-12 leading-snug text-[var(--error-fg)]" role="status">
              {t('newChat.collaboration.unsupportedRemoteHint')}
            </p>
            </div>
          ) : null
        ) : (
          <div
            data-testid="worker-permission-mode"
            className="mb-4 grid grid-cols-[minmax(0,1fr)_220px] items-center gap-4 rounded-xl border border-[var(--border-default)] px-3.5 py-3"
          >
            <span className="text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
              {t('orca.createWorker.permissionLabel')}
            </span>
            <PermissionSelector
              permissionMode={selectedWorkerPermissionMode}
              onPermissionModeChange={(mode) =>
                void updateWorkerPermissionMode(mode as OrcaWorkerPermissionMode)
              }
              vendorKey={vendorKey}
              deviceId={deviceId}
              triggerVariant="field"
              dense
              ariaContext={t('orca.createWorker.permissionLabel')}
              allowedModes={
                supportsWorkerPermissionModeSelection
                  ? ORCA_WORKER_PERMISSION_MODES
                  : AUTO_ONLY_WORKER_PERMISSION_MODES
              }
            />
          </div>
        )}

        <div className="mb-5">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {t('orca.createWorker.initialTaskLabel')}{' '}
            <span className="font-normal normal-case tracking-normal">
              {t('orca.createWorker.optional')}
            </span>
          </div>
          <textarea
            className="h-[96px] w-full resize-none rounded-xl border border-[var(--border-default)] bg-transparent px-3.5 py-2.5 text-13 leading-snug text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            placeholder={t('orca.createWorker.initialTaskPlaceholder')}
            value={initialTask}
            onChange={(e) => setInitialTask(e.target.value)}
          />
        </div>

        <button
          type="button"
          className={cn(
            'w-full rounded-full py-3 text-14 font-medium leading-none transition-colors',
            canCreate
              ? 'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]'
              : 'bg-[var(--surface-chip)] text-[var(--text-tertiary)] cursor-not-allowed',
          )}
          disabled={!canCreate}
          aria-busy={isSubmitting}
          onClick={handleCreate}
        >
          {resolvedSubmitLabel}
        </button>
      </div>
    </div>
  );
}
