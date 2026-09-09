import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpenCheck,
  FileText,
  FlaskConical,
  GitBranch,
  GitPullRequest,
  Globe,
  Radar,
  SlidersHorizontal,
  Sparkles,
  Telescope,
  Timer,
  type LucideProps,
} from 'lucide-react';
import type { ScheduleTemplate, TemplateCapability } from '@cindy/maker-scheduler';

import { cn } from '@/lib/utils';
import { cronToHuman } from '../lib/cronToHuman';

interface TemplateCardProps {
  template: ScheduleTemplate;
  selected?: boolean;
  onSelect: (template: ScheduleTemplate) => void;
}

export function TemplateCard({ template, selected = false, onSelect }: TemplateCardProps) {
  const { t, i18n } = useTranslation();
  const Icon = iconForTemplate(template.id);
  const scheduleText = template.cronExpr
    ? cronToHuman(template.cronExpr, t, i18n.resolvedLanguage ?? i18n.language)
    : '';
  // user/project 模板的 capabilities 不受包词表约束：Object.hasOwn（而不是 in）挡住
  // 'toString' 这类原型链 key，Set 去重避免重复项撞 React key。
  const capabilities = [...new Set(template.capabilities ?? [])].filter(
    (capability): capability is TemplateCapability => Object.hasOwn(CAPABILITY_ICONS, capability),
  );

  return (
    <button
      type="button"
      onClick={() => onSelect(template)}
      aria-pressed={selected}
      className={cn(
        'flex min-h-[136px] w-full flex-col items-start gap-2 rounded-xl border p-4 text-left',
        'bg-[var(--cmd-palette-bg)] transition-colors duration-150 hover:cursor-pointer hover:bg-[var(--surface-hover)]',
        selected
          ? 'border-[1.5px] border-[var(--settings-theme-preview-border-active)]'
          : 'border-[var(--cmd-palette-border)]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
          <Icon size={13} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 truncate text-14 font-medium leading-[1.33] text-[var(--msg-assistant-text)]">
          {template.name}
        </span>
      </div>

      <p
        className="min-h-[34px] text-12 font-normal leading-[1.43] text-[var(--settings-section-desc)]"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {template.description}
      </p>

      <span className="mt-auto flex max-w-full flex-wrap items-center gap-1.5">
        {scheduleText && (
          <span className="inline-flex h-5 max-w-full items-center gap-[5px] rounded-full bg-[var(--chat-input-chip-bg)] px-2 text-11 leading-none text-[var(--settings-section-desc)]">
            <Timer size={10} strokeWidth={1.8} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
            <span className="truncate">{scheduleText}</span>
          </span>
        )}
        {capabilities.map((capability) => {
          const CapabilityIcon = CAPABILITY_ICONS[capability];
          return (
            <span
              key={capability}
              className="inline-flex h-5 items-center gap-[5px] rounded-full bg-[var(--chat-input-chip-bg)] px-2 text-11 leading-none text-[var(--settings-section-desc)]"
            >
              <CapabilityIcon
                size={10}
                strokeWidth={1.8}
                className="shrink-0 text-[var(--cmd-palette-item-meta)]"
              />
              <span className="truncate">{t(`scheduler.template.capability.${capability}`)}</span>
            </span>
          );
        })}
      </span>
    </button>
  );
}

const CAPABILITY_ICONS: Record<TemplateCapability, ComponentType<LucideProps>> = {
  worktree: GitBranch,
  pr: GitPullRequest,
  web: Globe,
  params: SlidersHorizontal,
};

function iconForTemplate(id: string): ComponentType<LucideProps> {
  switch (id) {
    case 'nightly-test-heal':
      return FlaskConical;
    case 'pr-gatekeeper':
      return GitPullRequest;
    case 'domain-radar':
      return Radar;
    case 'competitor-watch':
      return Telescope;
    case 'weekly-work-draft':
      return FileText;
    case 'knowledge-freshness':
      return BookOpenCheck;
    default:
      return Sparkles;
  }
}
