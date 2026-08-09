/**
 * Compact accordion row for one IM channel (personal and Cindy groups).
 *
 * The row remains useful while collapsed: it shows transport status and the
 * channel's own Agent/model route. Only one row is expanded per group, so
 * adding more channel types does not make the settings page grow linearly.
 *
 * `headerAction` (e.g. the Cindy channels' enable Switch) renders as a
 * sibling of the toggle button, not inside it — nesting interactive controls
 * inside a <button> is invalid HTML and would fire expand on every click.
 */

import { ChevronDown } from 'lucide-react';
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import { Collapse } from '@/components/ui/collapse';
import { cn } from '@/lib/utils';
import type { ImDefaultSettingsChannel } from '../../../shared/imDefaultSettings';
import type { ImDefaultSettingsSummary } from './ImDefaultSettingsSection';

export function useImChannelSettingsSummary(
  channel: ImDefaultSettingsChannel,
): [ImDefaultSettingsSummary | null, Dispatch<SetStateAction<ImDefaultSettingsSummary | null>>] {
  const [summary, setSummary] = useState<ImDefaultSettingsSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .imDefaultSettingsGet(channel)
      .then((settings) => {
        if (cancelled) return;
        setSummary({
          agentKind: settings.agentKind,
          model: settings.agents[settings.agentKind].model,
        });
      })
      .catch(() => {
        // The full editor reports actionable load errors when the row opens.
      });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  return [summary, setSummary];
}

export function ImChannelSettingsCard({
  id,
  title,
  description,
  status,
  routeSummary,
  headerAction,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  description: string;
  status: ReactNode;
  routeSummary: ReactNode;
  /** 头部行尾的独立控件(如启用 Switch);点击它不触发展开/收起。 */
  headerAction?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const triggerId = `${id}-trigger`;
  const panelId = `${id}-panel`;

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl',
        'border border-[var(--settings-theme-card-border)]',
        'bg-[var(--settings-theme-card-bg)]',
      )}
    >
      {/* hover 高亮挂在整行容器上: headerAction 在按钮外, 挂按钮会让行尾
          (开关区)缺一截高亮 */}
      <div className="flex items-center transition-colors hover:bg-[var(--surface-hover-soft)]">
        <button
          type="button"
          id={triggerId}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(
            'flex min-h-[76px] min-w-0 flex-1 select-none items-center gap-4 px-4 py-3 text-left',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-14 font-medium leading-[1.3] text-[var(--settings-section-title)]">
              {title}
            </span>
            <span className="mt-1 block text-12 leading-[1.45] text-[var(--settings-section-desc)]">
              {description}
            </span>
          </span>

          <span className="flex min-w-0 shrink-0 items-center gap-3">
            <span className="hidden w-[220px] truncate text-right text-12 text-[var(--text-secondary)] md:block">
              {routeSummary}
            </span>
            {status}
            <ChevronDown
              size={17}
              aria-hidden
              className={cn(
                'shrink-0 text-[var(--settings-section-desc)]',
                'transition-transform duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:duration-0',
                expanded && 'rotate-180',
              )}
            />
          </span>
        </button>
        {headerAction ? (
          <span className="flex shrink-0 items-center pr-4">{headerAction}</span>
        ) : null}
      </div>

      <Collapse
        open={expanded}
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        innerClassName="border-t border-[var(--settings-theme-card-border)]"
      >
        <div className="flex flex-col gap-5 p-4">{children}</div>
      </Collapse>
    </section>
  );
}
