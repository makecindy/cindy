/**
 * Settings -> Personalization 的子代理模型设置。
 *
 * main 进程 JSON store 是事实源；renderer 只展示并通过 IPC 提交覆盖值。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { connectedProvidersForAgent, getModel, isAgentSelectableModel, visibleModelUnion } from '@cindy/model-providers';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { useProviders } from '@/hooks/useProviders';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import type { SubagentModelSettingsState } from '../../../shared/subagentModelSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('SubagentModelSection');

/** 展示各 Agent 运行时的子代理模型覆盖能力；模型供应商由运行时模型目录决定。 */
export function SubagentModelSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SubagentModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);
  const { providers, loading: providersLoading } = useProviders();

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

  // 【仅显式选行路径】来源在「已连接且确实提供该模型」时才落库,否则收窄为 null。
  // 选行的候选与本收窄读同一份 providers 快照,面板能点到的行必过校验,无误清风险;
  // 与 ImDefaultSettingsSection.resolveProviderId 同规则。
  // 换模型(onModelChange)路径**不走本收窄**:它携带的是已存来源而非新选择,旧目录
  // 缓存刷新窗口(loading=false 但数据滞后)里收窄会把暂时不可见的有效订阅来源写成
  // null,真实丢数据(greptile 3/5 blocker);而保留原值没有路由危害 —— 子代理派发
  // 通道只带模型 id,providerId 是纯展示/选择维度,组合失配由 sourceDisconnected
  // 断开态可见兜底,用户显式重选即可纠正,不属于静默错误。
  const resolveProviderId = useCallback(
    (modelId: string, providerId: string | null): string | null => {
      if (!providerId) return null;
      const provider = connectedProvidersForAgent(providers, 'claude-code').find(
        (p) => p.id === providerId,
      );
      if (!provider) return null;
      // 只看 id 是否存在不够(issue #882 第 3 点,2026-07 review 第 18 轮):该来源这份
      // 具体条目若是非聊天类型,不能落成子代理模型的显式来源,否则派发会打进
      // image/audio/embedding 端点。
      const catalogModel = getModel(provider, modelId, 'claude-code');
      return catalogModel &&
        isAgentSelectableModel(catalogModel, { userProvider: provider.source === 'user' })
        ? providerId
        : null;
    },
    [providers],
  );

  // (model, providerId) 原子落库:模型与来源是同一次选择的两个维度,分两次写会在
  // 写入间隙出现「新模型 + 旧来源」的不可能组合被派发读到。清除模型时来源一并清除。
  const setClaudeModel = useCallback(
    async (model: string | null, providerId: string | null) => {
      if (!settings || pending) return;
      // providerId 语义由调用方确定:选行路径已按当前目录收窄;换模型路径保留已存
      // 来源原值(见 resolveProviderId 注)。这里只做同值去重,不再二次收窄。
      const nextProviderId = model === null ? null : providerId;
      if (model === settings.claudeCode && nextProviderId === settings.claudeCodeProviderId) {
        return;
      }
      setPending(true);
      try {
        const next = await window.electronAPI.maker.subagentModelSettingsSet({
          claudeCode: model,
          claudeCodeProviderId: nextProviderId,
        });
        setSettings(next);
      } catch (err) {
        log.warn('subagentModelSettingsSet failed', err);
        toast.error(
          err instanceof Error ? err.message : t('settings.subagentModels.saveFailed'),
        );
      } finally {
        setPending(false);
      }
    },
    [pending, settings, t],
  );

  const reset = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      setSettings(await window.electronAPI.maker.subagentModelSettingsReset());
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('subagentModelSettingsReset failed', err);
      toast.error(
        err instanceof Error ? err.message : t('settings.defaults.restoreFailed'),
      );
    } finally {
      setPending(false);
    }
  }, [pending, t]);

  if (!settings) return null;

  const unspecifiedLabel = t('settings.subagentModels.unspecified');
  // 已存显式来源当前不可用(目录就绪后判定):断开、或仍连接但目录已不再提供已存
  // 模型,都算——只查 id 会让「掉了该模型的来源」静默换显示,存储值分叉且可静默复活
  // (codex review)。trigger 显示**真实存储来源** + 断开错误态,不回落默认图标。
  const sourceDisconnected = Boolean(
    !providersLoading &&
      settings.claudeCodeProviderId &&
      !connectedProvidersForAgent(providers, 'claude-code').some((p) => {
        if (p.id !== settings.claudeCodeProviderId) return false;
        if (settings.claudeCode === null) return true;
        // 只查 id 会漏掉「该来源这份具体条目已经是非聊天类型」的情况(issue #882
        // 第 3 点,2026-07 review 第 18 轮)——同样算「不可用」,需要断开态提示。
        const catalogModel = getModel(p, settings.claudeCode, 'claude-code');
        return (
          catalogModel !== undefined &&
          isAgentSelectableModel(catalogModel, { userProvider: p.source === 'user' })
        );
      }),
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
                  落库。仅 effort/Fast 配置列保持关闭(configurationEnabled=false)——
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
                sourceDisconnected={sourceDisconnected}
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
                  void setClaudeModel(nextModel, resolveProviderId(nextModel, providerId));
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
              isCustomized={settings.isCustomized}
              disabled={pending}
              onReset={() => {
                void reset();
              }}
            />
          </div>
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex w-[150px] shrink-0 items-center gap-2">
            <CodexMark size={16} className="text-[var(--text-tertiary)]" />
            <span className="text-14 font-medium text-[var(--text-tertiary)]">Codex</span>
          </div>
          <button
            type="button"
            disabled
            className="flex h-10 min-w-0 flex-1 items-center rounded-lg border border-[var(--border-default)] bg-[var(--settings-input-bg)] px-3 text-left text-13 text-[var(--text-tertiary)] opacity-60"
          >
            <span className="truncate">{t('settings.subagentModels.codexUnavailable')}</span>
          </button>
        </div>

        <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.subagentModels.hint')}
        </p>
      </div>
    </div>
  );
}
