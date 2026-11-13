import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { TeamOption } from '../lib/marketDetailViewModel';
import type { PublisherMode } from '../lib/publishForm';

// 与 PublishDialog 的 FieldLabel 同款(13px 弱化标题),保持表单标签视觉一致
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block px-0.5 text-13 font-medium text-[var(--settings-section-desc)]">
      {children}
    </label>
  );
}

/** 下拉面板里的分组标题(部门 / 团队) */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-10 text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

/** 下拉面板里的单个可选项 */
function OptionRow({
  name,
  selected,
  locked,
  lockedTag,
  disabled,
  onToggle,
}: {
  name: string;
  selected: boolean;
  /** 锁定项:始终选中且不可取消(发布团队天然可见) */
  locked?: boolean;
  lockedTag?: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || locked}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
        'text-[var(--msg-assistant-text)] transition-colors',
        !disabled && !locked && 'hover:bg-[var(--surface-hover)]',
        disabled && 'cursor-not-allowed opacity-60',
        locked && 'cursor-default opacity-80',
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {selected && <Check size={14} strokeWidth={2.25} />}
      </span>
      <span className="min-w-0 truncate">{name}</span>
      {locked && lockedTag && (
        <span className="ml-auto shrink-0 text-10 text-[var(--text-tertiary)]">{lockedTag}</span>
      )}
    </button>
  );
}

/**
 * 分组下拉框(发布团队=单选、谁可以使用=多选共用同一外观)。
 * 面板走 Radix Popover Portal,浮在 Dialog 之上,不会被弹窗的
 * overflow / 圆角裁切(之前手写 absolute 面板会"漏"到弹窗外)。
 */
function ScopeDropdown({
  summary,
  placeholder,
  disabled,
  children,
}: {
  /** 触发按钮上显示的已选摘要,null = 显示 placeholder */
  summary: string | null;
  placeholder: string;
  disabled?: boolean;
  /** 面板内容,拿到 close 回调(单选场景选完即关) */
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-full border px-3 text-sm',
            'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
            'border-[var(--settings-input-border)]',
            'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
            'transition-colors',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <span className={cn('min-w-0 truncate text-left', !summary && 'text-[var(--settings-input-placeholder)]')}>
            {summary ?? placeholder}
          </span>
          <ChevronDown
            size={14}
            className={cn('shrink-0 text-[var(--settings-section-desc)] transition-transform', open && 'rotate-180')}
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'z-[10010] max-h-52 w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-xl border p-1',
            'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
            '[box-shadow:var(--cmd-palette-shadow)]',
          )}
        >
          {children(() => setOpen(false))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── PublisherPicker:发布者(个人/团队)选择,公开/团队两档可见性下都显示 ──────

type PublisherPickerProps = {
  mode: PublisherMode;
  ownerTeamSlug: string;
  deptIds: string[];
  deptNames: string[];
  teams: TeamOption[];
  disabled?: boolean;
  /** 仅禁用「团队」卡(私有档强制个人归属时用) */
  teamChoiceDisabled?: boolean;
  onChange: (next: { mode: PublisherMode; ownerTeamSlug: string }) => void;
};

export function PublisherPicker({
  mode,
  ownerTeamSlug,
  deptIds,
  deptNames,
  teams,
  disabled = false,
  teamChoiceDisabled = false,
  onChange,
}: PublisherPickerProps) {
  const { t } = useTranslation();
  const hasTeamOptions = deptIds.length > 0 || teams.length > 0;

  const choices: Array<{ value: PublisherMode; title: string; desc: string; disabled: boolean }> = [
    {
      value: 'personal',
      title: t('skillhub.publishDialog.publisherPersonal'),
      desc: t('skillhub.publishDialog.publisherPersonalDesc'),
      disabled,
    },
    {
      value: 'team',
      title: t('skillhub.publishDialog.publisherTeam'),
      desc: t('skillhub.publishDialog.publisherTeamDesc'),
      disabled: disabled || !hasTeamOptions || teamChoiceDisabled,
    },
  ];

  // 当前选中的发布团队显示名(dept 优先,再查普通团队)
  const selectedDeptIndex = ownerTeamSlug ? deptIds.indexOf(ownerTeamSlug) : -1;
  const selectedName = ownerTeamSlug
    ? (selectedDeptIndex >= 0
      ? (deptNames[selectedDeptIndex] ?? ownerTeamSlug)
      : (teams.find((team) => team.slug === ownerTeamSlug)?.name ?? ownerTeamSlug))
    : null;

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>{t('skillhub.publishDialog.publisherLabel')}</FieldLabel>
      <div className="grid grid-cols-2 gap-2">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            disabled={choice.disabled}
            onClick={() => onChange({ mode: choice.value, ownerTeamSlug })}
            className={cn(
              'flex flex-col items-start gap-1 rounded-xl border bg-[var(--cmd-palette-bg)] p-3 text-left transition-colors',
              mode === choice.value
                ? 'border-[var(--settings-theme-preview-border-active)]'
                : 'border-[var(--cmd-palette-border)]',
              !choice.disabled && mode !== choice.value && 'hover:border-[var(--file-chip-bg)]',
              choice.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <span className="text-sm font-medium text-[var(--msg-assistant-text)]">{choice.title}</span>
            <span className="text-xs leading-[1.4] text-[var(--cmd-palette-item-meta)]">{choice.desc}</span>
          </button>
        ))}
      </div>

      {mode === 'team' ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <FieldLabel>{t('skillhub.publishDialog.publisherTeamSelectLabel')}</FieldLabel>
          <ScopeDropdown
            summary={selectedName}
            placeholder={t('skillhub.publishDialog.publisherTeamPlaceholder')}
            disabled={disabled}
          >
            {(close) => (
              <>
                {deptIds.length > 0 && (
                  <>
                    <GroupLabel>{t('skillhub.publishDialog.extraDeptGroup')}</GroupLabel>
                    {deptIds.map((id, index) => (
                      <OptionRow
                        key={`dept-${id}`}
                        name={deptNames[index] ?? id}
                        selected={ownerTeamSlug === id}
                        onToggle={() => {
                          onChange({ mode: 'team', ownerTeamSlug: id });
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
                {teams.length > 0 && (
                  <>
                    <GroupLabel>{t('skillhub.publishDialog.extraTeamGroup')}</GroupLabel>
                    {teams.map((team) => (
                      <OptionRow
                        key={`team-${team.slug}`}
                        name={team.name}
                        selected={ownerTeamSlug === team.slug}
                        onToggle={() => {
                          onChange({ mode: 'team', ownerTeamSlug: team.slug });
                          close();
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </ScopeDropdown>
          <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
            {t('skillhub.publishDialog.publisherTeamNote')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ── AudiencePicker:「谁可以使用」多选(团队 + 部门),仅团队可见档显示 ─────────

export type AudienceValue = {
  visibleDeptIds: string[];
  sharedTeamSlugs: string[];
};

type AudiencePickerProps = {
  value: AudienceValue;
  deptIds: string[];
  deptNames: string[];
  teams: TeamOption[];
  /** 发布团队(天然可见,展示为锁定选中态,不计入 value) */
  lockedOwnerSlug?: string;
  disabled?: boolean;
  /** 顶部标题,默认「谁可以使用」;编辑可见范围弹窗里复用时可隐藏 */
  showLabel?: boolean;
  onChange: (value: AudienceValue) => void;
};

export function AudiencePicker({
  value,
  deptIds,
  deptNames,
  teams,
  lockedOwnerSlug,
  disabled = false,
  showLabel = true,
  onChange,
}: AudiencePickerProps) {
  const { t } = useTranslation();
  const visibleDepts = deptIds.filter((id) => id !== lockedOwnerSlug);
  const visibleTeams = teams.filter((team) => team.slug !== lockedOwnerSlug);
  const lockedDeptIndex = lockedOwnerSlug ? deptIds.indexOf(lockedOwnerSlug) : -1;
  const lockedName = lockedOwnerSlug
    ? (lockedDeptIndex >= 0
      ? (deptNames[lockedDeptIndex] ?? lockedOwnerSlug)
      : (teams.find((team) => team.slug === lockedOwnerSlug)?.name ?? lockedOwnerSlug))
    : null;

  const toggleDept = (id: string) => {
    onChange({
      ...value,
      visibleDeptIds: value.visibleDeptIds.includes(id)
        ? value.visibleDeptIds.filter((deptId) => deptId !== id)
        : [...value.visibleDeptIds, id],
    });
  };

  const toggleTeam = (slug: string) => {
    onChange({
      ...value,
      sharedTeamSlugs: value.sharedTeamSlugs.includes(slug)
        ? value.sharedTeamSlugs.filter((teamSlug) => teamSlug !== slug)
        : [...value.sharedTeamSlugs, slug],
    });
  };

  // 触发按钮上的摘要:发布团队 + 已选部门/团队名,空时显示 placeholder
  const summaryNames = [
    ...(lockedName ? [`${lockedName}（${t('skillhub.publishDialog.audienceOwnerTag')}）`] : []),
    ...visibleDepts
      .filter((id) => value.visibleDeptIds.includes(id))
      .map((id) => deptNames[deptIds.indexOf(id)] ?? id),
    ...visibleTeams
      .filter((team) => value.sharedTeamSlugs.includes(team.slug))
      .map((team) => team.name),
  ];

  return (
    <div className="flex flex-col gap-1.5">
      {showLabel ? (
        <FieldLabel>{t('skillhub.publishDialog.audienceLabel')}</FieldLabel>
      ) : null}
      <ScopeDropdown
        summary={summaryNames.length > 0 ? summaryNames.join(t('commonUi.listSeparator')) : null}
        placeholder={t('skillhub.publishDialog.audiencePlaceholder')}
        disabled={disabled}
      >
        {() => (
          <>
            {(lockedName || visibleDepts.length > 0) && (
              <>
                <GroupLabel>{t('skillhub.publishDialog.extraDeptGroup')}</GroupLabel>
                {lockedName && lockedDeptIndex >= 0 && (
                  <OptionRow
                    name={lockedName}
                    selected
                    locked
                    lockedTag={t('skillhub.publishDialog.audienceOwnerTag')}
                    onToggle={() => {}}
                  />
                )}
                {visibleDepts.map((id) => (
                  <OptionRow
                    key={`dept-${id}`}
                    name={deptNames[deptIds.indexOf(id)] ?? id}
                    selected={value.visibleDeptIds.includes(id)}
                    disabled={disabled}
                    onToggle={() => toggleDept(id)}
                  />
                ))}
              </>
            )}
            {((lockedName && lockedDeptIndex < 0) || visibleTeams.length > 0) && (
              <>
                <GroupLabel>{t('skillhub.publishDialog.extraTeamGroup')}</GroupLabel>
                {lockedName && lockedDeptIndex < 0 && (
                  <OptionRow
                    name={lockedName}
                    selected
                    locked
                    lockedTag={t('skillhub.publishDialog.audienceOwnerTag')}
                    onToggle={() => {}}
                  />
                )}
                {visibleTeams.map((team) => (
                  <OptionRow
                    key={`team-${team.slug}`}
                    name={team.name}
                    selected={value.sharedTeamSlugs.includes(team.slug)}
                    disabled={disabled}
                    onToggle={() => toggleTeam(team.slug)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </ScopeDropdown>
      <p className="px-0.5 text-xs text-[var(--settings-source-meta)]">
        {t('skillhub.publishDialog.audienceHint')}
      </p>
    </div>
  );
}
