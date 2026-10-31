/**
 * PluginControlPointsSection — 插件详情页「运行前检查」(控制节点，2026-10-31)。
 * ---------------------------------------------------------------------------
 * 只读列出本插件能做的运行前检查(自动化运行前、例行任务运行前 …)。插件不会自动管所有
 * 任务：用户在具体任务的「前置检查」里选它，出错处理也在那里按任务设置。声明了但用户
 * 还没在安装/更新确认里批准的节点显示「还不能使用」。
 *
 * - 只在本机已安装插件渲染；数据走 Desktop 专用 IPC `ghosts:control-points:get`；
 * - 颜色只用语义 token，Light / Dark 由主题变量自动适配。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { GhostControlPointInfo } from '../../../shared/ghost';

const SECTION_CLASS = 'mt-10';
const HEADING_CLASS = 'text-18 font-medium leading-[1.444] text-[var(--text-primary)]';
const SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';

export function PluginControlPointsSection({ ghostId, declared }: { ghostId: string; declared: boolean }) {
  if (!declared) return null;
  return <PluginControlPointsSectionInner ghostId={ghostId} />;
}

function PluginControlPointsSectionInner({ ghostId }: { ghostId: string }) {
  const { t } = useTranslation();
  const [points, setPoints] = useState<GhostControlPointInfo[]>([]);

  useEffect(() => {
    let alive = true;
    window.electronAPI.ghosts
      .getControlPoints(ghostId)
      .then((list) => alive && setPoints(list))
      .catch(() => alive && setPoints([]));
    return () => {
      alive = false;
    };
  }, [ghostId]);

  if (points.length === 0) return null;

  return (
    <section className={SECTION_CLASS} aria-labelledby="ghost-control-points-title">
      <h2 id="ghost-control-points-title" className={HEADING_CLASS}>
        {t('settings.ghosts.controlPoints.title')}
      </h2>
      <p className="mt-2 max-w-[760px] text-13 leading-5 text-[var(--text-secondary)]">
        {t('settings.ghosts.controlPoints.description')}
      </p>
      <ul className={cn(SURFACE_CLASS, 'mt-5 max-w-[760px] divide-y divide-[var(--border-default)] rounded-xl')}>
        {points.map((point) => (
          <li key={point.id} className="px-5 py-3.5">
            <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
              {t(`settings.ghosts.controlPoints.points.${point.id}`)}
            </p>
            <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
              {t(point.active ? 'settings.ghosts.controlPoints.usage' : 'settings.ghosts.controlPoints.inactive')}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
