/**
 * Host-rendered errand (派活取件) preferences for a Plugin that declares
 * `agent.errand`. Settings 详情与 Plugin 详情共用(同 CindyCapabilityPrefs)。
 *
 * 配置语义(与 main 侧 errandPrefsStore 同一契约):
 * - 全部字段缺省 = 跟随「新建草稿」偏好;agent 跟随默认时,模型/强度/Fast
 *   一并跟随(锁定不可单独配),先选定 agent 才谈得上给它挑模型;
 * - 权限档只有 只读(默认)/可改文件/自动 三档——「完全不设防」在协议上
 *   就不存在(2026-07-31 定案),这里画不出来也传不上去;
 * - 工作目录缺省是插件专属文件夹,选真实项目目录必须经系统选文件夹窗口
 *   (用户亲手选中即授权,与 pick 槽同一哲学)。
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, FolderOpen, X } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useAgentCapabilities, type AgentKind } from '@/hooks/useAgentCapabilities';

/** 跟随默认在 select 里的哨兵值(配置里"没有这项"= 跟随默认)。 */
const FOLLOW_DEFAULT_VALUE = '__default__';

const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto'] as const;
type ErrandPermissionMode = (typeof PERMISSION_MODES)[number];

/** errand 只收 worker 同集合的思考档(minimal 不收,与 main 侧存储层一致)。 */
const ERRAND_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

interface ErrandConfig {
  agentKind?: 'cc' | 'codex';
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string;
  permissionMode?: ErrandPermissionMode;
  workingDir?: string;
}

function vendorOf(config: ErrandConfig): AgentKind | null {
  if (config.agentKind === 'cc') return 'claude-code';
  if (config.agentKind === 'codex') return 'codex';
  return null;
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
  const vendor = vendorOf(config);
  // agent 跟随默认时不拉能力表(hook 收 null 即挂起),模型/强度/Fast 行锁定。
  const { capabilities } = useAgentCapabilities(vendor);

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

  const labelCls = cn(
    'min-w-0 text-[var(--text-secondary)]',
    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
  );
  const selectCls = cn(
    'h-8 w-[300px] max-w-[60%] min-w-0 shrink appearance-none rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] py-0 pl-3 pr-8 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:opacity-50',
    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
  );

  // agent 显式选定后才有可配的模型清单;模型选定后强度跟着该模型的支持集走。
  const models = (capabilities?.availableModels ?? []).filter((m) => m.defaultEnabled !== false);
  const selectedModel = config.model ? models.find((m) => m.id === config.model) : undefined;
  const effortOptions = (
    selectedModel ? selectedModel.efforts : (capabilities?.effortLevels ?? []).map((e) => e.id)
  ).filter((e) => ERRAND_EFFORTS.has(e));
  const fastSupported =
    vendor !== null &&
    (capabilities?.hasFastMode ?? false) &&
    (selectedModel ? selectedModel.supportsFastMode !== false : true);

  const pickWorkingDir = async (): Promise<void> => {
    const result = await window.electronAPI.showOpenDirectoryDialog();
    if (!result.canceled && result.path) {
      await save({ ...config, workingDir: result.path });
    }
  };

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
        <select
          value={config.agentKind ?? FOLLOW_DEFAULT_VALUE}
          onChange={(event) => {
            const v = event.target.value;
            // 换 agent 连带清掉模型/强度/Fast(跨 agent 的模型 id 互不通用)。
            void save({
              ...config,
              agentKind: v === FOLLOW_DEFAULT_VALUE ? undefined : (v as 'cc' | 'codex'),
              model: undefined,
              effort: undefined,
              fastMode: undefined,
            });
          }}
          aria-label={t('settings.ghosts.detail.errandPrefs.agent')}
          className={selectCls}
        >
          <option value={FOLLOW_DEFAULT_VALUE}>
            {t('settings.ghosts.detail.errandPrefs.followDefault')}
          </option>
          <option value="cc">Claude Code</option>
          <option value="codex">Codex</option>
        </select>,
      )}

      {row(
        'model',
        <select
          value={config.model ?? FOLLOW_DEFAULT_VALUE}
          disabled={vendor === null || models.length === 0}
          onChange={(event) => {
            const v = event.target.value;
            void save({
              ...config,
              model: v === FOLLOW_DEFAULT_VALUE ? undefined : v,
              // 模型换了,旧强度可能不在新模型支持集里,一并回跟随。
              effort: undefined,
            });
          }}
          aria-label={t('settings.ghosts.detail.errandPrefs.model')}
          className={selectCls}
        >
          <option value={FOLLOW_DEFAULT_VALUE}>
            {t('settings.ghosts.detail.errandPrefs.followDefault')}
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>,
      )}

      {row(
        'effort',
        <select
          value={config.effort ?? FOLLOW_DEFAULT_VALUE}
          disabled={vendor === null || effortOptions.length === 0}
          onChange={(event) => {
            const v = event.target.value;
            void save({ ...config, effort: v === FOLLOW_DEFAULT_VALUE ? undefined : v });
          }}
          aria-label={t('settings.ghosts.detail.errandPrefs.effort')}
          className={selectCls}
        >
          <option value={FOLLOW_DEFAULT_VALUE}>
            {t('settings.ghosts.detail.errandPrefs.followDefault')}
          </option>
          {effortOptions.map((effort) => (
            <option key={effort} value={effort}>
              {capabilities?.effortLevels.find((e) => e.id === effort)?.displayName ?? effort}
            </option>
          ))}
        </select>,
      )}

      {fastSupported
        ? row(
            'fast',
            <select
              value={
                config.fastMode === undefined ? FOLLOW_DEFAULT_VALUE : config.fastMode ? 'on' : 'off'
              }
              onChange={(event) => {
                const v = event.target.value;
                void save({
                  ...config,
                  fastMode: v === FOLLOW_DEFAULT_VALUE ? undefined : v === 'on',
                });
              }}
              aria-label={t('settings.ghosts.detail.errandPrefs.fast')}
              className={selectCls}
            >
              <option value={FOLLOW_DEFAULT_VALUE}>
                {t('settings.ghosts.detail.errandPrefs.followDefault')}
              </option>
              <option value="on">{t('settings.ghosts.detail.errandPrefs.fastOn')}</option>
              <option value="off">{t('settings.ghosts.detail.errandPrefs.fastOff')}</option>
            </select>,
          )
        : null}

      {row(
        'permission',
        <select
          value={config.permissionMode ?? 'plan'}
          onChange={(event) => {
            const v = event.target.value as ErrandPermissionMode;
            // 'plan' 是缺省档:选回它就清掉显式配置(规则 20:覆盖与默认分开记)。
            void save({ ...config, permissionMode: v === 'plan' ? undefined : v });
          }}
          aria-label={t('settings.ghosts.detail.errandPrefs.permission')}
          className={selectCls}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`settings.ghosts.detail.errandPrefs.permissionMode.${mode}`)}
            </option>
          ))}
        </select>,
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
