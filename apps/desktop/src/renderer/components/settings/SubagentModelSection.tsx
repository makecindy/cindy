/**
 * Settings -> Personalization 的 Subagent 设置:默认模型(Claude Code / Codex)+
 * Codex 子代理护栏(总开关 / Cindy 策略 / 并发上限 / 嵌套开关)。
 *
 * main 进程 JSON store 是事实源;renderer 只展示并通过 IPC 提交覆盖值。
 * codex spawn 注入键的变更可能延迟生效(返回体 codexRestartDeferred=true 时
 * 提示「运行中的 Codex 对话将在任务结束后应用」,与 Memory 设置同款语义)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isModelSelectableForNewRoute,
  visibleModelUnion,
} from '@cindy/model-providers';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { ModelSelector, type ModelMemoryAccessors } from '@/components/new-chat/ModelSelector';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import { createLogger } from '@/lib/logger';
import { deriveModelsFromProviders } from '@/lib/providerModels';
import { toast } from '@/lib/toast';
import {
  clearProviderModelEffort,
  clearProviderModelFast,
  getProviderModelEffort,
  getProviderModelFast,
  setProviderModelEffort,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import {
  CODEX_SUBAGENT_CONCURRENCY_INITIAL,
  CODEX_SUBAGENT_CONCURRENCY_MAX,
  CODEX_SUBAGENT_CONCURRENCY_MIN,
  SUBAGENT_GUARDRAIL_KEYS,
  SUBAGENT_MODEL_CARD_KEYS,
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  isCodexSubagentEffort,
  type CodexSubagentEffort,
  type SubagentModelSettingsPatch,
  type SubagentModelSettingsState,
} from '../../../shared/subagentModelSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('SubagentModelSection');

/**
 * 标准模型面板把非选中行的配置写进模型级全局预设;Subagent 仍把实际派发值
 * 原子落进自己的 settings store。Fast 回调未开启,这里只复用完整适配器契约。
 */
const CODEX_SUBAGENT_MODEL_MEMORY: ModelMemoryAccessors = {
  getEffort: getProviderModelEffort,
  setEffort: setProviderModelEffort,
  getFast: getProviderModelFast,
  setFast: setProviderModelFast,
  // 「恢复推荐」删记忆键(而不是把这一版目录默认快照写回),与标准模型面板同语义。
  clearEffort: clearProviderModelEffort,
  clearFast: clearProviderModelFast,
};

type SubagentAgentKind = 'claude-code' | 'codex';

/** 卡片级恢复默认 = 写该卡全部键的默认值 patch(override store 对等于默认的键做删除)。 */
function defaultsPatchFor(keys: readonly (keyof SubagentModelSettingsPatch)[]): SubagentModelSettingsPatch {
  const patch: SubagentModelSettingsPatch = {};
  for (const key of keys) {
    (patch as Record<string, unknown>)[key] = SUBAGENT_MODEL_SETTINGS_DEFAULTS[key];
  }
  return patch;
}


/** 展示各 Agent 运行时的子代理模型覆盖能力;模型供应商由运行时模型目录决定。 */
export function SubagentModelSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SubagentModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);
  const { providers, loading: providersLoading } = useProviders();
  const codexCaps = useAgentCapabilities('codex');

  // 并发滑杆的本地乐观值:拖动即时反馈,300ms debounce 提交(useCompactionSettings 模式)。
  const [concurrencyDraft, setConcurrencyDraft] = useState<number | null>(null);
  const concurrencyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const concurrencyDraftRef = useRef<number | null>(null);
  concurrencyDraftRef.current = concurrencyDraft;
  const pendingRef = useRef(false);
  const settingsRef = useRef<SubagentModelSettingsState | null>(null);
  settingsRef.current = settings;

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .subagentModelSettingsGet()
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch((err) => {
        log.warn('subagentModelSettingsGet failed', err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const persistPatch = useCallback(
    async (
      patch: SubagentModelSettingsPatch,
      opts?: { successToast?: string; errorToast?: string },
    ): Promise<boolean> => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      try {
        const next = await window.electronAPI.maker.subagentModelSettingsSet(patch);
        setSettings(next);
        // codexRestartDeferred: Codex 正忙时设置已落盘,存活会话等任务结束后自动
        // 换新配置 — 信息性后缀,不用 warning(同 Memory 设置语义)。立即生效路径
        // 无 successToast 时保持静默(与原模型行行为一致)。
        const suffix = next.codexRestartDeferred
          ? t('settings.subagentModels.toast.deferredSuffix')
          : '';
        if (suffix || opts?.successToast) {
          toast.success(`${opts?.successToast ?? t('settings.subagentModels.toast.saved')}${suffix}`);
        }
        return true;
      } catch (err) {
        log.warn('subagentModelSettingsSet failed', err);
        toast.error(
          opts?.errorToast ??
            (err instanceof Error ? err.message : t('settings.subagentModels.saveFailed')),
        );
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [t],
  );

  // 【仅显式选行路径】来源在「已连接且确实提供该模型」时才落库,否则收窄为 null。
  // 选行的候选与本收窄读同一份 providers 快照,面板能点到的行必过校验,无误清风险;
  // 与 ImDefaultSettingsSection.resolveProviderId 同规则。
  // 换模型(onModelChange)路径**不走本收窄**:它携带的是已存来源而非新选择,旧目录
  // 缓存刷新窗口(loading=false 但数据滞后)里收窄会把暂时不可见的有效订阅来源写成
  // null,真实丢数据(greptile 3/5 blocker);而保留原值没有路由危害 —— 子代理派发
  // 通道只带模型 id,providerId 是纯展示/选择维度,组合失配由 sourceDisconnected
  // 断开态可见兜底,用户显式重选即可纠正,不属于静默错误。
  const resolveProviderId = useCallback(
    (agentKind: SubagentAgentKind, modelId: string, providerId: string | null): string | null => {
      if (!providerId) return null;
      const provider = connectedProvidersForAgent(providers, agentKind).find(
        (p) => p.id === providerId,
      );
      if (!provider) return null;
      // 只看 id 是否存在不够(issue #882 第 3 点,2026-07 review 第 18 轮):该来源这份
      // 具体条目若是非聊天类型,不能落成子代理模型的显式来源,否则派发会打进
      // image/audio/embedding 端点。
      const catalogModel = getModel(provider, modelId, agentKind);
      return catalogModel &&
        isModelSelectableForNewRoute(catalogModel, { userProvider: provider.source === 'user' })
        ? providerId
        : null;
    },
    [providers],
  );

  // codex 模型目录(含每模型 efforts):providers 派生优先,目录空时回落运行时能力
  // 快照 —— 与 ImDefaultSettingsSection.modelsByAgent 同规则。
  const codexModels = useMemo(() => {
    const fromProviders = deriveModelsFromProviders(providers, 'codex', { admissionFiltered: true });
    return fromProviders.length ? fromProviders : (codexCaps.capabilities?.availableModels ?? []);
  }, [providers, codexCaps.capabilities]);

  // 选模型时解析成对的 effort:上游只设 default_subagent_model 时子代理 effort 会被
  // 重置为目标模型目录默认档而非继承父级,所以模型与 effort 必须原子成对写入,UI 上
  // 也始终显示一个确定档位。优先保留当前档 → 目录默认档 → 末档(codex-model-discovery
  // 的 fallback 约定)→ 目录无 effort 数据时 null(= 跟随模型默认,注入层跳过)。
  const resolveCodexEffort = useCallback(
    (modelId: string, current: CodexSubagentEffort | null): CodexSubagentEffort | null => {
      const model = codexModels.find((m) => m.id === modelId);
      const efforts = (model?.efforts ?? []).filter(isCodexSubagentEffort);
      if (efforts.length === 0) return null;
      if (current && efforts.includes(current)) return current;
      const def = model?.defaultEffort;
      if (def && isCodexSubagentEffort(def) && efforts.includes(def)) return def;
      return efforts[efforts.length - 1] ?? null;
    },
    [codexModels],
  );

  // (model, providerId) 原子落库:模型与来源是同一次选择的两个维度,分两次写会在
  // 写入间隙出现「新模型 + 旧来源」的不可能组合被派发读到。清除模型时来源一并清除。
  const setClaudeModel = useCallback(
    async (model: string | null, providerId: string | null) => {
      const current = settingsRef.current;
      if (!current) return;
      // providerId 语义由调用方确定:选行路径已按当前目录收窄;换模型路径保留已存
      // 来源原值(见 resolveProviderId 注)。这里只做同值去重,不再二次收窄。
      const nextProviderId = model === null ? null : providerId;
      if (model === current.claudeCode && nextProviderId === current.claudeCodeProviderId) {
        return;
      }
      await persistPatch({ claudeCode: model, claudeCodeProviderId: nextProviderId });
    },
    [persistPatch],
  );

  // Codex 三元组 (model, providerId, effort) 原子落库;「不指定」三键同清,
  // 不给 effort 留孤儿(IPC 层有意不强清 effort,见 shared 契约注释)。
  const setCodexModel = useCallback(
    async (model: string | null, providerId: string | null, reconciledEffort?: string) => {
      const current = settingsRef.current;
      if (!current) return;
      if (model === null) {
        if (current.codex === null && current.codexProviderId === null && current.codexEffort === null) {
          return;
        }
        await persistPatch({ codex: null, codexProviderId: null, codexEffort: null });
        return;
      }
      const nextProviderId = providerId;
      // 标准面板编辑非选中行时会先写模型级预设,再回调选中该行。这里必须优先
      // 读取刚写入的 effort,才能把 (model, providerId, effort) 收敛成一次原子 patch。
      const rememberedEffort = nextProviderId
        ? getProviderModelEffort('codex', nextProviderId, model)
        : undefined;
      // ModelSelector 已按目标来源行的 catalog/记忆解析出统一选择结果；优先消费它，
      // 只有旧调用方未提供第三参时才回落本地记忆/当前值。
      const preferredEffort = reconciledEffort ?? rememberedEffort;
      // 空串是共享选择器对“目标来源不支持 effort”的明确回传，不能被旧 effort 复活。
      const nextEffort = reconciledEffort === ''
        ? null
        : resolveCodexEffort(
          model,
          isCodexSubagentEffort(preferredEffort) ? preferredEffort : current.codexEffort,
        );
      if (
        model === current.codex &&
        nextProviderId === current.codexProviderId &&
        nextEffort === current.codexEffort
      ) {
        return;
      }
      await persistPatch({ codex: model, codexProviderId: nextProviderId, codexEffort: nextEffort });
    },
    [persistPatch, resolveCodexEffort],
  );

  const setCodexEffort = useCallback(
    async (effort: string) => {
      const current = settingsRef.current;
      if (!current || !current.codex) return;
      if (!isCodexSubagentEffort(effort) || effort === current.codexEffort) return;
      const saved = await persistPatch({ codexEffort: effort });
      // 活跃行编辑走 onEffortChange,ModelSelector 不会代写 modelMemory。保存成功后
      // 按选择器同一准入口径解析实际来源并同步全局模型预设;providerId=null 是合法
      // 隐式来源,不能因此漏写,否则切走再切回会恢复旧档位。
      const memoryProviderId = effectiveSourceIdForModel(
        providers,
        current.codexProviderId,
        current.codex,
        'codex',
      );
      if (saved && memoryProviderId) {
        setProviderModelEffort('codex', memoryProviderId, current.codex, effort);
      }
    },
    [persistPatch, providers],
  );

  const resetCard = useCallback(
    async (keys: readonly (keyof SubagentModelSettingsPatch)[]) => {
      setConcurrencyDraft(null);
      if (concurrencyTimer.current) {
        clearTimeout(concurrencyTimer.current);
        concurrencyTimer.current = null;
      }
      await persistPatch(defaultsPatchFor(keys), {
        successToast: t('settings.defaults.restored'),
        errorToast: t('settings.defaults.restoreFailed'),
      });
    },
    [persistPatch, t],
  );

  // ── 并发滑杆:本地乐观 + debounce 提交;卸载 flush 未提交值 ────────────────
  const commitConcurrency = useCallback(() => {
    concurrencyTimer.current = null;
    const current = settingsRef.current;
    const draft = concurrencyDraftRef.current;
    if (!current || draft === null || draft === current.codexMaxConcurrentSubagents) return;
    if (pendingRef.current) {
      // 有写入在飞:短暂重排,不丢拖动终值。
      concurrencyTimer.current = setTimeout(commitConcurrency, 150);
      return;
    }
    void persistPatch({ codexMaxConcurrentSubagents: draft }).then((ok) => {
      // 保存失败(磁盘错误 / owner 切换 / 重启准备失败)时回滚草稿:滑杆回落到
      // 已存值,不让未落盘的值冒充生效 —— 交互已结束,没有定时器会再重试
      // (codex review P2 第 3 轮)。失败原因由 persistPatch 的 error toast 呈现。
      if (!ok) setConcurrencyDraft(null);
    });
  }, [persistPatch]);

  const onConcurrencyDrag = useCallback(
    (value: number) => {
      setConcurrencyDraft(value);
      concurrencyDraftRef.current = value;
      if (concurrencyTimer.current) clearTimeout(concurrencyTimer.current);
      concurrencyTimer.current = setTimeout(commitConcurrency, 300);
    },
    [commitConcurrency],
  );

  // 交互结束(松开拇指 / 按键落定)立即提交,不等 debounce 到点。提交因此总在
  // 组件存活期内发生:失败有 toast、互斥由 commitConcurrency 的 pending 重排保证。
  const onConcurrencyCommit = useCallback(
    (value: number) => {
      setConcurrencyDraft(value);
      concurrencyDraftRef.current = value;
      if (concurrencyTimer.current) clearTimeout(concurrencyTimer.current);
      commitConcurrency();
    },
    [commitConcurrency],
  );

  useEffect(() => {
    return () => {
      // 卸载只取消未到点的 debounce,不做 detached 写入:onValueCommit 已保证
      // 每次交互结束即提交;卸载后再写会越过组件互斥,且 main 侧按请求时刻解析
      // owner-scoped 路径,账号切换触发的卸载会把 A 的草稿写进 B / 登出命名空间
      // (codex review P1)。
      if (concurrencyTimer.current) clearTimeout(concurrencyTimer.current);
    };
  }, []);

  const toggleConcurrencyCustom = useCallback(
    async (next: boolean) => {
      setConcurrencyDraft(null);
      if (concurrencyTimer.current) {
        clearTimeout(concurrencyTimer.current);
        concurrencyTimer.current = null;
      }
      await persistPatch({
        codexMaxConcurrentSubagents: next ? CODEX_SUBAGENT_CONCURRENCY_INITIAL : null,
      });
    },
    [persistPatch],
  );

  if (!settings) return null;

  const unspecifiedLabel = t('settings.subagentModels.unspecified');

  // 已存显式来源当前不可用(目录就绪后判定):断开、或仍连接但目录已不再提供已存
  // 模型,都算——只查 id 会让「掉了该模型的来源」静默换显示,存储值分叉且可静默复活
  // (codex review)。trigger 显示**真实存储来源** + 断开错误态,不回落默认图标。
  const sourceDisconnectedFor = (
    agentKind: SubagentAgentKind,
    model: string | null,
    providerId: string | null,
  ) =>
    Boolean(
      !providersLoading &&
        providerId &&
        !connectedProvidersForAgent(providers, agentKind).some((p) => {
          if (p.id !== providerId) return false;
          if (model === null) return true;
          // 只查 id 会漏掉「该来源这份具体条目已经是非聊天类型」的情况(issue #882
          // 第 3 点,2026-07 review 第 18 轮)——同样算「不可用」,需要断开态提示。
          const catalogModel = getModel(p, model, agentKind);
          return (
            catalogModel !== undefined &&
            isModelSelectableForNewRoute(catalogModel, { userProvider: p.source === 'user' })
          );
        }),
    );
  const claudeSourceDisconnected = sourceDisconnectedFor(
    'claude-code',
    settings.claudeCode,
    settings.claudeCodeProviderId,
  );
  const codexSourceDisconnected = sourceDisconnectedFor(
    'codex',
    settings.codex,
    settings.codexProviderId,
  );

  // 「连接来源」CTA 只在「目录层面零可选模型」时接线:零已连接来源,或来源连接着
  // 但动态模型发现返回空清单 —— 两者面板都是零分段 no-results,需要恢复入口
  // (codex review)。判据是**目录口径**(不带可见性过滤):可见性开关的「全部隐藏」
  // 是被尊重的用户偏好,不是断连故障,按可见并集判空会在该状态下把 stale 模型的
  // 裸 id + 断开态诊断换成误导的「连接来源」trigger(codex review);恢复入口在
  // 可见性设置,与 composer 同口径。反向:仍有目录模型而已存模型 stale 时同样
  // 不接线,保留诊断显示(codex review 前轮)。
  const hasCatalogClaudeModel =
    visibleModelUnion(providers, 'claude-code', () => true).length > 0;
  const hasCatalogCodexModel = visibleModelUnion(providers, 'codex', () => true).length > 0;

  // DefaultOverrideControls 按卡片键组分组判 isCustomized;卡级恢复 = 写该卡全键
  // 默认值 patch(configuration-and-overrides §4 的「相应粒度恢复入口」)。
  const modelCardCustomized = settings.customizedKeys.some((key) =>
    (SUBAGENT_MODEL_CARD_KEYS as readonly string[]).includes(key),
  );
  const guardrailCustomized = settings.customizedKeys.some((key) =>
    (SUBAGENT_GUARDRAIL_KEYS as readonly string[]).includes(key),
  );

  const subagentsEnabled = settings.codexSubagentsEnabled;
  const concurrencyCustomized = settings.codexMaxConcurrentSubagents !== null;
  const concurrencyValue =
    concurrencyDraft ?? settings.codexMaxConcurrentSubagents ?? CODEX_SUBAGENT_CONCURRENCY_INITIAL;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.subagentModels.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.subagentModels.description')}
        </p>
      </div>

      {/* ── 卡 1:默认模型 ─────────────────────────────────────────────── */}
      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex w-[150px] shrink-0 items-center gap-2">
            <ClaudeMark size={16} className="text-[var(--text-secondary)]" />
            <span className="text-14 font-medium text-[var(--text-primary)]">Claude Code</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 flex-1">
              {/* composer 同款全功能标准面板(2026-07 用户定稿基准:全软件一个模型选择
                  面板,处处同行为):供应商分段、订阅来源全开,(model, providerId) 原子
                  落库。仅 effort/Fast 配置列与行内摘要保持关闭(configurationEnabled=false)——
                  子代理派发通道 CLAUDE_CODE_SUBAGENT_MODEL 只有模型 id,没有 effort/Fast
                  维度,展示可调项会承诺一个不存在的能力(功能特殊化理由,见 PR 说明)。 */}
              <ModelSelector
                modelId={settings.claudeCode ?? ''}
                // effort 传空串:configurationEnabled=false 只关配置列,trigger 仍会在
                // effort 命中模型 efforts 时展示档位文案 —— 固定 "high" 会让该行看起来
                // 有 effort 维度,与「子代理通道无 effort」的事实不符(copilot review)。
                effort=""
                onModelChange={(modelId) => {
                  // 仅换模型:来源维度原值保留,不做收窄(缓存滞后窗口收窄=丢数据;
                  // 组合失配由 sourceDisconnected 断开态可见,见 resolveProviderId 注)。
                  void setClaudeModel(modelId, settings.claudeCodeProviderId);
                }}
                onEffortChange={() => undefined}
                vendorKey="cc"
                currentProviderId={settings.claudeCodeProviderId}
                sourceDisconnected={claudeSourceDisconnected}
                // 目录层面零可选模型的空态 CTA / 列表底部「连接来源」:开了供应商分段
                // 就必须给恢复动作,否则空态是死卡(codex review);与 composer 同跳转。
                // 仅「目录就绪且目录并集为空」时接线:loading 中 providers 为空是数据
                // 没到,提前接线会与「目录未就绪整行禁用」的交互冲突/闪烁(copilot
                // review);目录有模型时不接线,见 hasCatalogClaudeModel 注。
                onNavigateToProviders={
                  providersLoading || hasCatalogClaudeModel
                    ? undefined
                    : () => navigate('/settings?tab=providers')
                }
                // 存储来源断开时面板高亮的是**解析出的回退来源**,点它必须照常回调,
                // 才能把显示与存储重新对齐(codex review);纯同值重选在下方去重跳过。
                reselectEmitsChange
                onProviderChange={(providerId, modelId) => {
                  // 分段行原子选择 (来源, 模型);面板未回传模型时沿用已存模型,
                  // 尚未指定过模型则忽略(来源必须依附于某个模型才有语义)。
                  // 显式选择在此收窄;同值去重统一在 setClaudeModel 内处理。
                  const nextModel = modelId ?? settings.claudeCode;
                  if (!nextModel) return;
                  void setClaudeModel(nextModel, resolveProviderId('claude-code', nextModel, providerId));
                }}
                switching={pending}
                // 目录未就绪时禁用整行:此窗口内无法判定「来源是否提供该模型」,放行
                // 写入会绕过来源收窄(greptile review);IM 目录偏好行对 caps 未就绪同规则。
                disabled={providersLoading}
                triggerVariant="field"
                popoverSide="bottom"
                configurationEnabled={false}
                // 已存模型不在可见清单(被隐藏/来源断开/下架)时显示裸 id 而非占位符,
                // 用户能看到自己存的是什么;与 IM workdir 偏好入口同规则。
                unknownModelLabel={(id) => id}
                fallbackOption={{
                  active: settings.claudeCode === null,
                  label: unspecifiedLabel,
                  onSelect: () => {
                    void setClaudeModel(null, null);
                  },
                }}
              />
            </div>
            <DefaultOverrideControls
              isCustomized={modelCardCustomized}
              disabled={pending}
              onReset={() => {
                void resetCard(SUBAGENT_MODEL_CARD_KEYS);
              }}
            />
          </div>
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex w-[150px] shrink-0 items-center gap-2">
            <CodexMark size={16} className="text-[var(--text-secondary)]" />
            <span className="text-14 font-medium text-[var(--text-primary)]">Codex</span>
          </div>
          <div className="min-w-0 flex-1">
            {/* Codex 行与 Claude 行同一块标准面板,差异只有两点:configurationEnabled
                默认开启(codex 派发通道有 effort 维度:agents.default_subagent_reasoning_effort,
                且上游只设模型会把子代理 effort 重置为目标模型默认档,必须成对写);
                以及 (model, providerId, effort) 三元组原子落库。 */}
            <ModelSelector
              modelId={settings.codex ?? ''}
              effort={settings.codexEffort ?? ''}
              modelMemory={CODEX_SUBAGENT_MODEL_MEMORY}
              onModelChange={(modelId) => {
                void setCodexModel(modelId, settings.codexProviderId);
              }}
              onEffortChange={(effort) => {
                void setCodexEffort(effort);
              }}
              vendorKey="codex"
              // 隐藏 Chat 桥接的 Codex 供应商模型(DeepSeek/Kimi/GLM 等 openai-chat
              // wire):原生 spawn 按 Codex 自身目录解析子代理默认模型,桥接模型必被
              // 拒(greptile review P1)。统一面板基准下的功能特殊化,理由=上游硬约束;
              // codexV2ModelHint 仍保留说明(手改设置文件仍可写入任意值)。
              excludeChatBridgedCodex
              currentProviderId={settings.codexProviderId}
              sourceDisconnected={codexSourceDisconnected}
              onNavigateToProviders={
                providersLoading || hasCatalogCodexModel
                  ? undefined
                  : () => navigate('/settings?tab=providers')
              }
              reselectEmitsChange
              onProviderChange={(providerId, modelId, reconciledEffort) => {
                const nextModel = modelId ?? settings.codex;
                if (!nextModel) return;
                void setCodexModel(
                  nextModel,
                  resolveProviderId('codex', nextModel, providerId),
                  reconciledEffort,
                );
              }}
              switching={pending}
              disabled={providersLoading}
              triggerVariant="field"
              popoverSide="bottom"
              unknownModelLabel={(id) => id}
              fallbackOption={{
                active: settings.codex === null,
                label: unspecifiedLabel,
                onSelect: () => {
                  void setCodexModel(null, null);
                },
              }}
            />
          </div>
        </div>

        <p className="px-4 pb-3 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          {t('settings.subagentModels.codexV2ModelHint')}
        </p>

        <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.subagentModels.hint')}
        </p>
      </div>

      {/* ── 卡 2:Codex 子代理护栏 ─────────────────────────────────────── */}
      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <CodexMark size={16} className="text-[var(--text-secondary)]" />
            <span className="text-14 font-medium text-[var(--text-primary)]">
              {t('settings.subagentModels.guardrails.title')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <DefaultOverrideControls
              isCustomized={guardrailCustomized}
              disabled={pending}
              onReset={() => {
                void resetCard(SUBAGENT_GUARDRAIL_KEYS);
              }}
            />
            <Switch
              checked={subagentsEnabled}
              disabled={pending}
              onCheckedChange={(next) => {
                void persistPatch({ codexSubagentsEnabled: next });
              }}
              aria-label={t('settings.subagentModels.guardrails.enableAria')}
            />
          </div>
        </div>
        <p className="-mt-3 px-4 pb-3 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
          {t('settings.subagentModels.guardrails.enableHint')}
        </p>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div
          className={`flex items-center justify-between gap-3 px-4 py-4 ${subagentsEnabled ? '' : 'pointer-events-none opacity-50'}`}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-13 font-medium text-[var(--settings-section-sublabel)]"
              style={{ letterSpacing: '0.12px' }}
            >
              {t('settings.subagentModels.guardrails.cindyPolicyLabel')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.subagentModels.guardrails.cindyPolicyHint')}
            </p>
          </div>
          <Switch
            checked={settings.codexUseCindySubagentPolicy}
            disabled={pending || !subagentsEnabled}
            onCheckedChange={(next) => {
              void persistPatch({ codexUseCindySubagentPolicy: next });
            }}
            aria-label={t('settings.subagentModels.guardrails.cindyPolicyAria')}
          />
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        {/* 并发上限:Switch(是否自定义)+ 展开滑杆。未自定义时不显示任何具体数值 ——
            上游默认按后端分叉(V1=6 / Sol/Terra=3),不存在单一「默认值」可显示。 */}
        <div
          className={`flex flex-col gap-3 px-4 py-4 ${subagentsEnabled ? '' : 'pointer-events-none opacity-50'}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]" style={{ letterSpacing: '0.12px' }}>
                {t('settings.subagentModels.guardrails.concurrencyLabel')}
              </p>
              <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {concurrencyCustomized
                  ? t('settings.subagentModels.guardrails.concurrencyHint')
                  : t('settings.subagentModels.guardrails.concurrencyFollowDefault')}
              </p>
            </div>
            <Switch
              checked={concurrencyCustomized}
              disabled={pending || !subagentsEnabled}
              onCheckedChange={(next) => {
                void toggleConcurrencyCustom(next);
              }}
              aria-label={t('settings.subagentModels.guardrails.concurrencyCustomAria')}
            />
          </div>
          {concurrencyCustomized && (
            <div className="flex items-center gap-[14px]">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {/* 有意不随 pending 禁用(区别于同卡 Switch):滑杆写入是 debounce +
                    commitConcurrency 的 pending 重排,拖动期间随每次提交闪烁禁用态
                    只会打断拖动;竞态安全由 commitConcurrency 保证。 */}
                <Slider
                  value={[concurrencyValue]}
                  min={CODEX_SUBAGENT_CONCURRENCY_MIN}
                  max={CODEX_SUBAGENT_CONCURRENCY_MAX}
                  step={1}
                  disabled={!subagentsEnabled}
                  onValueChange={(value: number[]) => {
                    const next = value[0];
                    if (typeof next === 'number') onConcurrencyDrag(next);
                  }}
                  onValueCommit={(value: number[]) => {
                    const next = value[0];
                    if (typeof next === 'number') onConcurrencyCommit(next);
                  }}
                  aria-label={t('settings.subagentModels.guardrails.concurrencyAria')}
                />
                <div className="flex items-center justify-between text-11 leading-none text-[var(--text-tertiary)]">
                  <span>{CODEX_SUBAGENT_CONCURRENCY_MIN}</span>
                  <span>{CODEX_SUBAGENT_CONCURRENCY_MAX}</span>
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-13 font-medium leading-none text-[var(--text-primary)]">
                {concurrencyValue}
              </span>
            </div>
          )}
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div
          className={`flex items-center justify-between gap-3 px-4 py-4 ${subagentsEnabled ? '' : 'pointer-events-none opacity-50'}`}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-13 font-medium text-[var(--settings-section-sublabel)]" style={{ letterSpacing: '0.12px' }}>
              {t('settings.subagentModels.guardrails.nestedLabel')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.subagentModels.guardrails.nestedHint')}
            </p>
          </div>
          <Switch
            checked={settings.codexAllowNestedSubagents}
            disabled={pending || !subagentsEnabled}
            onCheckedChange={(next) => {
              void persistPatch({ codexAllowNestedSubagents: next });
            }}
            aria-label={t('settings.subagentModels.guardrails.nestedAria')}
          />
        </div>

        <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.subagentModels.guardrails.localOnlyHint')}
        </p>
      </div>
    </div>
  );
}
