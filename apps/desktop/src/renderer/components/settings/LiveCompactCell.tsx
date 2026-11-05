/**
 * LiveCompactCell — Settings → 实验功能区块下的「边做边压 Live Compact」一行。
 *
 * 开关决定**之后启动的 Pi 任务**是否加载内置的 Live Compact pi 扩展:
 *   - 关闭(默认): 不写扩展、不 --extension,行为与没有该扩展时完全一致。
 *   - 开启: maker-core 把扩展写进会话 internal-extensions,每轮结束时把已完成的
 *     一段对话压成一张本地卡片(要点 + 完整原文的本地路径),上下文涨得更慢。
 *
 * 与 LSP Beta 同一口径: pi 进程启动时一次性决定是否加载 —— 新任务和重新打开的
 * 历史任务都算「启动」,已在运行的 session 不变,toggle 后 toast 明示。
 *
 * 子行(影子原文): 扩展把被切走的原文写到 <agentHome>/compaction-spine/,这里报体积、
 * 提供打开目录与清理。放在开关下方而不是「存储空间」页:它只对这个功能有意义。
 *
 * 没有独立 store/hook: 本行是这个开关唯一的消费者,直接 IPC + 本地 state。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { liveCompactSettings } from './LiveCompactCell.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

const log = createLogger('LiveCompactCell');

/** 原仓:本次移植的上游实现(MIT)。 */
const UPSTREAM_URL = 'https://github.com/MerkyorLynn/dsh-live-compact';

export function LiveCompactCell() {
  const { t } = useTranslation();
  const setting = useSettingDefinition(liveCompactSettings.enable);
  const shadowSetting = useSettingDefinition(liveCompactSettings.shadow);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  // 首屏拉取期间禁用:避免「读到之前一律显示关闭」误导用户动手点。
  const [loading, setLoading] = useState(true);
  const [shadowBytes, setShadowBytes] = useState<number | null>(null);
  const [shadowBusy, setShadowBusy] = useState(false);

  // main 是唯一真源(设置文件);renderer 每次挂载时拉一次。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await window.electronAPI.maker.liveCompactGet();
        if (!cancelled) setEnabled(state.enabled);
      } catch (err) {
        log.warn('liveCompactGet failed', err);
        if (!cancelled) toast.error(t('settings.liveCompact.toast.readFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      setPending(true);
      try {
        await window.electronAPI.maker.liveCompactSet(next);
        toast.success(
          next
            ? t('settings.liveCompact.toast.enabled')
            : t('settings.liveCompact.toast.disabled'),
        );
      } catch (err) {
        log.warn('liveCompactSet failed', err);
        toast.error(
          err instanceof Error ? err.message : t('settings.liveCompact.toast.toggleFailed'),
        );
        setEnabled(prev);
      } finally {
        setPending(false);
      }
    },
    [enabled, t],
  );

  const refreshShadow = useCallback(async () => {
    try {
      const stats = await window.electronAPI.cindyMediaStorage.spineStats();
      setShadowBytes(stats.bytes);
    } catch (err) {
      log.warn('spineStats failed', err);
    }
  }, []);

  useEffect(() => {
    void refreshShadow();
  }, [refreshShadow]);

  const handleOpenShadowDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.cindyMediaStorage.openSpineDir();
      if (!result.opened) toast.info(t('settings.liveCompact.shadow.directoryMissing'));
    } catch {
      toast.error(t('settings.liveCompact.shadow.openFailed'));
    }
  }, [t]);

  const handleClearShadow = useCallback(async () => {
    if (shadowBusy) return;
    setShadowBusy(true);
    try {
      const result = await window.electronAPI.cindyMediaStorage.clearSpineDir();
      if (!result.cleared) return;
      toast.success(t('settings.liveCompact.shadow.cleared'));
      void refreshShadow();
    } catch {
      toast.error(t('settings.liveCompact.shadow.clearFailed'));
    } finally {
      setShadowBusy(false);
    }
  }, [shadowBusy, refreshShadow, t]);

  const handleOpenUpstream = useCallback(async () => {
    try {
      const result = await window.electronAPI.openExternal(UPSTREAM_URL);
      if (!result.success) toast.error(t('settings.liveCompact.openFailed'));
    } catch {
      toast.error(t('settings.liveCompact.openFailed'));
    }
  }, [t]);

  return (
    <div {...setting.anchorProps} className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {setting.title}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">
            {setting.description}{' '}
            <button
              className="inline text-inherit underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]"
              data-settings-search-action="opens the upstream project page"
              onClick={() => void handleOpenUpstream()}
              title={UPSTREAM_URL}
              type="button"
            >
              {t('settings.liveCompact.cell.sourceLabel')}
            </button>
          </p>
        </div>

        <Switch
          {...setting.controlProps}
          checked={enabled}
          disabled={pending || loading}
          onCheckedChange={(v) => void handleToggle(v)}
          aria-label={t('settings.liveCompact.toggleAria')}
        />
      </div>

      {/* 子项:分隔线左右都缩进、内容左缩进,视觉上从属于上面的开关而不是并列的第二栏;
          字号与其它行一致,从属关系只靠缩进表达。 */}
      <div className="mt-3">
        <div aria-hidden className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />
        <div className="mt-3 flex items-center justify-between gap-3 pl-4" {...shadowSetting.anchorProps}>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-12 text-[var(--text-secondary)]">
              {shadowSetting.title}
              {' · '}
              {shadowBytes === null ? t('settings.about.storage.unknown') : formatBytes(shadowBytes)}
            </span>
            <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">
              {shadowSetting.description}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              compact
              type="button"
              data-settings-search-action="opens the shadow directory in the file manager"
              onClick={() => void handleOpenShadowDir()}
            >
              {t('settings.liveCompact.shadow.openButton')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              compact
              type="button"
              data-settings-search-action="deletes the stored shadow snapshots"
              onClick={() => void handleClearShadow()}
              disabled={shadowBusy}
              aria-busy={shadowBusy || undefined}
            >
              {t('settings.liveCompact.shadow.clearButton')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
