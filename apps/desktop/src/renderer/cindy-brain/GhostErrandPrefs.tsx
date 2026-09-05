/**
 * Host-rendered errand (派活取件) preferences for a Plugin that declares
 * `agent.errand`. Settings 详情与 Plugin 详情共用(同 CindyCapabilityPrefs)。
 *
 * 选择器复用草稿页同一套组件(2026-07-31 Lizi 要求,不另搭下拉),展示与
 * 交互与新建对话一致,不暴露「跟随默认 / 钉住」这层概念:
 * - Agent = VendorSegmentedSwitcher(cc/codex/pi 分段);
 * - 模型/推理强度/Fast/供应商 = ModelSelector 的 field 形态,占满整行(标题在上、
 *   控件 w-full 在下,与 IM 默认配置同款);面板宽度绑定 trigger(DESIGN.md §4);
 * - 动手权限 = PermissionSelector(权限下拉全仓只此一份,不得私搭),
 *   errand 不允许的档位经 disabledModes 灰置并带原因。
 *
 * 底层仍是「未写的字段跟随草稿」语义(与 main 侧 errandPrefsStore 同一契约):
 * 没单独选过时实时展示并跟随「新建草稿」当前选择(草稿默认变,这里跟着变);
 * 用户一旦点选即把该组值钉进本插件配置。UI 不再显示跟随/恢复的文案 —— 呈现的
 * 永远是一个具体的当前模型+强度(2026-07-31 Lizi 要求)。权限档与工作目录是
 * errand 自己的事,不参与跟随:权限缺省 plan(只读,协议层不存在
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
  useNewMakerDraft,
} from '@/state/newMakerDraft';
import type { Effort } from '@/lib/userPreferences.types';

const PERMISSION_ALLOWED = new Set(['plan', 'acceptEdits', 'auto']);

/** errand 只收 worker 同集合的思考档(minimal 不收,与 main 侧存储层一致)。 */
const ERRAND_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

interface ErrandConfig {
  agentKind?: 'cc' | 'codex' | 'pi';
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
        return true;
      } catch {
        setConfig(prev);
        toast.error(t('settings.ghosts.errors.generic'));
        return false;
      }
    },
    [config, ghostId, t],
  );

  // 展示口径:钉住的值优先,没钉的跟随草稿(vendor → 该 vendor 的草稿模型
  // → 该模型的 per-model effort/fast 记忆)。
  // 跟随模型取 lastByVendor[vendor].model —— 与新建对话展示的当前模型同一份(sanitize
  // 保证非空,种子默认兜底)。不能用 getPersistedVendorModel:那是调度专用的严格口径,
  // 仅当用户在新建对话里显式选过该 vendor 模型才返回,否则返回 '',会让 trigger 落到
  // 「选择模型」占位(2026-07-31 Lizi 反馈:应像草稿一样直接显示当前模型)。
  const followVendor: 'cc' | 'codex' | 'pi' =
    draft.vendor === 'pi' ? 'pi' : draft.vendor === 'codex' ? 'codex' : 'cc';
  const vendor: 'cc' | 'codex' | 'pi' = config.agentKind ?? followVendor;
  const shownModel = config.model ?? draft.lastByVendor[vendor].model;
  const shownEffort = (config.effort ??
    getEffortForModel(shownModel) ??
    draft.lastByVendor[vendor]?.effort ??
    'high') as Effort;
  const shownFast = config.fastMode ?? getFastModeForModel(shownModel);

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
            appearance === 'plugin' ? 'text-14 leading-[1.571]' : 'text-13',
          )}
        >
          {t('settings.ghosts.detail.errandPrefs.title')}
        </p>
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
            // 换 agent 连带清掉模型组(跨 agent 的模型 id 互不通用);点选即把该组
            // 值钉进本插件配置(未选过时才实时跟随草稿)。
            save({
              ...config,
              agentKind: next === 'pi' ? 'pi' : next === 'codex' ? 'codex' : 'cc',
              model: undefined,
              effort: undefined,
              fastMode: undefined,
              providerId: undefined,
            });
          }}
        />,
      )}

      {/* 模型选择器占满整行(标题在上、控件 w-full 在下,与 IM 默认配置同款):
          field 形态的面板宽度绑定 trigger 宽度(DESIGN.md §4),压到 60% 会让下拉
          窄到把模型名截断,所以这里给它整行宽度。 */}
      <div className="flex min-w-0 flex-col gap-2">
        <span className={labelCls}>{t('settings.ghosts.detail.errandPrefs.model')}</span>
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
            save({ ...config, agentKind: vendor, model: modelId, effort: undefined })
          }
          onEffortChange={(effort) => {
            if (!ERRAND_EFFORTS.has(effort)) return;
            return save({ ...config, agentKind: vendor, model: shownModel, effort });
          }}
          onFastModeChange={(enabled) =>
            save({ ...config, agentKind: vendor, model: shownModel, fastMode: enabled })
          }
          onProviderChange={(providerId, modelId, reconciledEffort, reconciledFast) =>
            save({
              ...config,
              agentKind: vendor,
              model: modelId ?? shownModel,
              effort: ERRAND_EFFORTS.has(reconciledEffort ?? '')
                ? reconciledEffort
                : undefined,
              providerId: providerId ?? undefined,
              fastMode: reconciledFast ?? false,
            })
          }
        />
      </div>

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
            save({
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
              onClick={() => save({ ...config, workingDir: undefined })}
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
