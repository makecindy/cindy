import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import {
  connectedProvidersForAgent,
  modelSupportsFastMode,
  providerOffersModel,
} from '@cindy/model-providers';

import { FastModeToggle } from '@/components/new-chat/FastModeToggle';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { cn } from '@/lib/utils';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import {
  getProviderModelEffort,
  getProviderModelFast,
  setProviderModelChoice,
  setProviderModelEffort,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import type { Effort } from '@/lib/userPreferences.types';
import { selectWorkerModels } from './workerModelAvailability';

const PREDEFINED_ROLES = ['developer', 'designer', 'reviewer', 'tester', 'merger'] as const;
const PREFS_KEY = 'workerCreationPrefs';

interface WorkerAgentPrefs {
  model: string;
  effort: Effort;
  fast: boolean;
  /** 上次显式选定的模型来源;null = 未显式选择(跟随默认路由解析)。 */
  providerId: string | null;
}

interface WorkerPrefs {
  lastAgent: 'codex' | 'claude-code';
  codex: WorkerAgentPrefs;
  'claude-code': WorkerAgentPrefs;
}

const DEFAULT_PREFS: WorkerPrefs = {
  lastAgent: 'codex',
  codex: { model: 'codex/gpt-5.5', effort: 'high', fast: false, providerId: null },
  'claude-code': { model: 'claude-opus-4-7', effort: 'high', fast: false, providerId: null },
};

function readWorkerPrefs(): WorkerPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<WorkerPrefs>;
    const agentPrefs = (agent: 'codex' | 'claude-code'): WorkerAgentPrefs => {
      const p = parsed[agent];
      return {
        ...DEFAULT_PREFS[agent],
        ...(p ?? {}),
        fast: p?.fast === true,
        // 老版本 prefs 无此字段 → null(未显式);非法类型同样回落。
        providerId: typeof p?.providerId === 'string' && p.providerId ? p.providerId : null,
      };
    };
    return {
      lastAgent: parsed.lastAgent === 'claude-code' ? 'claude-code' : 'codex',
      codex: agentPrefs('codex'),
      'claude-code': agentPrefs('claude-code'),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeWorkerPrefs(prefs: WorkerPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage can be unavailable in restricted contexts; prefs are best-effort.
  }
}

export interface CreateWorkerForm {
  role: string;
  agent: 'claude-code' | 'codex';
  model: string;
  effort?: Effort;
  fast?: boolean;
  /** 显式选定的模型来源;null = 未显式,由 main 侧按默认路由解析。 */
  providerId: string | null;
  initialTask: string;
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
}

export function CreateWorkerPopover({
  open,
  onClose,
  onCreate,
  title,
  submitLabel,
  className,
  deviceId,
}: CreateWorkerPopoverProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [role, setRole] = useState('developer');
  const [customRole, setCustomRole] = useState('');
  const [agent, setAgent] = useState<'claude-code' | 'codex'>('codex');
  const [model, setModel] = useState(DEFAULT_PREFS.codex.model);
  const [effort, setEffort] = useState<Effort>(DEFAULT_PREFS.codex.effort);
  const [fast, setFast] = useState(DEFAULT_PREFS.codex.fast);
  // 显式选定的模型来源(标准面板供应商分段);null = 未显式。device-link 远程创建
  // 面板退化为被控端纯列表(无来源维度),恒为 null。
  const [providerSource, setProviderSource] = useState<string | null>(null);
  const [initialTask, setInitialTask] = useState('');
  const [prefs, setPrefs] = useState<WorkerPrefs>(DEFAULT_PREFS);
  const [prefsRestored, setPrefsRestored] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const ccCaps = useAgentCapabilities('claude-code', deviceId);
  const codexCaps = useAgentCapabilities('codex', deviceId);
  const localProviders = useProviders();
  const remoteProviders = useDeviceProviders(deviceId);
  const providers = deviceId ? remoteProviders.providers : localProviders.providers;
  const providersLoading = deviceId ? remoteProviders.loading : localProviders.loading;
  const providersError = deviceId ? remoteProviders.error : null;
  const visibilityVersion = useModelVisibilityVersion();
  const activeCapabilitiesState = agent === 'codex' ? codexCaps : ccCaps;
  const activeCaps = activeCapabilitiesState.capabilities;
  const activeModels = useMemo(() => {
    return selectWorkerModels({
      agent,
      capabilities: activeCaps,
      deviceId,
      providers,
      providersLoading,
      providersError,
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
    visibilityVersion,
  ]);
  const currentModel = activeModels.find((m) => m.id === model);
  const modelCatalogLoading = activeCapabilitiesState.loading || providersLoading;

  // per-provider Fast 能力:同一 model id 在不同来源下 supportsFastMode 可不同(见
  // CatalogModel),显式选了来源就按该来源自己的条目查;未显式(默认路由)/device-link
  // 回落拍平并集值(与既有行为一致)。
  const providerFastSupported = useCallback(
    (candidate: string | null, modelId: string): boolean => {
      if (!deviceId && candidate) {
        const provider = connectedProvidersForAgent(providers, agent).find(
          (p) => p.id === candidate,
        );
        return modelSupportsFastMode(provider, modelId, agent);
      }
      return !!activeModels.find((m) => m.id === modelId)?.supportsFastMode;
    },
    [activeModels, agent, deviceId, providers],
  );
  const currentModelSupportsFast = Boolean(
    agent === 'codex' && activeCaps?.hasFastMode && providerFastSupported(providerSource, model),
  );
  const noAvailableLocalModels =
    prefsRestored &&
    !deviceId &&
    !modelCatalogLoading &&
    (activeCaps !== null || activeCapabilitiesState.error !== null) &&
    activeModels.length === 0;

  // 显式来源仅在「已连接且确实提供该模型」时有效;其余(断开/下架/换了模型)收窄为
  // null 交回默认路由解析。与 SubagentModelSection / ImDefaultSettingsSection 同规则,
  // 防止提交「选 A 落 B」的不可能组合。device-link 无本地来源维度,恒 null。
  const narrowProviderSource = useCallback(
    (candidate: string | null, modelId: string): string | null => {
      if (!candidate || deviceId) return null;
      const provider = connectedProvidersForAgent(providers, agent).find(
        (p) => p.id === candidate,
      );
      return provider && providerOffersModel(provider, modelId, agent) ? candidate : null;
    },
    [agent, deviceId, providers],
  );

  // 打开弹窗时恢复上次选择；initial task 不记忆，避免把旧任务误带到下一次创建。
  useEffect(() => {
    if (!open) {
      setPrefsRestored(false);
      return;
    }
    const stored = readWorkerPrefs();
    const agentPrefs = stored[stored.lastAgent];
    setPrefs(stored);
    setAgent(stored.lastAgent);
    setModel(agentPrefs.model);
    setEffort(agentPrefs.effort);
    setFast(agentPrefs.fast);
    setProviderSource(deviceId ? null : agentPrefs.providerId);
    setInitialTask('');
    setPrefsRestored(true);
  }, [deviceId, open]);

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
    if (selected.efforts.length > 0 && !selected.efforts.includes(effort)) {
      setEffort(selected.defaultEffort ?? selected.efforts[selected.efforts.length - 1]);
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
  ]);

  useEffect(() => {
    if (currentModel && !currentModelSupportsFast && fast) {
      setFast(false);
    }
  }, [currentModel, currentModelSupportsFast, fast]);

  const vendorKey = agent === 'codex' ? 'codex' : 'cc';
  const updateAgent = useCallback(
    (nextAgent: 'claude-code' | 'codex') => {
      setAgent(nextAgent);
      const remembered = prefs[nextAgent];
      setModel(remembered.model);
      setEffort(remembered.effort);
      setFast(remembered.fast);
      setProviderSource(deviceId ? null : remembered.providerId);
    },
    [deviceId, prefs],
  );

  const updateModel = useCallback(
    (nextModel: string) => {
      setModel(nextModel);
      const available = activeModels.find((m) => m.id === nextModel);
      if (available && available.efforts.length > 0 && !available.efforts.includes(effort)) {
        setEffort(available.defaultEffort ?? available.efforts[available.efforts.length - 1]);
      }
      if (!available?.supportsFastMode) {
        setFast(false);
      }
      // 仅换模型:当前显式来源不提供新模型时收窄,避免形成不可能组合。
      setProviderSource((prev) => narrowProviderSource(prev, nextModel));
    },
    [activeModels, effort, narrowProviderSource],
  );

  // 分段行原子选择 (来源, 模型):与 composer 的 handleProviderChange 同语义。
  // 面板选行只回传 (providerId, modelId) 两参,目标模型记忆的 effort/Fast 要在这里
  // 主动从模型级全局预设恢复(codex review:否则用户在非选中行 hover 配置的
  // effort/Fast 在选中该行后被丢弃);Fast 还要叠加该来源条目的 per-provider 能力。
  const handleProviderChange = useCallback(
    (providerId: string | null, modelId?: string, reconciledEffort?: Effort) => {
      const nextModel = modelId ?? model;
      const narrowed = narrowProviderSource(providerId, nextModel);
      setProviderSource(narrowed);
      if (!modelId) return;
      setModel(modelId);
      const available = activeModels.find((m) => m.id === modelId);
      if (!available) return;
      const remembered =
        reconciledEffort ??
        (providerId ? getProviderModelEffort(agent, providerId, modelId) : undefined);
      if (remembered && available.efforts.includes(remembered)) {
        setEffort(remembered);
      } else if (available.efforts.length > 0 && !available.efforts.includes(effort)) {
        setEffort(available.defaultEffort ?? available.efforts[available.efforts.length - 1]);
      }
      if (!providerFastSupported(narrowed, modelId)) {
        setFast(false);
      } else {
        const rememberedFast = providerId
          ? getProviderModelFast(agent, providerId, modelId)
          : undefined;
        if (rememberedFast !== undefined) setFast(rememberedFast);
      }
    },
    [activeModels, agent, effort, model, narrowProviderSource, providerFastSupported],
  );

  const updateEffort = setEffort;

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
    !!currentModel;
  const resolvedTitle = title ?? t('orca.createWorker.title');
  const resolvedSubmitLabel = submitLabel ?? t('orca.createWorker.submit');

  const handleCreate = useCallback(async () => {
    if (!canCreate || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    // 提交前对 (来源, 模型) 再收窄一次:收敛 effect 与提交之间目录可能已变化。
    const submitProviderId = narrowProviderSource(providerSource, model);
    const nextPrefs: WorkerPrefs = {
      ...prefs,
      lastAgent: agent,
      [agent]: {
        model,
        effort,
        fast,
        // device-link 创建不覆盖本地来源记忆(远程面板没有来源维度)。
        providerId: deviceId ? prefs[agent].providerId : submitProviderId,
      },
    };
    setPrefs(nextPrefs);
    writeWorkerPrefs(nextPrefs);
    try {
      await onCreate({
        role: activeRole,
        agent,
        model,
        effort: currentModel && currentModel.efforts.length > 0 ? effort : undefined,
        fast: currentModelSupportsFast ? fast : undefined,
        providerId: submitProviderId,
        initialTask,
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
  ]);

  if (!open) return null;

  return (
    <div className={cn('fixed inset-0 z-50 flex items-start justify-center pt-[10vh]', className)}>
      <div className="absolute inset-0 bg-[var(--overlay-modal)]" onClick={onClose} />
      <div
        className="relative z-10 w-[500px] rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6"
        style={{ boxShadow: 'var(--shadow-menu)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <span className="text-17 font-medium text-[var(--text-primary)]">{resolvedTitle}</span>
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
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {t('orca.createWorker.roleLabel')}
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

        <div className="mb-4">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {t('orca.createWorker.agentLabel')}
          </div>
          {/* 应用标准 Agent 分段控件(替换此前手写的按钮组;与 New Maker / IM 目录偏好同款,
              「不自建选择 UI」的组件复用原则)。 */}
          <VendorSegmentedSwitcher
            value={vendorKey}
            width={220}
            ariaLabel={t('orca.createWorker.agentLabel')}
            onChange={(next) => updateAgent(next === 'codex' ? 'codex' : 'claude-code')}
          />
        </div>

        <div className="mb-4">
          <div className="mb-2 text-12 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {t('orca.createWorker.modelLabel')}
          </div>
          {/* composer 同款全功能标准面板(2026-07 用户定稿基准:全软件一个模型选择面板,
              处处同行为):供应商分段、订阅来源、推理强度、Fast(行级配置列,替代此前的
              外置开关)全开;选定来源随创建参数显式下发,由 OrcaWorkerCreationService
              精确 preflight。device-link 远程创建维持既有退化:被控端纯列表、无来源维度,
              且面板行级 Fast 依赖来源分段(fastEditable 走 connected 目录),故远程仍用
              外置 FastModeToggle,不能删。 */}
          <div className="flex items-center gap-2">
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
              popoverSide="bottom"
              currentProviderId={deviceId ? undefined : providerSource}
              onProviderChange={deviceId ? undefined : handleProviderChange}
              // providerSource=null 时面板高亮的是**解析出来的生效默认来源**,点它的
              // 语义是「把默认来源钉成显式偏好」,必须照常回调(codex review)——否则
              // 用户点了没反应,之后默认路由一变创建就静默换来源。显式同值幂等无害。
              reselectEmitsChange
              onNavigateToProviders={
                deviceId
                  ? undefined
                  : () => {
                      onClose();
                      navigate('/settings?tab=providers');
                    }
              }
              modelMemory={modelMemory}
              // worker 创建链的显式 Fast 派发目前仅 Codex(resolveWorkerConfig 只对
              // codex 消费 input.fast):cc 不接线,面板就不显示 Fast 开关,避免
              // 「开关能开、提交被丢」的名不副实(codex review)。
              fastMode={deviceId || agent !== 'codex' ? undefined : fast}
              onFastModeChange={
                deviceId || agent !== 'codex' ? undefined : (enabled) => setFast(enabled)
              }
            />
          </div>
          {noAvailableLocalModels ? (
            <p className="mt-1.5 text-11 leading-snug text-[var(--error-fg)]" role="status">
              {t('orca.createWorker.noAvailableModels', {
                agent: agent === 'codex' ? 'Codex' : 'Claude Code',
              })}
            </p>
          ) : null}
        </div>

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
