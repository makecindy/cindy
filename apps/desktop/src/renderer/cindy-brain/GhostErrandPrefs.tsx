/**
 * Host-rendered errand (派活取件) preferences for a Plugin that declares
 * `agent.errand`. Settings 详情与 Plugin 详情共用(同 CindyCapabilityPrefs)。
 *
 * 选择器复用草稿页同一套组件(2026-07-31 Lizi 要求,不另搭下拉):
 * - Agent = VendorSegmentedSwitcher(cc/codex 分段);
 * - 模型/推理强度/Fast/供应商 = ModelSelector 的 field 形态(与 IM 默认
 *   配置、Hook 工作区偏好同款嵌法);
 * - 动手权限 = PermissionSelector(权限下拉全仓只此一份,不得私搭),
 *   errand 不允许的档位经 disabledModes 灰置并带原因。
 *
 * 「跟随默认」语义(与 main 侧 errandPrefsStore 同一契约):配置里没写的
 * 字段跟随「新建草稿」偏好。卡片默认展示草稿当下的选择(实时跟随),用户
 * 一旦点选即钉住;「恢复跟随默认」一键清空回到跟随态。权限档与工作目录
 * 是 errand 自己的事,不参与跟随:权限缺省 plan(只读,协议层不存在
 * bypassPermissions),目录缺省插件专属文件夹,选真实项目必须经系统窗口
 * 亲选(与 pick 槽同一哲学)。
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, FolderOpen, X } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { VendorSegmentedSwitcher } from '@/components/new-chat/VendorSegmentedSwitcher';
import {
  getEffortForModel,
  getFastModeForModel,
  getPersistedVendorModel,
  useNewMakerDraft,
} from '@/state/newMakerDraft';
import type { Effort } from '@/lib/userPreferences.types';

const PERMISSION_ALLOWED = new Set(['plan', 'acceptEdits', 'auto']);

/** errand 只收 worker 同集合的思考档(minimal 不收,与 main 侧存储层一致)。 */
const ERRAND_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

interface ErrandConfig {
  agentKind?: 'cc' | 'codex';
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string;
  permissionMode?: 'plan' | 'acceptEdits' | 'auto';
  workingDir?: string;
}

export function GhostErrandPrefs({
  ghostId,
  appearance = 'settings',
}: {
  ghostId: string;
  /** Plugin detail aligns the card with the shared Plugin surface. */
  appearance?: 'settings' | 'plugin';
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ErrandConfig>(
    () => (window.electronAPI.ghosts.errandPrefsSync(ghostId).config ?? {}) as ErrandConfig,
  );
  // 跟随态的展示值实时来自草稿偏好(useNewMakerDraft 订阅变更):用户在
  // 草稿页换了模型,这里的「跟随默认」立刻显示新值——所见即将用。
  const draft = useNewMakerDraft();

  const save = useCallback(
    async (next: ErrandConfig) => {
      const prev = config;
      setConfig(next);
      try {
        const result = await window.electronAPI.ghosts.setErrandConfig(
          ghostId,
          next as Record<string, unknown>,
        );
        setConfig((result.config ?? {}) as ErrandConfig);
      } catch {
        setConfig(prev);
        toast.error(t('settings.ghosts.errors.generic'));
      }
    },
    [config, ghostId, t],
  );

  // 展示口径:钉住的值优先,没钉的跟随草稿(vendor → 该 vendor 的草稿模型
  // → 该模型的 per-model effort/fast 记忆)。
  const followVendor = draft.vendor === 'codex' ? ('codex' as const) : ('cc' as const);
  const vendor = config.agentKind ?? followVendor;
  const shownModel = config.model ?? getPersistedVendorModel(vendor);
  const shownEffort = (config.effort ??
    getEffortForModel(shownModel) ??
    draft.lastByVendor[vendor]?.effort ??
    'high') as Effort;
  const shownFast = config.fastMode ?? getFastModeForModel(shownModel);
  const pinned =
    config.agentKind !== undefined ||
    config.model !== undefined ||
    config.effort !== undefined ||
    config.fastMode !== undefined ||
    config.providerId !== undefined;

  const pickWorkingDir = async (): Promise<void> => {
    const result = await window.electronAPI.showOpenDirectoryDialog();
    if (!result.canceled && result.path) {
      await save({ ...config, workingDir: result.path });
    }
  };

  const labelCls = cn(
    'min-w-0 shrink-0 text-[var(--text-secondary)]',
    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
  );
  const row = (key: string, control: ReactNode): ReactNode => (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <span className={labelCls}>{t(`settings.ghosts.detail.errandPrefs.${key}`)}</span>
      {control}
    </div>
  );

  return (
    <div
      className={cn(
        'ghost-errand-prefs min-w-0 max-w-full flex flex-col gap-3 rounded-xl border px-5 py-4',
        appearance === 'plugin'
          ? 'border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]'
          : 'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-center gap-2">
        <Bot size={14} className="text-[var(--text-tertiary)]" />
        <p
          className={cn(
            'font-medium text-[var(--text-primary)]',
            appearance === 'plugin' ? 'text-14 leading-[22px]' : 'text-13',
          )}
        >
          {t('settings.ghosts.detail.errandPrefs.title')}
        </p>
        {pinned ? (
          <button
            type="button"
            onClick={() =>
              void save({
                ...config,
                agentKind: undefined,
                model: undefined,
                effort: undefined,
                fastMode: undefined,
                providerId: undefined,
              })
            }
            className="ml-auto text-12 text-[var(--text-tertiary)] underline-offset-2 hover:text-[var(--text-secondary)] hover:underline"
          >
            {t('settings.ghosts.detail.errandPrefs.resetFollow')}
          </button>
        ) : (
          <span className="ml-auto text-12 text-[var(--text-tertiary)]">
            {t('settings.ghosts.detail.errandPrefs.followDefault')}
          </span>
        )}
      </div>
      <p
        className={cn(
          'text-[var(--text-tertiary)]',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
        )}
      >
        {t('settings.ghosts.detail.errandPrefs.desc')}
      </p>

      {row(
        'agent',
        <VendorSegmentedSwitcher
          value={vendor}
          dense
          width={200}
          ariaLabel={t('settings.ghosts.detail.errandPrefs.agent')}
          onChange={(next) => {
            if (next === vendor && config.agentKind !== undefined) return;
            // 换/钉 agent 连带清掉模型组(跨 agent 的模型 id 互不通用);
            // 点击即钉住——分段控件没有"半跟随"态,想回跟随用右上角一键。
            void save({
              ...config,
              agentKind: next === 'codex' ? 'codex' : 'cc',
              model: undefined,
              effort: undefined,
              fastMode: undefined,
              providerId: undefined,
            });
          }}
        />,
      )}

      {row(
        'model',
        <div className="min-w-0 max-w-[60%]">
          <ModelSelector
            modelId={shownModel}
            effort={shownEffort}
            fastMode={shownFast}
            vendorKey={vendor}
            currentProviderId={config.providerId ?? null}
            triggerVariant="field"
            popoverSide="bottom"
            ariaContext={t('settings.ghosts.detail.errandPrefs.model')}
            onModelChange={(modelId) =>
              // 选模型即整组钉住(agent 一起钉,防草稿随后换 vendor 让模型悬空)。
              void save({ ...config, agentKind: vendor, model: modelId, effort: undefined })
            }
            onEffortChange={(effort) => {
              if (!ERRAND_EFFORTS.has(effort)) return;
              void save({ ...config, agentKind: vendor, model: shownModel, effort });
            }}
            onFastModeChange={(enabled) =>
              void save({ ...config, agentKind: vendor, model: shownModel, fastMode: enabled })
            }
            onProviderChange={(providerId, modelId) =>
              void save({
                ...config,
                agentKind: vendor,
                model: modelId ?? shownModel,
                providerId: providerId ?? undefined,
              })
            }
          />
        </div>,
      )}

      {row(
        'permission',
        <PermissionSelector
          permissionMode={config.permissionMode ?? 'plan'}
          vendorKey={vendor}
          triggerVariant="field"
          ariaContext={t('settings.ghosts.detail.errandPrefs.permission')}
          disabledModes={{
            ask: t('settings.ghosts.detail.errandPrefs.permissionDisabled'),
            default: t('settings.ghosts.detail.errandPrefs.permissionDisabled'),
            bypassPermissions: t('settings.ghosts.detail.errandPrefs.permissionDisabled'),
          }}
          onPermissionModeChange={(mode) => {
            // disabledModes 已灰置非法档;这里再执一道白名单(UI 不是安全边界,
            // 存储层与协议层各有一道,三道口径一致)。
            if (!PERMISSION_ALLOWED.has(mode)) return;
            void save({
              ...config,
              permissionMode: mode === 'plan' ? undefined : (mode as 'acceptEdits' | 'auto'),
            });
          }}
        />,
      )}

      {row(
        'workdir',
        <div className="flex min-w-0 max-w-[60%] items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-right text-[var(--text-tertiary)]',
              appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
            )}
            title={config.workingDir}
          >
            {config.workingDir ?? t('settings.ghosts.detail.errandPrefs.workdirDefault')}
          </span>
          {config.workingDir ? (
            <button
              type="button"
              onClick={() => void save({ ...config, workingDir: undefined })}
              aria-label={t('settings.ghosts.detail.errandPrefs.workdirClear')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
            >
              <X size={13} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void pickWorkingDir()}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-[var(--settings-input-text)] hover:bg-[var(--surface-hover)]',
              appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
            )}
          >
            <FolderOpen size={13} />
            {t('settings.ghosts.detail.errandPrefs.workdirPick')}
          </button>
        </div>,
      )}
    </div>
  );
}
