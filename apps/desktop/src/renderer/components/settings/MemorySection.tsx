import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
/**
 * MemorySection — Settings → Personalization 下的 Memory 控制面板。
 * ---------------------------------------------------------------------------
 *
 * 数据流:
 *   - 加载: window.electronAPI.maker.memoryGet(agentKind) on mount + agent
 *           不支持时 (BaseAgent throw NotSupported) row 整行 disable
 *   - 切换: memorySet → 返回 effective + settings override state,
 *           'next-session' 时 toast 提示 "新会话生效"
 *   - 重置: 必走 useConfirmDialog 二次确认, 确认后 memoryReset → toast 反馈条目数
 *
 * 版式用 settings-rows 的分区/卡片/行, 每行左侧保留 agent 图标块。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { createLogger } from '@/lib/logger';
import { useMemorySettings } from '@/hooks/useMemorySettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('MemorySection');

type AgentKind = 'claude-code' | 'codex' | 'pi';

interface AgentDescriptor {
  kind: AgentKind;
  /** 本地化展示用的稳定 key 段，与 i18n 表 settings.memory.agents.<key>.* 对齐。
      品牌名 (Claude / Codex) 不翻译，由 i18n 表里的 label 字段提供。 */
  Mark: () => ReactNode;
  /** Pi 的压缩记忆写入 Cindy Memory；其开关仅在 Cindy Memory 启用时有意义。 */
  requiresMaker?: boolean;
}

const AGENTS: readonly AgentDescriptor[] = [
  {
    kind: 'claude-code',
    Mark: () => <ClaudeMark size={18} className="text-[var(--settings-section-title)]" />,
  },
  {
    kind: 'codex',
    Mark: () => <CodexMark size={18} className="text-[var(--settings-section-title)]" />,
  },
  {
    kind: 'pi',
    Mark: () => <PiMark size={18} className="text-[var(--settings-section-title)]" />,
    requiresMaker: true,
  },
] as const;

interface MemorySlotState {
  /** undefined = 加载中; null = 不支持 (NotSupported / IPC 异常) */
  enabled: boolean | null | undefined;
  /** 防 toggle race —— 网络飞行时禁掉点击 */
  pending: boolean;
}

const INITIAL: MemorySlotState = { enabled: undefined, pending: false };

export function MemorySection() {
  const settingsRevision = useAppSettingsRevision('memory');
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();
  // Maker Memory 启用时，下方 Claude Code / Codex 运行时的原生 toggle 强制 disable + 视觉变灰。
  // (manager.enable() 在 maker-core 层会自动调 setMemory(false), 这里 UI 防止用户
  // 在状态不同步的窗口里点击 toggle 引发误解)。
  const { makerEnabled, setMakerEnabled } = useMemorySettings();
  const [settingsCustomized, setSettingsCustomized] = useState(false);
  const [slots, setSlots] = useState<Record<AgentKind, MemorySlotState>>({
    'claude-code': INITIAL,
    codex: INITIAL,
    pi: INITIAL,
  });
  // pending 飞行中跳过 reload — 否则 toggle/reset 飞行期间 focus 触发 reload 会
  // 把用户刚改的乐观值或回滚状态覆盖掉。任一 slot pending 都跳过整轮 reload。
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  // 加载/刷新: 各 agent 独立, 一个失败不影响另一个 (Promise.allSettled)。
  // 触发时机:
  //   1. mount       — useEffect 首跑
  //   2. window focus — 兜底外部改动 (e.g. 用户手动删 ~/.claude/projects/*/memory/,
  //                     或另一个 desktop 实例改了 memory)。Settings tab 切换本身
  //                     已经走 conditional render → unmount/remount, 不需要这里管。
  //   3. Maker toggle — manager.enable() 联动调 setMemory(false) 后必须 reload,
  //                     否则下方 slots 显示 stale 旧值跟真实 agent state 不符
  const reloadSlots = useCallback(async () => {
    if (Object.values(slotsRef.current).some((s) => s.pending)) return;
    const results = await Promise.allSettled(
      AGENTS.map((a) => window.electronAPI.maker.memoryGet(a.kind)),
    );
    setSlots((prev) => {
      if (Object.values(prev).some((s) => s.pending)) return prev;
      const next = { ...prev };
      AGENTS.forEach((a, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
          next[a.kind] = { enabled: r.value.enabled, pending: false };
        } else {
          log.warn(`memoryGet(${a.kind}) failed`, r.reason);
          next[a.kind] = { enabled: null, pending: false };
        }
      });
      return next;
    });
  }, []);

  useEffect(() => {
    void reloadSlots();
    void window.electronAPI.maker.memoryGetSettingsState()
      .then((settings) => setSettingsCustomized(settings.isCustomized))
      .catch(() => undefined);
    const onFocus = () => void reloadSlots();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [reloadSlots, settingsRevision]);

  const handleResetSettings = useCallback(async () => {
    setMakerTogglePending(true);
    try {
      const settings = await window.electronAPI.maker.memoryResetSettings();
      setMakerEnabled(settings.maker);
      setSettingsCustomized(settings.isCustomized);
      await reloadSlots();
      // codexRestartDeferred: Codex 正忙时设置已生效, 只是存活会话要等任务结束后
      // 才换到新状态 — 信息性后缀, 不用 warning (同 per-agent 'next-session' 语义)。
      const suffix = settings.codexRestartDeferred
        ? t('settings.memory.maker.toast.deferredSuffix')
        : '';
      toast.success(`${t('settings.defaults.restored')}${suffix}`);
    } catch (err) {
      log.warn('memoryResetSettings failed', err);
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setMakerTogglePending(false);
    }
  }, [reloadSlots, setMakerEnabled, t]);

  const handleToggle = useCallback(
    async (kind: AgentKind, next: boolean, label: string) => {
      setSlots((prev) => ({ ...prev, [kind]: { enabled: prev[kind].enabled, pending: true } }));
      try {
        const result = await window.electronAPI.maker.memorySet(kind, next);
        setSlots((prev) => ({ ...prev, [kind]: { enabled: next, pending: false } }));
        setSettingsCustomized(result.isCustomized);
        // 操作本身成功 → success(绿). next-session 只是信息性后缀, 不用 warning ——
        // 警告色会让用户误以为出错。文案 suffix 已经把 "新会话生效" 说清楚了。
        const suffix =
          result.effective === 'next-session' ? t('settings.memory.agent.toast.takesEffectSuffix') : '';
        const baseKey = next
          ? 'settings.memory.agent.toast.enabled'
          : 'settings.memory.agent.toast.disabled';
        toast.success(`${t(baseKey, { label })}${suffix}`);
      } catch (err) {
        log.warn(`memorySet(${kind}) failed`, err);
        toast.error(
          err instanceof Error ? err.message : t('settings.memory.agent.toast.toggleFailed'),
        );
        setSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], pending: false } }));
      }
    },
    [t],
  );

  // Maker toggle: 先 await IPC (manager.enable/disable + 联动 setMemory(false)),
  // 成功后更新 store + reload native slots (避免显示 stale 旧值)。
  const [makerTogglePending, setMakerTogglePending] = useState(false);
  const handleMakerToggle = useCallback(
    async (next: boolean) => {
      // 乐观更新: 立即翻 toggle 视觉, 让用户感觉跟手 (IPC 内部调用几乎不会失败)
      const prev = makerEnabled;
      setMakerEnabled(next);
      setMakerTogglePending(true);
      try {
        const result = await window.electronAPI.maker.makerMemorySetEnabled(next);
        setSettingsCustomized(result.isCustomized);
        // enable 时联动调过 setMemory(false) → 下方 slots 真实 state 已变, 必须 reload
        // disable 不动 native, 但仍 reload 一次保证 UI 跟实际对齐 (零成本兜底)
        await reloadSlots();
        // codexRestartDeferred: Codex 正忙, 存活会话等任务结束后自动换新状态。
        // 操作本身成功 → success(绿) + 信息性后缀, 同 per-agent 'next-session' 处理。
        const suffix = result.codexRestartDeferred
          ? t('settings.memory.maker.toast.deferredSuffix')
          : '';
        toast.success(
          `${t(next ? 'settings.memory.maker.toast.enabled' : 'settings.memory.maker.toast.disabled')}${suffix}`,
        );
      } catch (err) {
        log.warn('makerMemorySetEnabled failed', err);
        toast.error(
          err instanceof Error ? err.message : t('settings.memory.maker.toast.toggleFailed'),
        );
        setMakerEnabled(prev); // 回滚乐观值
      } finally {
        setMakerTogglePending(false);
      }
    },
    [makerEnabled, setMakerEnabled, reloadSlots, t],
  );

  // Maker Memory 整库重置 — 删 <userData>/maker-memory/ 全部 workdir 目录,
  // 不论当前 makerEnabled 值 (即使关着也能清, 跟 native reset 同语义)。
  const [makerResetPending, setMakerResetPending] = useState(false);
  const handleMakerReset = useCallback(async () => {
    const ok = await confirm({
      title: t('settings.memory.maker.resetConfirm.title'),
      description: t('settings.memory.maker.resetConfirm.description'),
      confirmText: t('settings.memory.maker.resetConfirm.confirm'),
      cancelText: t('settings.memory.maker.resetConfirm.cancel'),
    });
    if (!ok) return;
    setMakerResetPending(true);
    try {
      const result = await window.electronAPI.maker.makerMemoryReset();
      toast.success(
        t('settings.memory.maker.toast.resetSuccess', { count: result.removedCount }),
      );
    } catch (err) {
      log.warn('makerMemoryReset failed', err);
      toast.error(
        err instanceof Error ? err.message : t('settings.memory.maker.toast.resetFailed'),
      );
    } finally {
      setMakerResetPending(false);
    }
  }, [confirm, t]);

  const handleReset = useCallback(
    async (kind: AgentKind, label: string) => {
      // Reset 全局 (跨 cwd) 删, 必须二次确认。文案显示真实 agent 品牌名 + 强调 "all"。
      const ok = await confirm({
        title: t('settings.memory.agent.resetConfirm.title', { label }),
        description: t('settings.memory.agent.resetConfirm.description', { label }),
        confirmText: t('settings.memory.agent.resetConfirm.confirm'),
        cancelText: t('settings.memory.agent.resetConfirm.cancel'),
      });
      if (!ok) return;
      setSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], pending: true } }));
      try {
        const result = await window.electronAPI.maker.memoryReset(kind);
        setSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], pending: false } }));
        // removedEntries 子类按需提供 (Codex 留 undefined), 缺省时给通用 fallback。
        if (typeof result.removedEntries === 'number') {
          toast.success(
            t('settings.memory.agent.toast.resetSuccess', {
              label,
              count: result.removedEntries,
            }),
          );
        } else {
          toast.success(t('settings.memory.agent.toast.resetSuccessGeneric', { label }));
        }
      } catch (err) {
        log.warn(`memoryReset(${kind}) failed`, err);
        toast.error(
          err instanceof Error ? err.message : t('settings.memory.agent.toast.resetFailed'),
        );
        setSlots((prev) => ({ ...prev, [kind]: { ...prev[kind], pending: false } }));
      }
    },
    [confirm, t],
  );

  return (
    <SettingsSection
      title={t('settings.memory.title')}
      description={t('settings.memory.description')}
      action={
        <DefaultOverrideControls
          isCustomized={settingsCustomized}
          disabled={makerTogglePending}
          onReset={() => void handleResetSettings()}
        />
      }
    >
      <SettingsCard>
        {/* Maker Memory cell — 顶部独立, 启用时下方 Claude / Codex 强制 disable + 视觉变灰 */}
        <SettingsRow
          lead={
            <span
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Sparkles size={18} className="text-[var(--settings-section-title)]" />
            </span>
          }
          title={t(personalizationDetailsSettings.memoryMakerLabel.titleKey)}
          hint={t(personalizationDetailsSettings.memoryMakerLabel.descriptionKey)}
          trailing={
            <div className="flex items-center gap-2">
              <Switch data-setting-id={personalizationDetailsSettings.memoryMakerLabel.id}
                checked={makerEnabled}
                disabled={makerResetPending || makerTogglePending}
                onCheckedChange={(v) => void handleMakerToggle(v)}
                aria-label={t('settings.memory.maker.toggleAria')}
              />
              <button data-setting-id={personalizationDetailsSettings.memoryMakerLabel.id}
                type="button"
                onClick={() => void handleMakerReset()}
                disabled={makerResetPending || makerTogglePending}
                aria-label={t('settings.memory.maker.resetAria')}
                className={cn(
                  'flex h-[30px] w-[30px] items-center justify-center rounded-lg',
                  'text-[var(--settings-section-desc)]',
                  'hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
                  'transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                )}
              >
                <RotateCcw size={16} />
              </button>
            </div>
          }
        />

        {AGENTS.map((agent) => {
          const slot = slots[agent.kind];
          const supported = slot.enabled !== null;
          const loading = slot.enabled === undefined;
          const checked = slot.enabled === true;
          const disabled = (agent.requiresMaker ? !makerEnabled : makerEnabled)
            || !supported || slot.pending || loading;
          // Agent label/description 来自 i18n 表 (品牌名 Claude / Codex 也走 i18n
          // —— 各语种都保留品牌原文，只方便统一管理)。
          const definition = agent.kind === 'claude-code' ? personalizationDetailsSettings.memoryAgentsClaudeCodeLabel : agent.kind === 'codex' ? personalizationDetailsSettings.memoryAgentsCodexLabel : personalizationDetailsSettings.memoryAgentsPiLabel;
          const label = t(definition.titleKey);
          const description = t(definition.descriptionKey);
          return (
            <SettingsRow
              key={agent.kind}
              className={cn((agent.requiresMaker ? !makerEnabled : makerEnabled) && 'opacity-50')}
              lead={
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    'bg-[var(--settings-input-bg)]',
                  )}
                >
                  <agent.Mark />
                </span>
              }
              title={label}
              hint={description}
              trailing={
                <div className="flex items-center gap-2">
                  <Switch data-setting-id={definition.id}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(v) => void handleToggle(agent.kind, v, label)}
                    aria-label={t('settings.memory.agent.toggleAria', { label })}
                  />
                  <button data-settings-search-action="Restore the selected memory preference"
                    type="button"
                    onClick={() => void handleReset(agent.kind, label)}
                    disabled={disabled}
                    aria-label={t('settings.memory.agent.resetAria', { label })}
                    className={cn(
                      'flex h-[30px] w-[30px] items-center justify-center rounded-lg',
                      'text-[var(--settings-section-desc)]',
                      'hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
                      'transition-colors',
                      'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
                    )}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              }
            />
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}
