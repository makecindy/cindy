/**
 * Settings -> Personalization 的视觉桥（Vision Bridge）设置。
 *
 * 让纯文本模型（如 deepseek 等）获得看图能力：用外部多模态模型把图转成文字描述。
 * 两个清单：
 *  - 目标模型：勾选哪些模型走视觉桥（已知无视觉默认勾选，已知有视觉 / 未知默认不勾但
 *    允许手动勾，如故意用廉价视觉模型节省 token）；
 *  - 视觉后端：主 + 备（最多两个，备可空 = 无灾备）。
 *
 * main 进程 JSON store 是真源；renderer 展示并通过 IPC 提交覆盖值（SubagentModelSection 模式）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  classifyVisionCapability,
  type VisionCapability,
} from '@cindy/model-providers';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { useProviders } from '@/hooks/useProviders';
import { createLogger } from '@/lib/logger';
import { deriveModelsFromProviders } from '@/lib/providerModels';
import { toast } from '@/lib/toast';
import type { VisionBackendRef } from '../../../shared/visionBridgeSettings';
import { VISION_BRIDGE_SETTINGS_DEFAULTS } from '../../../shared/visionBridgeSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('VisionBridgeSection');

/** 视觉能力徽章标签文案（i18n key）。 */
const CAPABILITY_LABEL_KEY: Record<VisionCapability, string> = {
  vision: 'settings.visionBridge.capability.vision',
  'no-vision': 'settings.visionBridge.capability.noVision',
  unknown: 'settings.visionBridge.capability.unknown',
};

/** 目标模型行：模型 + 三态标注 + 勾选走视觉桥。 */
interface TargetRow {
  id: string;
  name: string;
  capability: VisionCapability;
}

export function VisionBridgeSection() {
  const { t } = useTranslation();
  const { providers, loading: providersLoading } = useProviders();

  const [enabled, setEnabled] = useState(false);
  const [targetModels, setTargetModels] = useState<string[]>([]);
  const [primary, setPrimary] = useState<VisionBackendRef | null>(null);
  const [fallback, setFallback] = useState<VisionBackendRef | null>(null);
  const [isCustomized, setIsCustomized] = useState(false);
  /** targetModels 是否被用户显式自定义（决定 no-vision 默认勾选是否生效）。 */
  const [targetModelsCustomized, setTargetModelsCustomized] = useState(false);
  /** 默认值快照：目标模型卡独立 reset 时只用它恢复 targetModels（不清后端/开关）。 */
  const [defaultTargetModels, setDefaultTargetModels] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  /** 是否已发生用户交互（persistPatch 被调）。初始 GET 在交互后返回时丢弃，防旧 snapshot 覆盖新状态。 */
  const interactedRef = useRef(false);
  /** persistPatch 开始前的 last-known 快照：set 失败且回滚 GET 也失败时恢复（防乐观态残留）。 */
  const lastKnownRef = useRef<{
    enabled: boolean;
    targetModels: string[];
    primary: VisionBackendRef | null;
    fallback: VisionBackendRef | null;
    isCustomized: boolean;
    targetModelsCustomized: boolean;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .visionBridgeSettingsGet()
      .then((next) => {
        if (disposed || interactedRef.current) return;
        setEnabled(next.enabled);
        setTargetModels(next.targetModels);
        setPrimary(next.primary);
        setFallback(next.fallback);
        setIsCustomized(next.isCustomized);
        setTargetModelsCustomized(next.customizedKeys.includes('targetModels'));
        setDefaultTargetModels(next.defaults.targetModels);
      })
      .catch((err) => {
        log.warn('visionBridgeSettingsGet failed', err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const persistPatch = useCallback(
    async (patch: Record<string, unknown>) => {
      if (pending) return;
      interactedRef.current = true;
      // 记录 last-known（交互前真实值）：set 失败且回滚 GET 也失败时恢复。
      lastKnownRef.current = {
        enabled,
        targetModels,
        primary,
        fallback,
        isCustomized,
        targetModelsCustomized,
      };
      setPending(true);
      try {
        const next = await window.electronAPI.maker.visionBridgeSettingsSet(
          patch as Parameters<typeof window.electronAPI.maker.visionBridgeSettingsSet>[0],
        );
        setEnabled(next.enabled);
        setTargetModels(next.targetModels);
        setPrimary(next.primary);
        setFallback(next.fallback);
        setIsCustomized(next.isCustomized);
        setTargetModelsCustomized(next.customizedKeys.includes('targetModels'));
        toast.success(t('settings.visionBridge.toast.saved'));
      } catch (err) {
        log.warn('visionBridgeSettingsSet failed', err);
        toast.error(t('settings.visionBridge.toast.saveFailed'));
        // 失败回滚：本地乐观状态（如 targetModelsCustomized）与 main store 分叉时，
        // 重新拉取真实值回填，避免 UI 按错误的「已自定义」渲染（no-vision 默认勾选被误关）。
        try {
          const current = await window.electronAPI.maker.visionBridgeSettingsGet();
          setEnabled(current.enabled);
          setTargetModels(current.targetModels);
          setPrimary(current.primary);
          setFallback(current.fallback);
          setIsCustomized(current.isCustomized);
          setTargetModelsCustomized(current.customizedKeys.includes('targetModels'));
        } catch (refreshErr) {
          // 回滚 GET 也失败：恢复到 last-known，避免乐观态残留（#3）。
          log.warn('visionBridgeSettingsGet rollback failed; restoring last-known', refreshErr);
          const last = lastKnownRef.current;
          if (last) {
            setEnabled(last.enabled);
            setTargetModels(last.targetModels);
            setPrimary(last.primary);
            setFallback(last.fallback);
            setIsCustomized(last.isCustomized);
            setTargetModelsCustomized(last.targetModelsCustomized);
          }
        }
      } finally {
        setPending(false);
      }
    },
    [pending, t, enabled, targetModels, primary, fallback, isCustomized, targetModelsCustomized],
  );

  const toggleEnabled = useCallback(
    (next: boolean) => {
      void persistPatch({ enabled: next });
    },
    [persistPatch],
  );

  // 目标模型清单：跨 agent 模型并集（同 id 去重），附三态能力标注。
  const targetRows = useMemo<TargetRow[]>(() => {
    const seen = new Set<string>();
    const rows: TargetRow[] = [];
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      for (const m of deriveModelsFromProviders(providers, agent, { admissionFiltered: true })) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        rows.push({ id: m.id, name: m.displayName, capability: classifyVisionCapability(m.id) });
      }
    }
    // 稳定排序：已知无视觉在前（最相关），其余按 id。
    const rank = (c: VisionCapability) => (c === 'no-vision' ? 0 : c === 'vision' ? 2 : 1);
    return rows.sort((a, b) => rank(a.capability) - rank(b.capability) || a.id.localeCompare(b.id));
  }, [providers]);

  // 是否默认勾选（未显式自定义时，已知无视觉模型默认走视觉桥——对齐设计文档）。
  const isTargetDefaultChecked = (capability: VisionCapability) =>
    !targetModelsCustomized && capability === 'no-vision';

  const toggleTarget = useCallback(
    (modelId: string, capability: VisionCapability) => {
      // 用户一旦显式勾/取消，targetModels 视为已自定义（后续按用户选择，不再默认合并 no-vision）。
      setTargetModelsCustomized(true);
      // 首次 toggle 时 targetModels 是空数组（未自定义），但「有效勾选」含默认勾选的
      // no-vision 模型。必须以当前有效勾选全集 seed 显式列表再应用单行反转——
      // 否则取消一个默认勾选项会让其余默认勾选项全部消失（保存后 customized=true，
      // 默认合并不再生效，其余模型失去视觉桥）。对齐 store 侧默认合并语义。
      const effectivelyChecked = targetModels.includes(modelId) || isTargetDefaultChecked(capability);
      const seed = targetModelsCustomized
        ? targetModels
        : targetRows
            .filter((row) => isTargetDefaultChecked(row.capability))
            .map((row) => row.id);
      const next = effectivelyChecked
        ? seed.filter((id) => id !== modelId)
        : [...new Set([...seed, modelId])];
      void persistPatch({ targetModels: next });
    },
    [targetModels, targetModelsCustomized, targetRows, isTargetDefaultChecked, persistPatch],
  );

  // 视觉后端候选：跨 agent 面（claude-code + codex + pi）并集，只保留可能读图的模型。
  // 排除已知无视觉（如 deepseek/glm-5.2——选作后端运行时必失败）；unknown 保留（可能是
  // 新视觉模型，运行时由真实请求裁决）。用户的视觉后端可能只在 codex/pi 面配置（如
  // OpenRouter/OpenAI 兼容 provider），只取 claude-code 面会漏掉（codex P1）。
  const backendCandidates = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ id: string; displayName: string }> = [];
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      for (const m of deriveModelsFromProviders(providers, agent, { admissionFiltered: true })) {
        if (classifyVisionCapability(m.id) === 'no-vision') continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        rows.push({ id: m.id, displayName: m.displayName });
      }
    }
    return rows;
  }, [providers]);

  const setBackend = useCallback(
    (slot: 'primary' | 'fallback', value: VisionBackendRef | null) => {
      const patch = slot === 'primary' ? { primary: value } : { fallback: value };
      void persistPatch(patch);
    },
    [persistPatch],
  );

  // 视觉可用性：OAuth 系（anthropic/openai 订阅直连）视觉通道视为不可用
  // （provider-route 对 OAuth 后端 return null）。managed（XD 网关）/ apiKey /
  // none 可用。用于降级路径避免取到 OAuth 不可用路线（codex P1）。
  const isVisionUsableProvider = useCallback(
    (p: { auth?: { method?: string } }): boolean => p.auth?.method !== 'oauth',
    [],
  );

  // 跨 agent 面（claude-code + codex + pi）找提供某模型的第一个「视觉可用」provider。
  // 降级路径用：onProviderChange 未触发时（如未设置状态下的 onModelChange），
  // 视觉后端可能只在 codex/pi 面配置（OpenRouter/OpenAI 兼容 provider）。优先取
  // 非 OAuth 的（视觉通道可用）——共享模型如 Claude 同时出现在 Anthropic OAuth 与
  // XD managed 时，不能取到 OAuth 不可用路线导致每次视觉请求都失败（codex P1）。
  const findProviderForModel = useCallback(
    (modelId: string): string | null => {
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const usable = providers.filter((prov) => isVisionUsableProvider(prov));
        const p = usable.find((prov) =>
          prov.models[agent]?.some((m) => m.id === modelId),
        );
        if (p) return p.id;
      }
      // 全 OAuth 兜底：找不到非 OAuth 提供者时，退回任意提供该模型的 provider
      //（视觉通道对 OAuth 返回不可用会走 fallback，至少不取空导致 IPC 拒绝）。
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const p = providers.find((prov) =>
          prov.models[agent]?.some((m) => m.id === modelId),
        );
        if (p) return p.id;
      }
      return null;
    },
    [providers, isVisionUsableProvider],
  );

  const resetAll = useCallback(async () => {
    // reset 也是用户交互：设 interactedRef 防慢初始 GET 覆盖刚完成的 reset；
    // 复用 pending 状态机，防止 reset in-flight 期间用户再触发 SET/其它交互覆盖 reset 结果。
    if (pending) return;
    interactedRef.current = true;
    setPending(true);
    try {
      const next = await window.electronAPI.maker.visionBridgeSettingsReset();
      setEnabled(next.enabled);
      setTargetModels(next.targetModels);
      setPrimary(next.primary);
      setFallback(next.fallback);
      setIsCustomized(next.isCustomized);
      setTargetModelsCustomized(next.customizedKeys.includes('targetModels'));
      lastKnownRef.current = {
        enabled: next.enabled,
        targetModels: next.targetModels,
        primary: next.primary,
        fallback: next.fallback,
        isCustomized: next.isCustomized,
        targetModelsCustomized: next.customizedKeys.includes('targetModels'),
      };
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('visionBridgeSettingsReset failed', err);
      toast.error(t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [pending, t]);

  const backendsCustomized = isCustomized;

  // 目标模型卡独立 reset：只恢复 targetModels（等默认值 → override 删除），
  // 不清用户已配好的后端/开关（codex P2——reset 控件在目标模型卡里，用户只想
  // 恢复勾选清单，不该连带清掉 primary/fallback 并关闭视觉桥）。
  const resetTargetModels = useCallback(async () => {
    if (pending) return;
    interactedRef.current = true;
    setPending(true);
    try {
      const next = await window.electronAPI.maker.visionBridgeSettingsSet({
        targetModels: defaultTargetModels,
      });
      setTargetModels(next.targetModels);
      setTargetModelsCustomized(next.customizedKeys.includes('targetModels'));
      setIsCustomized(next.isCustomized);
      lastKnownRef.current = {
        ...(lastKnownRef.current ?? {
          enabled: next.enabled,
          primary: next.primary,
          fallback: next.fallback,
        }),
        targetModels: next.targetModels,
        targetModelsCustomized: next.customizedKeys.includes('targetModels'),
        isCustomized: next.isCustomized,
      };
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('visionBridge targetModels reset failed', err);
      toast.error(t('settings.defaults.restoreFailed'));
    } finally {
      setPending(false);
    }
  }, [pending, t, defaultTargetModels]);

  // 后端模型名称解析（无 providerId 限定：用第一个出现该 id 的名字）。
  const backendLabelFor = (ref: VisionBackendRef | null): string => {
    if (!ref) return '';
    const hit = backendCandidates.find((m) => m.id === ref.modelId);
    return hit?.displayName ?? ref.modelId;
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.visionBridge.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.visionBridge.description')}
        </p>
      </div>

      {/* ── 总开关 ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-14 font-medium text-[var(--text-primary)]">
            {t('settings.visionBridge.enableLabel')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.visionBridge.enableHint')}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={toggleEnabled}
          aria-label={t('settings.visionBridge.enableAria')}
        />
      </div>

      {/* ── 卡 1：目标模型（走视觉桥的纯文本模型） ────────────────────── */}
      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-14 font-medium text-[var(--text-primary)]">
              {t('settings.visionBridge.targetModels.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.visionBridge.targetModels.hint')}
            </p>
          </div>
          <DefaultOverrideControls
            isCustomized={targetModelsCustomized}
            disabled={pending}
            onReset={() => {
              void resetTargetModels();
            }}
          />
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        {targetRows.length === 0 ? (
          <p className="px-4 py-4 text-12 text-[var(--text-tertiary)]">
            {t('settings.visionBridge.targetModels.empty')}
          </p>
        ) : (
          <div className="flex max-h-[320px] flex-col overflow-y-auto">
            {targetRows.map((row) => {
              // 未显式自定义 targetModels 时，no-vision 模型默认勾选（对齐设计文档）。
              const checked = targetModels.includes(row.id) || isTargetDefaultChecked(row.capability);
              return (
                <div
                  key={row.id}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${enabled ? '' : 'pointer-events-none opacity-50'}`}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-13 text-[var(--text-primary)]">{row.name}</span>
                    <span className="text-11 leading-none text-[var(--text-tertiary)]">
                      {t(CAPABILITY_LABEL_KEY[row.capability])}
                    </span>
                  </div>
                  <Switch
                    checked={checked}
                    disabled={pending || !enabled}
                    onCheckedChange={() => {
                      void toggleTarget(row.id, row.capability);
                    }}
                    aria-label={t('settings.visionBridge.targetModels.toggleAria', { model: row.name })}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 卡 2：视觉后端模型（主 + 备，最多两个） ────────────────────── */}
      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="px-4 py-4">
          <div className="flex flex-col gap-1">
            <p className="text-14 font-medium text-[var(--text-primary)]">
              {t('settings.visionBridge.backends.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
              {t('settings.visionBridge.backends.hint')}
            </p>
          </div>
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div className={`flex flex-col gap-3 px-4 py-4 ${enabled ? '' : 'pointer-events-none opacity-50'}`}>
          {/* 主后端 */}
          <div className="flex items-center gap-4">
            <div className="w-[70px] shrink-0 text-13 font-medium text-[var(--settings-section-sublabel)]">
              {t('settings.visionBridge.backends.primary')}
            </div>
            <div className="min-w-0 flex-1">
              <ModelSelector
                modelId={primary?.modelId ?? ''}
                effort=""
                // provider-first：同一模型被多个 provider 提供时（如 Claude 模型同时出现在
                // Anthropic 订阅与 XD managed 路由），必须保存用户实际选行的 provider，而不是
                // 取首个匹配——OAuth 路线视觉通道视为不可用，取错会让每次描述请求都 fallback。
                currentProviderId={primary?.providerId ?? null}
                onProviderChange={(providerId, modelId) => {
                  if (!providerId || !modelId) {
                    void setBackend('primary', null);
                    return;
                  }
                  // 已知无视觉模型不能作视觉后端（选中运行时必失败，表现为「视觉桥不可用」）。
                  if (classifyVisionCapability(modelId) === 'no-vision') return;
                  void setBackend('primary', { providerId, modelId });
                }}
                onModelChange={(modelId) => {
                  if (!modelId) {
                    void setBackend('primary', null);
                    return;
                  }
                  // 降级路径（onProviderChange 未触发时）：跨面查找提供该模型的 provider
                  // （视觉后端可能只在 codex/pi 面配置），多 provider 场景由 onProviderChange 覆盖。
                  if (classifyVisionCapability(modelId) === 'no-vision') return;
                  void setBackend('primary', {
                    providerId: findProviderForModel(modelId) ?? '',
                    modelId,
                  });
                }}
                onEffortChange={() => undefined}
                // 不传 vendorKey → 三 agent 面模型一起展示（视觉后端可能只在
                // codex/pi 面配置，如 OpenRouter/OpenAI 兼容 provider）。
                switching={pending}
                disabled={providersLoading || !enabled}
                triggerVariant="field"
                popoverSide="bottom"
                configurationEnabled={false}
                unknownModelLabel={(id) => id}
                fallbackOption={{
                  active: primary === null,
                  label: t('settings.visionBridge.backends.unset'),
                  onSelect: () => {
                    void setBackend('primary', null);
                  },
                }}
              />
            </div>
          </div>

          {/* 备后端（可空 = 无灾备） */}
          <div className="flex items-center gap-4">
            <div className="w-[70px] shrink-0 text-13 font-medium text-[var(--settings-section-sublabel)]">
              {t('settings.visionBridge.backends.fallback')}
            </div>
            <div className="min-w-0 flex-1">
              <ModelSelector
                modelId={fallback?.modelId ?? ''}
                effort=""
                // provider-first：与主后端一致，保存用户实际选行的 provider（防多 provider
                // 共享模型时取到 OAuth 不可用路线）。
                currentProviderId={fallback?.providerId ?? null}
                onProviderChange={(providerId, modelId) => {
                  if (!providerId || !modelId) {
                    void setBackend('fallback', null);
                    return;
                  }
                  if (classifyVisionCapability(modelId) === 'no-vision') return;
                  void setBackend('fallback', { providerId, modelId });
                }}
                onModelChange={(modelId) => {
                  if (!modelId) {
                    void setBackend('fallback', null);
                    return;
                  }
                  if (classifyVisionCapability(modelId) === 'no-vision') return;
                  void setBackend('fallback', {
                    providerId: findProviderForModel(modelId) ?? '',
                    modelId,
                  });
                }}
                onEffortChange={() => undefined}
                // 与主后端一致：不传 vendorKey → 三面模型可选。
                switching={pending}
                disabled={providersLoading || !enabled}
                triggerVariant="field"
                popoverSide="bottom"
                configurationEnabled={false}
                unknownModelLabel={(id) => id}
                fallbackOption={{
                  active: fallback === null,
                  label: t('settings.visionBridge.backends.noBackup'),
                  onSelect: () => {
                    void setBackend('fallback', null);
                  },
                }}
              />
            </div>
          </div>
        </div>

        <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.visionBridge.backends.hintSecondary')}
        </p>
      </div>
    </div>
  );
}
