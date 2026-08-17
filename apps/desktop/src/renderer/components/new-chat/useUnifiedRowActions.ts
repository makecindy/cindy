/**
 * useUnifiedRowActions —— 统一模型选择器面板里**所有会改用户数据的动作**的单点集合
 * (model-selector-unified §1.4 / §1.5 / §1.6)。
 *
 * 集中在一个文件里的理由:这几条规则彼此纠缠,散在组件里就没法逐条对着规格审 ——
 *   - 引擎:模型行写 `modelEnginePrefs` override;收藏行改的是**那一条收藏**;
 *   - 深度 / Fast:**live 选中行**交给调用方的实时状态(绝不预写记忆 —— device-link
 *     写穿失败会污染被控端草稿),其余行写 `providerModelMemory` 既有槽;
 *   - 恢复推荐:删 override(随版本跟随新推荐)+ 把深度 / Fast 收回目录默认;**live 选中行
 *     还要把推荐配置真的应用到正在跑的那一份**(live 状态不读记忆表,只清记忆等于只改了
 *     显示),跨引擎时复用与 applyEngine 同一条切换链路;
 *   - 收藏:☆ 是单向「存一份当前生效配置的副本」,收藏行的 ☆ 才是删除;
 *   - 选中:跨引擎的那一下**不走**普通 onSelect,交给调用方的切换事务。
 *
 * 本 hook 不持有状态(点亮反馈的计时器留在组件里,经 `onFavoriteFlash` 回调触发)。
 */

import type { UnifiedModelEntry } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';
import {
  clearModelEngineOverride,
  setModelEngineOverride,
} from '@/state/modelEnginePrefs';
import {
  addModelFavorite,
  removeModelFavorite,
  updateModelFavorite,
  type ModelFavoriteItem,
} from '@/state/modelFavorites';

import type { ModelMemoryAccessors } from './ModelSelector';
import type { UnifiedSelectedRow } from './UnifiedModelPanel';
import {
  agentKindOfEngine,
  anchorKey,
  engineOfAgentKind,
  wireModelIdOf,
  type UnifiedAnchor,
  type UnifiedEngine,
  type UnifiedRowConfig,
} from './unifiedModelSelection';

export interface UnifiedRowActionsOptions {
  interactionDisabled: boolean;
  /** 这一行是不是当前会话 / 草稿正在用的那一行(来源 + 模型 + 引擎都对上)。 */
  isLiveRow: (entry: UnifiedModelEntry, config: UnifiedRowConfig) => boolean;
  modelMemory?: ModelMemoryAccessors | undefined;
  onEffortChangeLive?: ((effort: Effort) => void) | undefined;
  onFastModeChangeLive?: ((enabled: boolean) => void | Promise<void>) | undefined;
  onSelect: (
    providerId: string,
    modelId: string,
    effort: Effort | '',
    config: UnifiedSelectedRow,
  ) => void;
  sessionEngineFilter?:
    | {
        currentAgent: AgentKind;
        onCrossEngineSelect: (args: {
          providerId: string;
          modelId: string;
          targetAgent: AgentKind;
          effort: Effort | '';
        }) => void | boolean | Promise<void | boolean>;
      }
    | undefined;
  sessionAgent?: AgentKind | undefined;
  /**
   * 按「假设引擎 override = engine」解析该行的完整配置(目标引擎的 wire id / 深度记忆 /
   * Fast)。applyEngine 在**选中行**上需要它:草稿把新引擎整份配置落回草稿,会话把
   * 目标引擎的 wire id / 深度交给跨引擎切换事务。
   */
  resolveEngineConfig?: ((entry: UnifiedModelEntry, engine: UnifiedEngine) => UnifiedRowConfig) | undefined;
  /** ☆ 的 0.7s 点亮反馈(计时器在组件里)。 */
  onFavoriteFlash: (anchorKeyValue: string) => void;
  /** 删除收藏前的收尾(如收起绑在该锚点上的浮层)。 */
  onBeforeRemoveFavorite: (anchor: UnifiedAnchor) => void;
}

export interface UnifiedRowActions {
  applyEngine: (
    anchor: UnifiedAnchor,
    entry: UnifiedModelEntry,
    config: UnifiedRowConfig,
    engine: UnifiedEngine,
  ) => void;
  applyEffort: (
    anchor: UnifiedAnchor,
    entry: UnifiedModelEntry,
    config: UnifiedRowConfig,
    effort: Effort,
  ) => void;
  applyFast: (
    anchor: UnifiedAnchor,
    entry: UnifiedModelEntry,
    config: UnifiedRowConfig,
    enabled: boolean,
  ) => void;
  resetToRecommended: (
    anchor: UnifiedAnchor,
    entry: UnifiedModelEntry,
    config: UnifiedRowConfig,
  ) => void;
  addFavorite: (anchor: UnifiedAnchor, config: UnifiedRowConfig) => void;
  removeFavorite: (anchor: UnifiedAnchor) => void;
  selectRow: (
    anchor: UnifiedAnchor,
    config: UnifiedRowConfig,
    favorite?: ModelFavoriteItem,
  ) => void;
}

export function useUnifiedRowActions(options: UnifiedRowActionsOptions): UnifiedRowActions {
  const {
    interactionDisabled,
    isLiveRow,
    modelMemory,
    onEffortChangeLive,
    onFastModeChangeLive,
    onSelect,
    sessionEngineFilter,
    sessionAgent,
    resolveEngineConfig,
    onFavoriteFlash,
    onBeforeRemoveFavorite,
  } = options;

  const applyEngine: UnifiedRowActions['applyEngine'] = (anchor, entry, config, engine) => {
    if (interactionDisabled) return;
    if (anchor.kind === 'fav') {
      updateModelFavorite(anchor.uid, { agent: engine });
      return;
    }
    // **选中行**的引擎胶囊不是普通 override(2026-08-14):它改的是「正在跑什么」——
    // 选中行强制按 live 引擎显示(UnifiedModelPanel.configOf.forceEngine),只写 override
    // 的话显示纹丝不动,胶囊就成了假按钮。
    if (isLiveRow(entry, config)) {
      const next = resolveEngineConfig?.(entry, engine);
      if (sessionEngineFilter && sessionAgent !== undefined) {
        const targetAgent = agentKindOfEngine(engine);
        if (targetAgent === sessionAgent) return; // 已在该引擎上,无事可做。
        // 会话内改选中行的引擎 = 一次跨引擎切换:交给 performAgentSwitch 事务(确认弹窗
        // + 上下文重建)。**不预写全局 override**:用户取消确认时不该留下任何痕迹。
        sessionEngineFilter.onCrossEngineSelect({
          providerId: anchor.providerId,
          modelId: next?.wireModelId ?? anchor.modelId,
          targetAgent,
          effort: next?.effort ?? '',
        });
        return;
      }
      // 草稿的选中行:换引擎无损 —— override 落库,同时把新引擎的整份配置写回草稿
      // (与选中一行同一条链路),行随之按新引擎显示。
      setModelEngineOverride(anchor.providerId, anchor.modelId, engine);
      if (next) {
        onSelect(anchor.providerId, next.wireModelId ?? anchor.modelId, next.effort ?? '', {
          engine: next.engine,
          fast: next.fast,
          favoriteUid: null,
          rowModelId: anchor.modelId,
        });
      }
      return;
    }
    setModelEngineOverride(anchor.providerId, anchor.modelId, engine);
  };

  const applyEffort: UnifiedRowActions['applyEffort'] = (anchor, entry, config, effort) => {
    if (interactionDisabled) return;
    if (anchor.kind === 'fav') {
      updateModelFavorite(anchor.uid, { effort });
      return;
    }
    if (isLiveRow(entry, config) && onEffortChangeLive) {
      // 选中行的深度是会话实时状态,交给调用方持久化(与旧版 handleEditEffort 同语义)。
      onEffortChangeLive(effort);
      return;
    }
    // ★ 记忆表(providerModelMemory)的既有消费方全部按 **wire id** 存取(会话恢复、
    // device-link 镜像、IM /model)。这里写归一化 id 会造出一份谁也读不到的影子记录,
    // 同时污染那张表。anchor.modelId 只是行身份,不是可以发出去的东西。
    modelMemory?.setEffort(
      config.agent,
      anchor.providerId,
      config.wireModelId ?? anchor.modelId,
      effort,
    );
  };

  const applyFast: UnifiedRowActions['applyFast'] = (anchor, entry, config, enabled) => {
    if (interactionDisabled) return;
    if (anchor.kind === 'fav') {
      updateModelFavorite(anchor.uid, { fast: enabled });
      return;
    }
    if (isLiveRow(entry, config) && onFastModeChangeLive) {
      // 选中行的 Fast 必须等调用方持久化成功后再由上层同步草稿;这里绝不预写 modelMemory
      // (device-link 远程失败会污染被控端草稿 —— 与旧版同一条禁令)。
      void onFastModeChangeLive(enabled);
      return;
    }
    // 同上:Fast 槽也按 wire id 存取。
    modelMemory?.setFast(
      config.agent,
      anchor.providerId,
      config.wireModelId ?? anchor.modelId,
      enabled,
    );
  };

  const resetToRecommended: UnifiedRowActions['resetToRecommended'] = (anchor, entry, config) => {
    if (interactionDisabled || anchor.kind === 'fav') return;
    const recommendedAgent = entry.recommended;
    const recommendedEngine = engineOfAgentKind(recommendedAgent);
    // 推荐档一律取 M1 已解析的那一份(`UnifiedAgentCapability.defaultEffort`,缺省回落
    // 已经在那边应用过),不在这里另推一遍 —— 两处各推必然漂移。
    const defaultEffort = entry.capabilities[recommendedAgent]?.defaultEffort ?? null;
    // 恢复推荐是把**推荐引擎**那一格收回默认,故按推荐引擎的 wire id 写(与该行当前
    // 生效引擎的 wire id 可能不是同一个 id)。
    const recommendedWireId = wireModelIdOf(entry, recommendedAgent);

    /** 「跟随推荐」的持久化部分:删 override + 把推荐引擎那一格的记忆槽写回目录默认。 */
    const resetStoredConfig = (): void => {
      clearModelEngineOverride(anchor.providerId, anchor.modelId);
      // 记忆槽没有「删」的语义(providerModelMemory 是 (agent, model) → 值的表);把它写回
      // 目录默认 = 用户看到的就是推荐配置。真正的「跟随服务端新默认」由引擎 override 的删除
      // 承担 —— 深度默认变了,用户下次进浮层看到的仍是自己这次确认过的档,不会被静默改。
      if (defaultEffort) {
        modelMemory?.setEffort(
          recommendedAgent,
          anchor.providerId,
          recommendedWireId,
          defaultEffort,
        );
      }
      // Fast 无条件收回:`config.fast` 是**当前生效引擎**那一格的值,拿它当门会漏掉「行现在
      // 落在 codex(Fast 关),推荐引擎槽里还留着上次开的 Fast」这一路 —— 恢复推荐后行会
      // 当场翻回带 ⚡ 的样子。清的槽与上面的深度一样按推荐引擎 + 推荐引擎 wire id 走。
      modelMemory?.setFast(recommendedAgent, anchor.providerId, recommendedWireId, false);
    };

    // 非 live 行:改的只是「下次选它用什么」,清记忆就够了。
    if (!isLiveRow(entry, config)) {
      resetStoredConfig();
      return;
    }

    // ★ live 选中行还得把推荐配置**真的应用到正在跑的那一份**(2026-08-17 review):
    // 会话的实时深度 / Fast、草稿的 vendor+model 配置都**不读记忆表**(选中行读的是 live 值,
    // 见 UnifiedModelPanel.configOf)。只清记忆的话,用户点完「恢复推荐」当前任务照旧用着
    // 旧引擎 / 旧深度 / 旧 Fast 在跑,浮层却已经显示成推荐态 —— 显示与事实分家。
    if (recommendedAgent === config.agent) {
      // 引擎没变:推荐态 = 跟随推荐档 + 无 Fast。两个 live 回调即「应用」,与用户在浮层里
      // 手动拖档 / 关 ⚡ 走同一条持久化链路(applyEffort / applyFast 的 live 分支)。
      resetStoredConfig();
      if (defaultEffort && onEffortChangeLive) onEffortChangeLive(defaultEffort);
      // 无条件关:`config.fast` 只是本次渲染看到的值,漏关一次留下的是一个用户以为已经
      // 恢复、实际还在插队加速的任务;重复关是幂等的。
      if (onFastModeChangeLive) void onFastModeChangeLive(false);
      return;
    }

    // 推荐引擎 ≠ 当前引擎 —— 这一下等于「把行切回推荐引擎」,必须走与 applyEngine 完全
    // 相同的两条链路,不另造第三条。
    if (sessionEngineFilter && sessionAgent !== undefined) {
      // 会话内换引擎有损(确认弹窗 + 上下文重建):先跑事务,**成功了才**落 override / 记忆。
      // 顺序刻意与 applyEngine 的会话分支一致(那里的规则是「不预写 override,取消不留痕」)——
      // 取消 = 一点都没应用,不会出现「override 清了、任务还在旧引擎上」的半套状态。
      void Promise.resolve(
        sessionEngineFilter.onCrossEngineSelect({
          providerId: anchor.providerId,
          modelId: recommendedWireId,
          targetAgent: recommendedAgent,
          effort: defaultEffort ?? '',
        }),
      ).then(
        (applied) => {
          // 只有明确的 false 表示「没切」(见 UnifiedModelPanelProps.onCrossEngineSelect);
          // 返回 void 的调用方视为已切。
          if (applied === false) return;
          resetStoredConfig();
        },
        // 事务抛错(切换失败)同样按「没应用」处理:不留 override 已清、任务还在旧引擎的半套。
        () => {},
      );
      return;
    }
    // 草稿换引擎无损:先落 override / 记忆,再把推荐引擎的整份配置按既有选中链路写回草稿
    // (与 applyEngine 的草稿分支同形)。
    resetStoredConfig();
    onSelect(anchor.providerId, recommendedWireId, defaultEffort ?? '', {
      engine: recommendedEngine,
      fast: false,
      favoriteUid: null,
      rowModelId: anchor.modelId,
    });
  };

  const addFavorite: UnifiedRowActions['addFavorite'] = (anchor, config) => {
    if (interactionDisabled) return;
    addModelFavorite({
      providerId: anchor.providerId,
      modelId: anchor.modelId,
      agent: config.engine,
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.fast ? { fast: true as const } : {}),
    });
    onFavoriteFlash(anchorKey(anchor));
  };

  const removeFavorite: UnifiedRowActions['removeFavorite'] = (anchor) => {
    if (interactionDisabled || anchor.kind !== 'fav') return;
    onBeforeRemoveFavorite(anchor);
    removeModelFavorite(anchor.uid);
  };

  const selectRow: UnifiedRowActions['selectRow'] = (anchor, config, favorite) => {
    if (interactionDisabled) return;
    const effort = config.effort ?? '';
    // 跨引擎选择不走普通 onSelect(那条链路只换 model / provider):交给调用方的切换事务
    // (performAgentSwitch —— 确认弹窗、上下文重建、fastMode 不跨引擎带入等语义都在那边)。
    // 草稿场景没有 sessionEngineFilter,换引擎没有代价,恒走 onSelect。
    // 交出去的一律是**该引擎的 wire id**(建会话 / 切模型 / 写 draft 都用它);
    // 行的归一化身份另放在 config.rowModelId 里,调用方要记 override / 收藏时用那个。
    const wireModelId = config.wireModelId ?? anchor.modelId;
    if (sessionEngineFilter && sessionAgent !== undefined && config.agent !== sessionAgent) {
      sessionEngineFilter.onCrossEngineSelect({
        providerId: anchor.providerId,
        modelId: wireModelId,
        targetAgent: config.agent,
        effort,
      });
      return;
    }
    // 生效引擎 / Fast / 收藏锚点随选中一起交出去:调用方(M5 新会话)要按它派生
    // newMakerDraft 的 vendor,再重推一遍必然与行上显示的三元组漂移。
    onSelect(anchor.providerId, wireModelId, effort, {
      engine: config.engine,
      fast: config.fast,
      favoriteUid: favorite ? favorite.uid : null,
      rowModelId: anchor.modelId,
    });
  };

  return {
    applyEngine,
    applyEffort,
    applyFast,
    resetToRecommended,
    addFavorite,
    removeFavorite,
    selectRow,
  };
}
