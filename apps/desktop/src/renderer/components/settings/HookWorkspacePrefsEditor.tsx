/**
 * HookWorkspacePrefsEditor —— 「项目与模型」区块里每个项目内嵌的偏好编辑行。
 *
 * 由 HookConnectionsSection 在每个项目下渲染: 模型(含 Agent、来源、思考强度) / 权限模式。
 * 这一份是所有官方机器人(飞书 / Telegram / Slack / X)共用的, 不按机器人各配一遍。
 *
 * **两个控件一律复用应用标准选择器, 本文件不自建任何选择 UI**:
 *   - 模型 -> ModelSelector 的 field trigger, composer 同款全功能形态(供应商分段 / 订阅来源 /
 *            推理强度全开; 全软件一个模型选择面板, 处处同行为, 差异只有样式)。
 *            Agent 与模型一次提交, 思考强度并进模型 trigger 显示成「模型名 · 档位」。
 *   - 权限 -> PermissionSelector 的 field trigger
 *
 * 未显式设置的字段**解析出当前真正会生效的默认值**直接展示, 界面上不暴露「默认」概念;
 * 选中任一项即写显式偏好。解析链与 main 侧 defaults.ts 逐字段对齐(resolveEffectiveRow,
 * 纯函数有单测), 数据源是 imDefaultSettingsGet 的 global 那份 + 本机 capabilities。权限档另经
 * resolveEffectivePermissionMode 校准: 无显式偏好 -> bypassPermissions(无人值守历史默认),
 * 显式档不被当前 agent 支持 -> 该 agent 最严档(绝不放宽)。
 *
 * 数据正本在本机(hook-workspace-prefs.json 里渠道键为 shared 的行), 设置页随时可读可写,
 * 不依赖任何机器人是否连着; main 侧把它镜像给各渠道的服务端, 在 IM 里用 /model 卡改的也会
 * 并回这一份。写入的联动校准仍走 hookWorkspacePrefsLogic.ts。颜色一律走主题 token。
 */

import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { useAgentCapabilities, type AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { agentDeviceModelMemoryAccessors } from '@/state/agentDeviceModelMemory';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import type { MakerVendor } from '@/lib/ccAgent.types';
import {
  getProviderModelEffort,
  setProviderModelChoice,
  setProviderModelEffort,
  getProviderModelFast,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import type {
  HookPrefsPatch,
  HookWorkspacePrefs,
  HookWorkspaceProviderSourceEntry,
} from '../../../shared/hookControlIpc';
import type { ImDefaultSettingsState } from '../../../shared/imDefaultSettings';
import {
  AGENT_KINDS,
  HOOK_DEFAULT_PERMISSION_MODE,
  isKnownAgent,
  patchForModelChange,
  resolveEffectiveRow,
  type ImDefaultsLike,
  type KnownAgent,
  type PrefsAgentCaps,
} from './hookWorkspacePrefsLogic';

/** 全 null 的缺省偏好行(该目录从未设置过)。 */
function emptyPrefs(workspace: string): HookWorkspacePrefs {
  return { workspace, model: null, effort: null, agentKind: null, permissionMode: null };
}

function toPrefsCaps(caps: AgentCapabilities | null): PrefsAgentCaps | null {
  if (caps === null) return null;
  return {
    models: caps.availableModels.map((m) => ({
      id: m.id,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    })),
    permissionModes: caps.permissionModes.map((pm) => ({ id: pm.id })),
  };
}

export interface HookWorkspacePrefsState {
  /** 按别名查该目录偏好(无行返回全 null 缺省; multi-team 下按选中 team 过滤)。 */
  prefsFor: (alias: string) => HookWorkspacePrefs;
  /** 目录显式来源优先，否则继承当前引擎的 IM 默认来源。 */
  providerSourceFor: (alias: string) => string | null;
  agentDeviceFor: (alias: string) => string | null;
  /** 写/清该目录的模型来源偏好(providerId = null 清除)。 */
  applyProviderSource: (alias: string, providerId: string | null, agentDeviceId?: string | null) => Promise<boolean>;
  /** 是否可编辑(本机快照已读到)。 */
  editable: boolean;
  /** 写入在途的目录别名(该卡片下拉禁用)。 */
  pendingWs: string | null;
  /** 不可编辑的原因提示(null = 无需提示); 宿主渲染一次。 */
  hint: string | null;
  /** hint 为「服务器过旧」时提供的重试入口(其余为 null)。 */
  retry: (() => void) | null;
  /** 桌面新会话默认设置(解析「当前生效默认值」的数据源; 未就绪为 null)。 */
  imDefaults: ImDefaultsLike | null;
  /** 重新拉取 imDefaults(存量 global override 被清掉后刷新目录行的生效值)。 */
  reloadImDefaults: () => Promise<void>;
  /** alsoProviderSource: 远端写成功后串联落本地来源(undefined = 不动来源)。 */
  applyPatch: (
    workspace: string,
    patch: HookPrefsPatch,
    alsoProviderSource?: string | null,
    agentDeviceId?: string | null,
  ) => Promise<boolean>;
}

/** 共用配置在来源偏好文件里的渠道键(与 main 侧 SHARED_PREFS_CHANNEL 一致)。 */
const SHARED_SOURCE_CHANNEL = 'shared';

/**
 * 项目偏好共享状态(单订阅): 拉取 / 写入 / 推送同步。
 *
 * 所有官方机器人(飞书 / Telegram / Slack / X)共用一份 —— 设置页只读写这一份, main 侧
 * 把它投影到各渠道并镜像给各自的服务端; 在 IM 里用 /model 卡改的也会并回这一份再推过来。
 * 正本在本机文件, 不依赖任何渠道是否连着, 所以始终可编辑。
 */
export function useHookWorkspacePrefs(): HookWorkspacePrefsState {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<HookWorkspacePrefs[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pendingWs, setPendingWs] = useState<string | null>(null);
  const [imDefaults, setImDefaults] = useState<ImDefaultsLike | null>(null);
  // 项目模型来源偏好(纯本地文件): 全量条目一次拉取, 写后用返回值刷新。
  const [providerSources, setProviderSources] = useState<HookWorkspaceProviderSourceEntry[]>([]);
  // latest-wins 守卫: 快速连选 / 跨窗口广播时, 较慢的旧回复不得覆盖新状态。
  const providerSourceRevisionRef = useRef(0);
  const fetchRevisionRef = useRef(0);
  const mutationRevisionRef = useRef(0);

  /** 没单独配置过的字段按「IM 新任务默认」(global 那份)解析, 与派发侧同源。 */
  const fetchImDefaults = useCallback(async (): Promise<void> => {
    try {
      const state: ImDefaultSettingsState = await window.electronAPI.maker.imDefaultSettingsGet(undefined);
      setImDefaults({ agentKind: state.agentKind, agents: state.agents });
    } catch {
      /* 读不到就保持上一份(解析退回内置默认), 不影响其它字段 */
    }
  }, []);

  const fetchPrefs = useCallback(async () => {
    const revision = ++fetchRevisionRef.current;
    try {
      const res = await window.electronAPI.hookControl.getSharedProjectPrefs();
      if (revision !== fetchRevisionRef.current) return;
      setPrefs(res.prefs.prefs);
      setLoadError(false);
    } catch {
      if (revision === fetchRevisionRef.current) setLoadError(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    // IM 里 /model 卡的改动 / 其它窗口的写入: 全量快照 latest-wins。
    const offPrefs = window.electronAPI.hookControl.onSharedProjectPrefsChanged((view) => {
      fetchRevisionRef.current += 1;
      setPrefs(view.prefs);
      setLoadError(false);
    });
    void fetchPrefs();
    void fetchImDefaults();
    const initialSourcesRevision = providerSourceRevisionRef.current;
    void window.electronAPI.hookControl
      .getWorkspaceProviderSources()
      .then((res) => {
        if (active && providerSourceRevisionRef.current === initialSourcesRevision) {
          setProviderSources(res.entries);
        }
      })
      .catch(() => {});
    const offProviderSources = window.electronAPI.hookControl.onWorkspaceProviderSourcesChanged(
      (entries) => {
        providerSourceRevisionRef.current += 1;
        setProviderSources(entries);
      },
    );
    return () => {
      active = false;
      fetchRevisionRef.current += 1;
      mutationRevisionRef.current += 1;
      offPrefs();
      offProviderSources();
    };
  }, [fetchPrefs, fetchImDefaults]);

  const prefsFor = useCallback(
    (alias: string): HookWorkspacePrefs =>
      (prefs ?? []).find((entry) => entry.workspace === alias) ?? emptyPrefs(alias),
    [prefs],
  );

  // 与派发端同口径: 项目有显式来源时整组覆盖(缺省位置表示明确选本机),
  // 没有才继承该引擎的默认来源及执行位置, 不能逐字段混用。
  const providerRouteFor = useCallback((alias: string) => {
    const entry = providerSources.find(
      (e) => e.channel === SHARED_SOURCE_CHANNEL && e.workspace === alias,
    );
    if (entry) return entry;
    const agentKind = prefsFor(alias).agentKind;
    return imDefaults?.agents[isKnownAgent(agentKind) ? agentKind : imDefaults.agentKind] ?? null;
  }, [providerSources, prefsFor, imDefaults]);
  const providerSourceFor = useCallback((alias: string): string | null =>
    providerRouteFor(alias)?.providerId ?? null, [providerRouteFor]);
  const agentDeviceFor = useCallback((alias: string): string | null =>
    providerRouteFor(alias)?.agentDeviceId ?? null, [providerRouteFor]);

  const applyProviderSource = useCallback(
    (alias: string, providerId: string | null, agentDeviceId?: string | null) => {
      const revision = ++providerSourceRevisionRef.current;
      return window.electronAPI.hookControl
        .setWorkspaceProviderSource({ channel: SHARED_SOURCE_CHANNEL, teamId: null, workspace: alias, providerId,
          ...(agentDeviceId !== undefined ? { agentDeviceId } : {}) })
        .then((res) => {
          if (revision === providerSourceRevisionRef.current) setProviderSources(res.entries);
          return true;
        })
        .catch((err: unknown) => {
          if (revision === providerSourceRevisionRef.current) {
            toast.error(extractIpcError(err)?.message ?? t('settings.tina.prefs.toast.saveFailed'));
          }
          return false;
        });
    },
    [t],
  );

  const applyPatch = useCallback(
    // alsoProviderSource(可选): 偏好写成功后再落来源 —— 两个持久面串联而非并行, 偏好写失败时
    // 来源不动, 状态与操作前一致。
    (workspace: string, patch: HookPrefsPatch, alsoProviderSource?: string | null, agentDeviceId?: string | null) => {
      // 推送、重试或更新的一次写入必须压过这次的回执, 否则迟到的回执会把界面滚回旧快照。
      const revision = ++fetchRevisionRef.current;
      const mutationRevision = ++mutationRevisionRef.current;
      setPendingWs(workspace);
      return window.electronAPI.hookControl
        .setSharedProjectPrefs(workspace, patch)
        .then(async (res) => {
          // 来源落地在快照守卫之前: 写入已成功这件事不因「更新的快照先到」而失效。
          if (alsoProviderSource !== undefined) {
            if (!await applyProviderSource(workspace, alsoProviderSource, agentDeviceId)) return false;
          }
          if (revision !== fetchRevisionRef.current) return true;
          fetchRevisionRef.current += 1;
          setPrefs(res.prefs.prefs);
          setLoadError(false);
          return true;
        })
        .catch((err: unknown) => {
          if (revision !== fetchRevisionRef.current) return false;
          toast.error(extractIpcError(err)?.message ?? t('settings.tina.prefs.toast.saveFailed'));
          void fetchPrefs();
          return false;
        })
        .finally(() => {
          if (mutationRevision === mutationRevisionRef.current) setPendingWs(null);
        });
    },
    [fetchPrefs, t, applyProviderSource],
  );

  return {
    prefsFor,
    providerSourceFor,
    agentDeviceFor,
    applyProviderSource,
    editable: prefs !== null && !loadError,
    pendingWs,
    hint: loadError ? t('settings.tina.prefs.loadFailed') : null,
    retry: loadError ? () => void fetchPrefs() : null,
    imDefaults,
    reloadImDefaults: fetchImDefaults,
    applyPatch,
  };
}

/** 字段外框:标题 + 控件,三个字段共用,保证 label 排版一致。 */
function PrefsField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    // 字段名只给读屏: 每个项目一行, 控件本身(模型名 / 权限档 + 图标)已经说明了自己是什么,
    // 每行再重复一遍「模型」「权限模式」只会把列表拉长。
    <div className={cn('flex min-w-0 flex-col', className)}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** hook prefs 的 agentKind → 选择器的 vendor key。 */
function toVendorKey(agentKind: string | null): 'cc' | 'codex' | 'pi' {
  return agentKind === 'codex' || agentKind === 'pi' ? agentKind : 'cc';
}

/** 目录卡片内的偏好编辑行(完整模型配置 / 权限)。alias 为该行当前生效别名。 */
export function WorkspacePrefsEditor({
  alias,
  state,
  maxVisibleModelRows,
}: {
  alias: string;
  state: HookWorkspacePrefsState;
  maxVisibleModelRows?: number;
}) {
  const { t } = useTranslation();
  const agentDeviceId = state.agentDeviceFor(alias);
  const routeDevices = useModelRouteDevices({ controlledDeviceId: null, leadAgentDeviceId: agentDeviceId });
  const claudeCaps = useAgentCapabilities('claude-code', agentDeviceId ?? undefined);
  const codexCaps = useAgentCapabilities('codex', agentDeviceId ?? undefined);
  const piCaps = useAgentCapabilities('pi', agentDeviceId ?? undefined);
  const capsByAgent = useMemo(
    () =>
      ({
        'claude-code': claudeCaps.capabilities,
        codex: codexCaps.capabilities,
        pi: piCaps.capabilities,
      }) as Record<KnownAgent, AgentCapabilities | null>,
    [claudeCaps.capabilities, codexCaps.capabilities, piCaps.capabilities],
  );
  const capsOf = useCallback(
    (agentKind: string): AgentCapabilities | null =>
      AGENT_KINDS.includes(agentKind as KnownAgent) ? capsByAgent[agentKind as KnownAgent] : null,
    [capsByAgent],
  );

  const prefs = state.prefsFor(alias);
  const eff = resolveEffectiveRow(prefs, state.imDefaults, (k) => toPrefsCaps(capsOf(k)));
  const effAgentCaps = capsOf(eff.agentKind.id ?? '');
  const disabled = !state.editable || state.pendingWs === alias;
  const vendorKey = toVendorKey(eff.agentKind.id);

  const pickerAgents = useModelPickerAgents(vendorKey === 'cc' ? 'claude-code' : vendorKey === 'pi' ? 'pi' : 'codex', agentDeviceId);

  /** 落一个模型选择(分段行与 flat 行共用): 随手写入 (agent, model) 配对并校准 effort。 */
  const applyModel = (next: string) => {
    if (next === prefs.model || eff.agentKind.id === null) return;
    return state.applyPatch(
      alias,
      patchForModelChange(eff.agentKind.id, next, prefs, toPrefsCaps(effAgentCaps)),
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 模型 + 思考强度同一个控件, **composer 同款全功能标准面板**(2026-07 用户
          定稿基准: 全软件一个模型选择面板, 处处同行为, 差异只有样式):供应商分段、
          订阅来源、推理强度全开。来源(providerId)是纯客户端维度, 落本地
          workspaceProviderSourceStore; model/effort 照旧走 server prefs 通道
          (Slack /model 卡展示不受影响)。派发侧按 (来源, 模型) 经
          effectiveSourceIdForModel 校验: 显式来源失效时拒绝而不换账号; 目录模型
          跟随默认时, 不提供该模型的残留来源被忽略(issue #5912), 不会拼出不可能
          路由 —— 「选 A 落 B」的根因(选了来源没地方存)已消除。 */}
      <PrefsField label={t('settings.tina.prefs.modelLabel')} className="flex-1 basis-[200px]">
        <ModelSelector
          remoteAgent={routeDevices.devices && { devices: routeDevices.devices, selectedDeviceId: agentDeviceId }}
          fastModeConfigurable={false}
          unifiedAgents={pickerAgents}
          onUnifiedSelect={({ engine, modelId, providerId, effort, agentDevice }) => state.applyPatch(
            alias,
            { agentKind: engine === 'cc' ? 'claude-code' : engine, model: modelId, effort: effort || null },
            providerId,
            agentDevice?.deviceId ?? null,
          )}
          modelId={eff.model.id ?? ''}
          effort={eff.effort.id ?? ''}
          vendorKey={vendorKey}
          triggerVariant="field"
          popoverSide="bottom"
          maxVisibleModelRows={maxVisibleModelRows}
          dense
          // 可及名上下文与 agent 分段同规则(字段名 · 行别名),多卡片同屏读屏可区分。
          ariaContext={`${t('settings.tina.prefs.modelLabel')} · ${alias}`}
          // 当前 Harness 的能力加载失败也能改选其它可用 Harness。
          disabled={disabled}
          // 这一行的 modelId 可能是**解析出来的继承值**(prefs.model 为 null 时来自 IM
          // 新会话默认), 点它的语义是「把继承值钉成本目录的显式偏好」, 必须照常回调 ——
          // 否则用户点了没反应, 之后上游默认一变这条偏好就被静默改掉。
          reselectEmitsChange
          // 已存模型不在可见清单(被隐藏 / 供应商断开 / 目录下架)时显示裸 id 而非
          // 「选择模型」占位符: 占位符会把「存过但当前不可用」显示成「没选过」, 用户
          // 既看不到自己存的是什么、也无从判断为何 bot 用的不是它。与本组件接管前
          // (PrefsSelect 的 modelLabel 回落裸 id)行为一致; 派发侧另有回落并记日志。
          unknownModelLabel={(id) => id}
          // 非选中行 hover 配置(推理强度/Fast)与 composer 共用同一份模型级全局预设。
          modelMemory={agentDeviceId ? agentDeviceModelMemoryAccessors(agentDeviceId) : {
            getEffort: getProviderModelEffort,
            setEffort: setProviderModelEffort,
            setChoice: setProviderModelChoice,
            getFast: getProviderModelFast,
            setFast: setProviderModelFast,
          }}
          currentProviderId={state.providerSourceFor(alias)}
          // 分段行原子选择:model/effort 走远端 prefs,成功后来源落本地(串联,
          // 见 applyPatch 的 alsoProviderSource 注释)。目标行的 provider-specific
          // effort 由共享 ModelSelector 回传;旧调用方未提供时才回落本地记忆。
          onProviderChange={(providerId, modelId, reconciledEffort) => {
            if (eff.agentKind.id === null) return false;
            const caps = toPrefsCaps(effAgentCaps);
            if (modelId) {
              const patch = patchForModelChange(eff.agentKind.id, modelId, prefs, caps);
              if (reconciledEffort !== undefined) {
                patch.effort = reconciledEffort || null;
              } else {
                const remembered =
                  providerId && isKnownAgent(eff.agentKind.id)
                    ? getProviderModelEffort(eff.agentKind.id, providerId, modelId)
                    : undefined;
                if (
                  remembered &&
                  caps?.models.find((m) => m.id === modelId)?.efforts.includes(remembered)
                ) {
                  patch.effort = remembered;
                }
              }
              return state.applyPatch(alias, patch, providerId, agentDeviceId);
            } else {
              void state.applyProviderSource(alias, providerId, agentDeviceId);
            }
          }}
          onModelChange={applyModel}
          onEffortChange={(next) => {
            if (next !== prefs.effort) return state.applyPatch(alias, { effort: next });
          }}
        />
      </PrefsField>
      <PrefsField label={t('settings.tina.prefs.permissionLabel')} className="basis-[148px]">
        <PermissionSelector
          permissionMode={eff.permissionMode.id ?? HOOK_DEFAULT_PERMISSION_MODE}
          vendorKey={vendorKey}
          triggerVariant="field"
          dense
          // 可及名上下文与 agent 分段同规则(字段名 · 行别名),多卡片同屏读屏可区分。
          ariaContext={`${t('settings.tina.prefs.permissionLabel')} · ${alias}`}
          disabled={disabled || effAgentCaps === null}
          onPermissionModeChange={(next) => {
            if (next !== prefs.permissionMode) state.applyPatch(alias, { permissionMode: next });
          }}
        />
      </PrefsField>
    </div>
  );
}
