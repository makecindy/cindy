/**
 * LiveCompactCell — Settings → 实验功能区块下的「边做边压 Live Compact」一行。
 *
 * 开关决定**新会话**是否加载内置的 live-compact pi 扩展:
 *   - 关闭(默认): 不写扩展、不 --extension,行为与没有该扩展时完全一致。
 *   - 开启: maker-core 把扩展写进会话 internal-extensions,每轮结束时把已完成的
 *     一段对话压成一张本地卡片(要点 + 完整原文的本地路径),上下文涨得更慢。
 *
 * 与 LSP Beta 同一口径: 只对新会话生效 —— pi 进程启动时一次性决定是否加载,
 * 已开 session 不变,toggle 后 toast 明示。
 *
 * 没有独立 store/hook: 本行是这个开关唯一的消费者,直接 IPC + 本地 state。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('LiveCompactCell');

/** 原仓:本次移植的上游实现(MIT)。 */
const UPSTREAM_URL = 'https://github.com/MerkyorLynn/dsh-live-compact';

export function LiveCompactCell() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);

  // main 是唯一真源(设置文件);renderer 每次挂载时拉一次。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await window.electronAPI.maker.liveCompactGet();
        if (!cancelled) setEnabled(state.enabled);
      } catch (err) {
        log.warn('liveCompactGet failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleOpenUpstream = useCallback(async () => {
    try {
      const result = await window.electronAPI.openExternal(UPSTREAM_URL);
      if (!result.success) toast.error(t('settings.liveCompact.openFailed'));
    } catch {
      toast.error(t('settings.liveCompact.openFailed'));
    }
  }, [t]);

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.liveCompact.cell.title')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">
            {t('settings.liveCompact.cell.description')}
          </p>
          <button
            className="self-start text-12 text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]"
            onClick={() => void handleOpenUpstream()}
            title={UPSTREAM_URL}
            type="button"
          >
            {t('settings.liveCompact.cell.sourceLabel')}
          </button>
        </div>

        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={(v) => void handleToggle(v)}
          aria-label={t('settings.liveCompact.toggleAria')}
        />
      </div>
    </div>
  );
}
