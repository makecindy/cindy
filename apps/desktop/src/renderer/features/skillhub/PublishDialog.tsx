/**
 * PublishDialog — 发布到市场的统一入口,合并了 Empty/Working/Failure 三种 state。
 *
 * State machine (useReducer):
 *
 *   Empty   → [submit]    → Working (inputs lock, footer = 取消 + 正在发布中)
 *   Working → [failed event]       → Failure (err-banner inline,footer = 取消 + 重试)
 *   Working → [scan done]          → Closed + onScanResult callback (父组件弹独立结果窗)
 *   Failure → [retry / retry-upload] → Working
 *   Failure → [republish]            → Empty
 *   Failure → [close/cancel]         → Closed
 *
 * Working 阶段涵盖: reviewing → packing → init → uploading → commit → scanning,
 * 统一 spinner + "正在发布中"文案,不分步展示。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { X, CloudUpload, Globe, Users, Lock, RefreshCw, CircleAlert, Check, ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { AudiencePicker, PublisherPicker } from './components/TeamScopePicker';
import { pickDefaultVersion } from './versionUtils';
import { triggerIncrementalSync } from './hooks/useSkillSync';
import { invalidateHash } from './hooks/useSkillFolderHash';
import { refresh as refreshSkillhub } from './hooks/useSkillhub';
import { getPublishErrorCopy, type PublishActionType } from './lib/publishErrorMap';
import { shouldHandlePublishProgressEvent } from './lib/publishProgressFilter';
import { buildPublishFailureEvent, shouldDispatchPublishResultFallback } from './lib/publishFailureFallback';
import { selectableUserTeams } from './lib/userTeams';
import {
  buildSkillhubPublishParams,
  validateRequiredCategory,
  validateVisibilityScope,
  type PublishFormValues,
  type PublishVisibility,
} from './lib/publishForm';
import type { MarketCategory } from '../../../shared/skillhubCategory';

// ── State machine types ───────────────────────────────────────────────────────

type PublishPhase =
  | 'empty'          // form shown, inputs editable
  | 'packing'        // zip packing
  | 'init'           // POST /init
  | 'uploading'      // OSS PUT
  | 'commit'         // POST /commit
  | 'scanning'       // hub-side security scan in progress
  | 'failure';       // err-banner inline + retry button

interface FailurePayload {
  errorCode: SkillhubPublishErrorCode;
  message: string;
}

export interface ScanResultPayload {
  status: string;
  gates?: Array<{ name: string; label?: Record<string, string>; status: string; issues?: unknown[] }>;
}

interface ScanGateProgress {
  name: string;
  status: string;
}

interface PublishState {
  phase: PublishPhase;
  failurePayload: FailurePayload | null;
  /** slug+version needed by scanning poller */
  publishedMeta: { slug: string; version: string } | null;
  /** intermediate gate statuses during scanning */
  scanGates: ScanGateProgress[];
}

type PublishAction =
  | { type: 'SUBMIT' }
  | { type: 'PROGRESS'; event: SkillhubPublishProgressEvent }
  | { type: 'RETRY_FULL' }
  | { type: 'RETRY_UPLOAD' }
  | { type: 'REPUBLISH' }
  | { type: 'START_SCANNING'; slug: string; version: string }
  | { type: 'UPDATE_SCAN_GATES'; gates: ScanGateProgress[] }
  | { type: 'CLOSE' };

function publishReducer(state: PublishState, action: PublishAction): PublishState {
  switch (action.type) {
    case 'SUBMIT':
      return { ...state, phase: 'packing', failurePayload: null, publishedMeta: null, scanGates: [] };

    case 'PROGRESS': {
      const ev = action.event;
      if (ev.phase === 'packing') return { ...state, phase: 'packing' };
      if (ev.phase === 'init') return { ...state, phase: 'init' };
      if (ev.phase === 'uploading') return { ...state, phase: 'uploading' };
      if (ev.phase === 'commit') return { ...state, phase: 'commit' };
      if (ev.phase === 'scan-status') {
        return {
          ...state,
          phase: 'scanning',
          publishedMeta: { slug: ev.name, version: ev.version },
          scanGates: (ev.gates ?? []).map((g) => ({ name: g.name, status: g.status })),
        };
      }
      if (ev.phase === 'failed') {
        return {
          ...state,
          phase: 'failure',
          failurePayload: { errorCode: ev.errorCode as SkillhubPublishErrorCode, message: ev.message },
        };
      }
      // 'done' / 'scan-result' 是 side effects, 不影响 state shape
      return state;
    }

    case 'RETRY_FULL':
      return { ...state, phase: 'packing', failurePayload: null, publishedMeta: null, scanGates: [] };

    case 'RETRY_UPLOAD':
      return { ...state, phase: 'uploading', failurePayload: null, publishedMeta: null, scanGates: [] };

    case 'START_SCANNING':
      return { ...state, phase: 'scanning', publishedMeta: { slug: action.slug, version: action.version }, scanGates: [] };

    case 'UPDATE_SCAN_GATES':
      return { ...state, scanGates: action.gates };

    case 'REPUBLISH':
      return { phase: 'empty', failurePayload: null, publishedMeta: null, scanGates: [] };

    case 'CLOSE':
      return { phase: 'empty', failurePayload: null, publishedMeta: null, scanGates: [] };

    default:
      return state;
  }
}

const INITIAL_STATE: PublishState = {
  phase: 'empty',
  failurePayload: null,
  publishedMeta: null,
  scanGates: [],
};

const AUTO_CATEGORY_VALUE = '__auto_category__';
const PUBLISH_TEXT_LIMIT = 280;

/** working = 5 种 active phase 的合并语义,UI 上统一处理 */
function isWorkingPhase(phase: PublishPhase): boolean {
  return (
    phase === 'packing' ||
    phase === 'init' ||
    phase === 'uploading' ||
    phase === 'commit' ||
    phase === 'scanning'
  );
}

// ── Form field state (separate from publish state machine) ────────────────────

interface CategoryState {
  loading: boolean;
  categories: MarketCategory[];
  error: string | null;
}

function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clean a skill name to [a-z0-9-]+ (preserve trailing '-' while typing) */
function cleanName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-');
}

/** Validate name per skill registry rules. */
function isValidName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}

// ── Button helpers (shared style with the project dialogs) ───────────────────

function WhitePillButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-full px-4',
        'text-sm font-normal border bg-[var(--cmd-palette-bg)]',
        'border-[var(--confirm-btn-secondary-border)] text-[var(--settings-btn-secondary-text)]',
        'hover:bg-[var(--surface-hover)]',
        'transition-colors',
      )}
    >
      {children}
    </button>
  );
}

function BlackPillButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-4',
        'text-sm font-medium leading-none',
        // 视觉对齐:lucide icon 视觉重心偏上,把 icon 抬 0.5px 让它和文字 baseline 看齐
        '[&>svg]:-translate-y-px',
        'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]',
        'hover:bg-[var(--lightbox-cta-hover)]',
        'transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}

// ── Field components ──────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block px-0.5 text-13 font-medium text-[var(--settings-section-desc)]">
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  readOnly,
  invalid,
}: {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  invalid?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'w-full rounded-full border px-3 py-2 text-sm',
        'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
        'border-[var(--settings-input-border)]',
        'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
        'transition-colors',
        readOnly && 'cursor-default opacity-70',
        invalid && 'border-[var(--settings-input-placeholder)] bg-[var(--surface-chip)]',
        'select-text',
      )}
    />
  );
}

function TextareaInput({
  value,
  onChange,
  placeholder,
  rows = 3,
  readOnly,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  readOnly?: boolean;
  maxLength?: number;
}) {
  return (
    <textarea
      value={value}
      readOnly={readOnly}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cn(
        'w-full resize-none rounded-xl border px-3 py-2 text-sm',
        'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
        'border-[var(--settings-input-border)]',
        'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
        'transition-colors select-text',
        readOnly && 'cursor-default opacity-70',
      )}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  disabled,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}) {
  // Radix Select:表单内下拉的业界标准实现。相比手搓 Popover,它 portal 到 body
  // 逃出弹窗 transform(-translate)造成的裁剪,且自带在 modal 弹窗里可用的滚动视口
  // (滚轮 + 上下滚动按钮 + 键盘导航),不受 Dialog 滚动锁影响。
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-full border px-3 text-sm',
          'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
          'border-[var(--settings-input-border)]',
          'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
          'transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60',
          'data-[placeholder]:text-[var(--settings-input-placeholder)]',
        )}
      >
        <span className="min-w-0 truncate text-left">
          <Select.Value placeholder={placeholder} />
        </span>
        <Select.Icon asChild>
          <ChevronDown size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="bottom"
          align="start"
          sideOffset={4}
          className={cn(
            'z-[10010] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border p-1',
            'max-h-[min(15rem,var(--radix-select-content-available-height))]',
            'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
            '[box-shadow:var(--cmd-palette-shadow)]',
          )}
        >
          <Select.ScrollUpButton className="flex h-5 items-center justify-center text-[var(--settings-section-desc)]">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none',
                  'text-[var(--msg-assistant-text)] transition-colors',
                  'data-[highlighted]:bg-[var(--surface-hover)]',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60',
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <Select.ItemIndicator>
                    <Check size={14} strokeWidth={2.25} />
                  </Select.ItemIndicator>
                </span>
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="flex h-5 items-center justify-center text-[var(--settings-section-desc)]">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

// ── Visibility radio card ─────────────────────────────────────────────────────

export function VisibilityCard({
  value,
  label,
  description,
  icon,
  selected,
  disabled,
  onSelect,
  children,
}: {
  value: PublishVisibility;
  label: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  disabled?: boolean;
  onSelect: (v: PublishVisibility) => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border bg-[var(--cmd-palette-bg)]',
        'p-3 transition-colors',
        selected
          ? 'border-[var(--settings-theme-preview-border-active)]'
          : 'border-[var(--cmd-palette-border)]',
        !disabled && !selected && 'hover:border-[var(--file-chip-bg)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && onSelect(value)}
        className={cn(
          'flex flex-col items-start gap-1.5 text-left',
          disabled && 'cursor-not-allowed',
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-3.5 w-3.5 items-center justify-center',
              selected
                ? 'text-[var(--msg-assistant-text)]'
                : 'text-[var(--settings-section-desc)]',
            )}
          >
            {icon}
          </span>
          <span className="text-sm font-medium text-[var(--msg-assistant-text)]">
            {label}
          </span>
        </div>
        <span className="text-xs leading-[1.4] text-[var(--cmd-palette-item-meta)]">
          {description}
        </span>
      </button>
      {children}
    </div>
  );
}

// ── PublishDialog (main component) ────────────────────────────────────────────

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: SkillhubSkill;
  isFirstPublish: boolean;
  /** When true, pre-clean the name field on mount (Name Taken flow). */
  autoCleanName?: boolean;
  /** Latest published version (for non-first publish). */
  latestVersion?: string;
  /** Review status attached to latestVersion when Hub has no separate pendingVersion field. */
  latestVersionStatus?: string | null;
  /** Latest version submitted to Hub and its review status. Rejected versions can be reused. */
  pendingVersion?: { version?: string | null; status?: string | null } | null;
  /** Dept ids the current user can see. */
  currentUserDeptIds: string[];
  /** Dept display names parallel to currentUserDeptIds. */
  currentUserDeptNames: string[];
  /**
   * 仅 autoCleanName 改名流程触发:本地 skill 已被改名(目录 + frontmatter)。
   * DetailView 拿到新 absolutePath/name 后,刷新 scanner 并导航到新 URL,
   * 避免用户停留在已死的旧 URL。会在 publish-done 之后调用,确保 publish
   * 进度 UI 不被中途打断。
   */
  onLocalRenamed?: (newAbsolutePath: string, newName: string) => void;
  /** hub 安全扫描完成后回调,传递结果给父组件弹独立结果窗。 */
  onScanResult?: (result: ScanResultPayload) => void;
}

export function PublishDialog({
  open,
  onOpenChange,
  skill,
  isFirstPublish,
  autoCleanName = false,
  latestVersion,
  latestVersionStatus,
  pendingVersion,
  currentUserDeptIds,
  currentUserDeptNames,
  onLocalRenamed,
  onScanResult,
}: PublishDialogProps) {
  // ── Publish state machine ─────────────────────────────────────────────────
  const [pubState, dispatch] = useReducer(publishReducer, INITIAL_STATE);
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();

  // refresh/sync 延迟到 dialog 关闭后才触发，isFirstPublish 在 dialog 生命周期内不会翻转
  const effectiveFirstPublish = isFirstPublish;
  const { t } = useTranslation();

  // 本地改名后保存新 absolutePath / name。Publish 链路里所有引用 skill.absolutePath
  // / skill.name 的地方都要切换到这里,否则 publish 会拿失效的旧路径。
  // 用 ref 不用 state——publish 期间 dialog 是 locked 的,不需要触发 rerender。
  const renamedToRef = useRef<{ absolutePath: string; name: string } | null>(null);
  const activePublishNameRef = useRef<string | null>(null);
  const failedProgressNameRef = useRef<string | null>(null);
  /** 拿当前应使用的 (absolutePath, name) — rename 之后是新值,否则用 prop。 */
  const effectiveSkill = useCallback(
    (): { absolutePath: string; name: string } => ({
      absolutePath: renamedToRef.current?.absolutePath ?? skill.absolutePath,
      name: renamedToRef.current?.name ?? skill.name,
    }),
    [skill.absolutePath, skill.name],
  );

  /**
   * 关闭 dialog 前的清理:如果本地已改过名(renamedToRef),通知 DetailView
   * 跳到新 URL — 否则用户会停在已死的旧 URL 上(目录已不存在)。
   * publish-done 路径会在自己的 handler 里调 onLocalRenamed,这里只服务于
   * cancel / failure-close 等非 done 的关闭场景。
   */
  const notifyRenameAndReset = useCallback(() => {
    if (renamedToRef.current) {
      onLocalRenamed?.(renamedToRef.current.absolutePath, renamedToRef.current.name);
      renamedToRef.current = null;
    }
  }, [onLocalRenamed]);


  // ── User teams (for multi-team visibility) ──────────────────────────────
  const [userTeams, setUserTeams] = useState<Array<{ slug: string; name: string; type: string }>>([]);
  useEffect(() => {
    if (!open || !effectiveFirstPublish) return;
    void window.electronAPI.skillhub.listUserTeams().then((res) => {
      if (res.success) {
        const teams = selectableUserTeams(res.teams)
          .map((t) => ({ slug: t.slug, name: t.name, type: t.type ?? 'team' }));
        setUserTeams(teams);
      }
    });
  }, [open, effectiveFirstPublish, currentUserDeptIds]);

  // ── Hub categories (required for first publish only) ─────────────────────
  const [categoryState, setCategoryState] = useState<CategoryState>({
    loading: false,
    categories: [],
    error: null,
  });

  const loadCategories = useCallback(async () => {
    setCategoryState({ loading: true, categories: [], error: null });
    try {
      const res = await window.electronAPI.skillhub.listCategories();
      if (res.success) {
        setCategoryState({
          loading: false,
          categories: res.categories ?? [],
          error: null,
        });
        return;
      }
      setCategoryState({
        loading: false,
        categories: [],
        error: res.error ?? 'Failed to load categories',
      });
    } catch (err) {
      setCategoryState({
        loading: false,
        categories: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (!open || !effectiveFirstPublish) return;
    void loadCategories();
  }, [open, effectiveFirstPublish, loadCategories]);

  // ── Form state (separate from pub machine) ────────────────────────────────
  const frontmatterDisplayName = (skill.frontmatter?.['displayName'] as string | undefined) ?? (skill.frontmatter?.['name'] as string | undefined) ?? skill.name;
  const frontmatterSummary =
    (skill.frontmatter?.['summary'] as string | undefined) ??
    (skill.frontmatter?.['description'] as string | undefined) ??
    '';
  const frontmatterVersion = (skill.frontmatter?.['version'] as string | undefined) ?? '';

  const defaultVersion = pickDefaultVersion(frontmatterVersion || undefined, latestVersion, pendingVersion, latestVersionStatus);
  // 默认对齐 SkillHub:公开 · 个人发布者
  const [form, setForm] = useState<PublishFormValues>(() => ({
    name: autoCleanName ? '' : skill.name,
    version: defaultVersion,
    displayName: frontmatterDisplayName,
    summary: frontmatterSummary,
    description: frontmatterSummary,
    visibility: 'PUBLIC',
    publisherMode: 'personal',
    ownerTeamSlug: '',
    visibleDeptIds: [],
    sharedTeamSlugs: [],
    changelog: '',
    categoryMode: 'auto',
    categorySlug: '',
  }));

  // Reset form when dialog opens or latestVersion loads (info API async)
  useEffect(() => {
    if (open && pubState.phase === 'empty') {
      setForm({
        name: autoCleanName ? '' : skill.name,
        version: pickDefaultVersion(frontmatterVersion || undefined, latestVersion, pendingVersion, latestVersionStatus),
        displayName: frontmatterDisplayName,
        summary: frontmatterSummary,
        description: frontmatterSummary,
        visibility: 'PUBLIC',
        publisherMode: 'personal',
        ownerTeamSlug: '',
        visibleDeptIds: [],
        sharedTeamSlugs: [],
        changelog: '',
        categoryMode: 'auto',
        categorySlug: '',
      });
    }
  }, [open, latestVersion, latestVersionStatus, pendingVersion]);

  // ── Progress event subscription ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const unsubscribe = window.electronAPI.skillhub.onPublishProgress((event) => {
      const activeName = activePublishNameRef.current;
      if (!shouldHandlePublishProgressEvent(event, activeName)) return;
      if (event.phase === 'done') {
        const { name, version } = event;
        activePublishNameRef.current = name;
        dispatch({ type: 'START_SCANNING', slug: name, version });
        return;
      }
      if (event.phase === 'scan-status') {
        dispatch({ type: 'PROGRESS', event });
        return;
      }
      if (event.phase === 'scan-result') {
        const eff = effectiveSkill();
        if (event.name !== eff.name) return;
        void (async () => {
          invalidateHash(eff.absolutePath);
          await refreshSkillhub();
          void triggerIncrementalSync([event.name]);
          dispatch({ type: 'CLOSE' });
          onOpenChange(false);
          if (renamedToRef.current) {
            onLocalRenamed?.(renamedToRef.current.absolutePath, renamedToRef.current.name);
            renamedToRef.current = null;
          }
          activePublishNameRef.current = null;
          failedProgressNameRef.current = null;
          onScanResult?.({ status: event.status, gates: event.gates });
        })();
        return;
      }
      if (event.phase === 'failed') {
        failedProgressNameRef.current = event.name ?? activeName;
      }
      dispatch({ type: 'PROGRESS', event });
    });
    return unsubscribe;
  }, [open, onOpenChange, onLocalRenamed, onScanResult, effectiveSkill]);

  // ── Form validation ───────────────────────────────────────────────────────
  const nameMissing = effectiveFirstPublish && form.name.length === 0;
  const nameError = form.name.length > 0 && !isValidName(form.name);
  const displayNameError = form.displayName.length > 64;
  const summaryError = form.summary.length > PUBLISH_TEXT_LIMIT;
  const changelogRequired = !effectiveFirstPublish && form.changelog.trim().length === 0;
  const changelogError = !effectiveFirstPublish && form.changelog.length > PUBLISH_TEXT_LIMIT;
  const versionError = form.version.length > 0 && !isValidVersion(form.version);

  const visibilityScopeValidation = validateVisibilityScope(form);
  const categoryValidation = effectiveFirstPublish
    ? validateRequiredCategory({
      loading: categoryState.loading,
      error: categoryState.error,
      categories: categoryState.categories,
      categoryMode: form.categoryMode,
      selectedSlug: form.categorySlug,
    })
    : { ok: true as const };

  const canSubmit =
    (effectiveFirstPublish ? isValidName(form.name) : true) &&
    isValidVersion(form.version) &&
    categoryValidation.ok &&
    (effectiveFirstPublish ? !displayNameError : true) &&
    (effectiveFirstPublish ? !summaryError : true) &&
    !changelogRequired &&
    !changelogError &&
    (effectiveFirstPublish ? visibilityScopeValidation.ok : true);

  const buildCurrentPublishParams = useCallback(
    (publishAbsolutePath: string, submitName: string): SkillhubPublishParams => buildSkillhubPublishParams({
      form,
      publishAbsolutePath,
      submitName,
      isFirstPublish: effectiveFirstPublish,
    }),
    [form, effectiveFirstPublish],
  );

  const runPublish = useCallback((params: SkillhubPublishParams) => {
    activePublishNameRef.current = params.name;
    failedProgressNameRef.current = null;
    void window.electronAPI.skillhub.publish(params)
      .then((res) => {
        if (res.success) {
          if (activePublishNameRef.current !== params.name) return;
          if (res.result) {
            dispatch({ type: 'START_SCANNING', slug: res.result.name, version: res.result.version });
          }
          return;
        }
        if (!shouldDispatchPublishResultFallback(params.name, activePublishNameRef.current, failedProgressNameRef.current)) return;
        dispatch({
          type: 'PROGRESS',
          event: buildPublishFailureEvent(params.name, res.errorCode, res.error),
        });
      })
      .catch((err) => {
        if (!shouldDispatchPublishResultFallback(params.name, activePublishNameRef.current, failedProgressNameRef.current)) return;
        dispatch({
          type: 'PROGRESS',
          event: buildPublishFailureEvent(params.name, 'INTERNAL', err),
        });
      });
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const eff = effectiveSkill();
    const submitName = effectiveFirstPublish
      ? form.name.replace(/^-+|-+$/g, '')
      : eff.name;

    const ok = await confirm({
      title: effectiveFirstPublish
        ? t('skillhub.publishDialog.confirmFirstTitle')
        : t('skillhub.publishDialog.confirmVersionTitle', { version: form.version }),
      description: effectiveFirstPublish
        ? t('skillhub.publishDialog.confirmFirstDesc', { name: submitName })
        : t('skillhub.publishDialog.confirmVersionDesc'),
      confirmText: t('skillhub.publishDialog.confirmPublish'),
      cancelText: t('skillhub.publishDialog.confirmReconsider'),
    });
    if (!ok) return;

    // ── autoCleanName(撞名后改名)流程:先在本地改名,再走 publish ──────────
    // 不改名(autoCleanName=false 或新旧名一致)时跳过这一步。
    // 一旦本地改名成功,renamedToRef 就被填上新的 path/name,后续整个 publish
    // 链路(失败重试、cancel 关闭、done 回调)都从 effectiveSkill() 读,
    // 永远不会再回到旧路径。
    let publishAbsolutePath = eff.absolutePath;
    if (autoCleanName && !renamedToRef.current && submitName !== eff.name) {
      const renameRes = await window.electronAPI.skillhub.renameLocal({
        // Keep the lexical discovery path for lstat: canonical absolutePath may
        // point at a symlink target and would bypass the rename safety gate.
        absolutePath: skill.discoveredPath ?? eff.absolutePath,
        newName: submitName,
      });
      if (!renameRes.success) {
        toast.error(t('skillhub.publishDialog.renameFailed', { error: renameRes.error }));
        return;
      }
      renamedToRef.current = { absolutePath: renameRes.newAbsolutePath, name: submitName };
      publishAbsolutePath = renameRes.newAbsolutePath;
      // 旧路径的 hash 缓存清掉(它指向已不存在的目录)
      invalidateHash(eff.absolutePath);
    }

    dispatch({ type: 'SUBMIT' });

    // displayName / summary 每次都传:它们来自 SKILL.md frontmatter/表单,作者
    // 改了之后理应同步到服务端,否则市场卡片永远显示首发那版的简介。
    // visibility/visibleDeptIds 仍只在首发传 —— 发布范围是独立决策,后续要改
    // 应该走专门的入口,不应混在"发新版本"里默默动。
    const params = buildCurrentPublishParams(publishAbsolutePath, submitName);
    runPublish(params);
  }, [
    canSubmit,
    form,
    effectiveSkill,
    effectiveFirstPublish,
    autoCleanName,
    confirm,
    t,
    buildCurrentPublishParams,
    runPublish,
    skill.discoveredPath,
  ]);

  // ── Cancel publish in progress (working / failure 都可调) ────────────────
  const handleCancelWorking = useCallback(async () => {
    if (pubState.phase === 'scanning') {
      activePublishNameRef.current = null;
      failedProgressNameRef.current = null;
      dispatch({ type: 'CLOSE' });
      notifyRenameAndReset();
      onOpenChange(false);
      return;
    }
    const ok = await confirm({
      title: t('skillhub.publishDialog.cancelDialog.title'),
      description: t('skillhub.publishDialog.cancelDialog.description'),
      confirmText: t('skillhub.publishDialog.cancelDialog.confirm'),
      cancelText: t('skillhub.publishDialog.cancelDialog.cancel'),
    });
    if (!ok) return;
    void window.electronAPI.skillhub.cancelPublish();
    activePublishNameRef.current = null;
    failedProgressNameRef.current = null;
    dispatch({ type: 'CLOSE' });
    notifyRenameAndReset();
    onOpenChange(false);
  }, [pubState.phase, onOpenChange, confirm, notifyRenameAndReset, t]);

  // ── 关闭整个 dialog (X / Esc / backdrop) ────────────────────────────────
  const handleClose = useCallback(() => {
    if (isWorkingPhase(pubState.phase)) {
      void handleCancelWorking();
      return;
    }
    // empty / failure 时直接关
    activePublishNameRef.current = null;
    failedProgressNameRef.current = null;
    dispatch({ type: 'CLOSE' });
    notifyRenameAndReset();
    onOpenChange(false);
  }, [pubState.phase, handleCancelWorking, onOpenChange, notifyRenameAndReset]);

  // ── Failure action handler ────────────────────────────────────────────────
  const handleFailureAction = useCallback(
    async (action: PublishActionType) => {
      switch (action) {
        case 'retry':
          dispatch({ type: 'RETRY_FULL' });
          void handleSubmit();
          break;
        case 'retry-upload': {
          // 改名后重试要拿改完的新 path/name,不能回退到 prop
          const eff = effectiveSkill();
          dispatch({ type: 'RETRY_UPLOAD' });
          const submitName = effectiveFirstPublish ? form.name.replace(/^-+|-+$/g, '') : eff.name;
          const params = buildCurrentPublishParams(eff.absolutePath, submitName);
          runPublish(params);
          break;
        }
        case 'republish':
          activePublishNameRef.current = null;
          failedProgressNameRef.current = null;
          dispatch({ type: 'REPUBLISH' });
          break;
        case 'go-settings':
          activePublishNameRef.current = null;
          failedProgressNameRef.current = null;
          // API_KEY_MISSING = XD 网关 key 未配置;「工具密钥」页已下架
          // (2026-07-13),网关 key 的入口在模型供应商页。
          navigate('/settings?tab=providers');
          dispatch({ type: 'CLOSE' });
          notifyRenameAndReset();
          onOpenChange(false);
          break;
        case 'rename':
          activePublishNameRef.current = null;
          failedProgressNameRef.current = null;
          dispatch({ type: 'REPUBLISH' });
          break;
        case 'close':
        default:
          activePublishNameRef.current = null;
          failedProgressNameRef.current = null;
          dispatch({ type: 'CLOSE' });
          notifyRenameAndReset();
          onOpenChange(false);
          break;
      }
    },
    [handleSubmit, effectiveSkill, form.name, effectiveFirstPublish, buildCurrentPublishParams, runPublish, onOpenChange, notifyRenameAndReset, navigate, confirm, t],
  );

  // ── Derived UI flags ──────────────────────────────────────────────────────
  const isLocked = isWorkingPhase(pubState.phase) || pubState.phase === 'failure';
  const isWorking = isWorkingPhase(pubState.phase);
  const isFailure = pubState.phase === 'failure';

  const workingLabel = (() => {
    switch (pubState.phase) {
      case 'packing': return t('skillhub.publishDialog.phasePacking');
      case 'init': return t('skillhub.publishDialog.phaseInit');
      case 'uploading': return t('skillhub.publishDialog.phaseUploading');
      case 'commit': return t('skillhub.publishDialog.phaseCommit');
      case 'scanning': {
        if (pubState.scanGates.length > 0) return t('skillhub.publishDialog.phaseScanning');
        return t('skillhub.publishDialog.phaseScanningWait');
      }
      default: return t('skillhub.publishDialog.publishing');
    }
  })();

  // Failure 文案
  const errorCopy =
    isFailure && pubState.failurePayload
      ? getPublishErrorCopy(pubState.failurePayload.errorCode)
      : null;

  // ── Dept section available? ───────────────────────────────────────────────
  const hasDepts = currentUserDeptIds.length > 0;

  // dlg-head subtitle — 优先 frontmatter displayName，fallback 到目录名
  const skillDisplayTitle = frontmatterDisplayName !== skill.name ? frontmatterDisplayName : skill.name;
  const baseSubtitle = effectiveFirstPublish
    ? t('skillhub.publishDialog.subtitleFirst', { name: skillDisplayTitle })
    : t('skillhub.publishDialog.subtitleVersion', { name: skillDisplayTitle, version: form.version });
  // 用户决定:不细分 reviewing/packing/uploading/commit,统一一个文案
  const subtitle = isWorkingPhase(pubState.phase)
    ? t('skillhub.publishDialog.subtitleWorking', { base: baseSubtitle })
    : baseSubtitle;

  return (
    <>
      {/* ── Main PublishDialog (Empty / Working / Failure 共用) ───────────── */}
      <Dialog.Root
        open={open}
        onOpenChange={(v) => {
          if (!v) handleClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          />
          <Dialog.Content
            // working 时禁止 outside-click / Escape 直接关——走 cancel confirm 流程
            onPointerDownOutside={(e) => {
              if (isWorking && pubState.phase !== 'scanning') e.preventDefault();
            }}
            onEscapeKeyDown={(e) => {
              if (isWorking && pubState.phase !== 'scanning') e.preventDefault();
            }}
            className={cn(
              'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
              'w-full max-w-[480px] rounded-xl',
              'border bg-[var(--cmd-palette-bg)]',
              'border-[var(--cmd-palette-border)]',
              'max-h-[90vh] overflow-y-auto',
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            aria-describedby={undefined}
          >
            {/* ── Header ────────────────────────────────────────────────── */}
            <div className="flex items-start justify-between px-5 pt-5">
              <div className="flex flex-col gap-1.5 pl-0.5">
                <Dialog.Title className="text-lg font-medium text-[var(--msg-assistant-text)]">
                  {t('skillhub.publishDialog.title')}
                </Dialog.Title>
                <span className="text-xs text-[var(--cmd-palette-item-meta)]">
                  {subtitle}
                </span>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full',
                  'text-[var(--settings-theme-icon)] hover:bg-[var(--confirm-btn-secondary-hover)]',
                  'transition-colors',
                )}
                aria-label={t('skillhub.publishDialog.closeAria')}
              >
                <X size={15} />
              </button>
            </div>

            {/* ── Form fields ── */}
            <div
              className={cn('flex flex-col gap-4 px-5 pt-5 pb-1', isWorking && 'pointer-events-none opacity-50')}
            >
              {/* SkillName — only shown in rename flow (after NAME_TAKEN) */}
              {autoCleanName && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>{t('skillhub.publishDialog.skillNameLabel')}</FieldLabel>
                  <TextInput
                    value={form.name}
                    onChange={(v) => setForm((f) => ({ ...f, name: cleanName(v) }))}
                    placeholder={t('skillhub.publishDialog.skillNamePlaceholder')}
                    invalid={nameError || nameMissing}
                    readOnly={isLocked}
                  />
                  {nameMissing && (
                    <p className="text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.publishDialog.skillNameRequired')}</p>
                  )}
                  {nameError && (
                    <p className="text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.publishDialog.skillNameFormat')}</p>
                  )}
                </div>
              )}

              {/* DisplayName (first publish only) */}
              {effectiveFirstPublish && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>{t('skillhub.publishDialog.displayNameLabel')}</FieldLabel>
                  <TextInput
                    value={form.displayName}
                    onChange={(v) => setForm((f) => ({ ...f, displayName: v }))}
                    placeholder={t('skillhub.publishDialog.displayNamePlaceholder')}
                    invalid={displayNameError}
                    readOnly={isLocked}
                  />
                  {displayNameError && (
                    <p className="text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.publishDialog.displayNameLimit')}</p>
                  )}
                </div>
              )}

              {/* Version */}
              <div className="flex flex-col gap-1.5">
                <FieldLabel>{t('skillhub.publishDialog.versionLabel')}</FieldLabel>
                <TextInput
                  value={form.version}
                  onChange={(v) => setForm((f) => ({ ...f, version: v }))}
                  placeholder="1.0.0"
                  readOnly={isLocked}
                />
                {versionError && (
                  <p className="text-xs text-[var(--error-fg)]">{t('skillhub.publishDialog.versionFormatHint')}</p>
                )}
              </div>

              {/* Summary (first publish only) — 计数放标签行右侧,不占输入框下方空间 */}
              {effectiveFirstPublish && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <FieldLabel>{t('skillhub.publishDialog.descriptionLabel')}</FieldLabel>
                    <span
                      className={cn(
                        'px-0.5 text-xs tabular-nums',
                        summaryError ? 'text-[var(--error-fg)]' : 'text-[var(--settings-source-meta)]',
                      )}
                    >
                      {form.summary.length}/{PUBLISH_TEXT_LIMIT}
                    </span>
                  </div>
                  <TextareaInput
                    value={form.summary}
                    onChange={(v) => setForm((f) => ({ ...f, summary: v, description: v }))}
                    placeholder={t('skillhub.publishDialog.descriptionPlaceholder')}
                    maxLength={PUBLISH_TEXT_LIMIT}
                  />
                </div>
              )}

              {/* Category — first publish only, sourced from XD Skill Hub */}
              {effectiveFirstPublish && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>{t('skillhub.publishDialog.categoryLabel')}</FieldLabel>
                  <SelectInput
                    value={form.categoryMode === 'auto' ? AUTO_CATEGORY_VALUE : form.categorySlug}
                    disabled={isLocked}
                    onChange={(v) => setForm((f) => (
                      v === AUTO_CATEGORY_VALUE
                        ? { ...f, categoryMode: 'auto', categorySlug: '' }
                        : { ...f, categoryMode: 'manual', categorySlug: v }
                    ))}
                    options={[
                      {
                        value: AUTO_CATEGORY_VALUE,
                        label: t('skillhub.publishDialog.categoryAuto'),
                      },
                      ...categoryState.categories.map((category) => ({
                        value: category.slug,
                        label: category.name,
                      })),
                    ]}
                  />
                  {!categoryValidation.ok && categoryValidation.reason !== 'required' && (
                    <div className="flex items-center justify-between gap-3 px-0.5">
                      <p className="min-w-0 text-xs text-[var(--cmd-palette-item-meta)]">
                        {categoryValidation.reason === 'loading'
                          ? t('skillhub.publishDialog.categoryLoading')
                          : categoryValidation.reason === 'load-error'
                            ? t('skillhub.publishDialog.categoryLoadFailed')
                            : categoryValidation.reason === 'empty'
                              ? t('skillhub.publishDialog.categoryEmpty')
                              : t('skillhub.publishDialog.categoryInvalid')}
                      </p>
                      {categoryValidation.reason === 'load-error' && (
                        <button
                          type="button"
                          onClick={() => void loadCategories()}
                          className={cn(
                            'shrink-0 text-xs font-medium',
                            'text-[var(--settings-btn-secondary-text)] hover:text-[var(--msg-assistant-text)]',
                          )}
                        >
                          {t('skillhub.publishDialog.retryLoadCategories')}
                        </button>
                      )}
                    </div>
                  )}
                  {!categoryValidation.ok && categoryValidation.reason === 'required' && (
                    <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">
                      {t('skillhub.publishDialog.categoryRequired')}
                    </p>
                  )}
                </div>
              )}

              {/* Visibility + Publisher + Audience (first publish only) */}
              {effectiveFirstPublish && (
                <div className="flex flex-col gap-2">
                  <FieldLabel>{t('skillhub.publishDialog.visibilityLabel')}</FieldLabel>
                  {/* 三档横排,对齐 SkillHub:公开 / 团队 / 仅自己使用 */}
                  <div className="grid grid-cols-3 gap-2">
                    <div data-visibility-card>
                      <VisibilityCard
                        value="PUBLIC"
                        label={t('skillhub.publishDialog.visibilityPublicTitle')}
                        description={t('skillhub.publishDialog.visibilityPublicDesc')}
                        icon={<Globe size={14} strokeWidth={1.75} />}
                        selected={form.visibility === 'PUBLIC'}
                        onSelect={(v) => setForm((f) => ({
                          ...f,
                          visibility: v,
                          visibleDeptIds: [],
                          sharedTeamSlugs: [],
                        }))}
                      />
                    </div>
                    <div data-visibility-card>
                      <VisibilityCard
                        value="DEPARTMENT_SCOPED"
                        label={t('skillhub.publishDialog.visibilityTeamTitle')}
                        description={t('skillhub.publishDialog.visibilityTeamDesc')}
                        icon={<Users size={14} strokeWidth={1.75} />}
                        selected={form.visibility === 'DEPARTMENT_SCOPED'}
                        disabled={!hasDepts && userTeams.length === 0}
                        onSelect={(v) => setForm((f) => ({ ...f, visibility: v }))}
                      />
                    </div>
                    <div data-visibility-card>
                      <VisibilityCard
                        value="PRIVATE"
                        label={t('skillhub.publishDialog.visibilityPrivateTitle')}
                        description={t('skillhub.publishDialog.visibilityPrivateDesc')}
                        icon={<Lock size={14} strokeWidth={1.75} />}
                        selected={form.visibility === 'PRIVATE'}
                        onSelect={(v) => setForm((f) => ({
                          ...f,
                          visibility: v,
                          // 私有强制个人归属(对齐 SkillHub)
                          publisherMode: 'personal',
                          ownerTeamSlug: '',
                          visibleDeptIds: [],
                          sharedTeamSlugs: [],
                        }))}
                      />
                    </div>
                  </div>
                  {!hasDepts && userTeams.length === 0 && (
                    <p className="px-0.5 text-xs text-[var(--cmd-palette-item-meta)]">{t('skillhub.publishDialog.noTeamsHint')}</p>
                  )}

                  {/* 发布者 — SkillHub 同款常驻区块(个人/团队两卡 + 发布团队下拉);私有档锁定个人 */}
                  <div className="pt-2">
                    <PublisherPicker
                      mode={form.publisherMode}
                      ownerTeamSlug={form.ownerTeamSlug}
                      deptIds={currentUserDeptIds}
                      deptNames={currentUserDeptNames}
                      teams={userTeams}
                      disabled={isLocked}
                      teamChoiceDisabled={form.visibility === 'PRIVATE'}
                      onChange={({ mode, ownerTeamSlug }) => {
                        const nextOwnerSlug = mode === 'team' && !ownerTeamSlug
                          ? (currentUserDeptIds[0] ?? userTeams[0]?.slug ?? '')
                          : ownerTeamSlug;
                        setForm((f) => ({
                          ...f,
                          publisherMode: mode,
                          ownerTeamSlug: nextOwnerSlug,
                          visibleDeptIds: mode === 'team' && nextOwnerSlug
                            ? f.visibleDeptIds.filter((id) => id !== nextOwnerSlug)
                            : f.visibleDeptIds,
                          sharedTeamSlugs: mode === 'team' && nextOwnerSlug
                            ? f.sharedTeamSlugs.filter((slug) => slug !== nextOwnerSlug)
                            : f.sharedTeamSlugs,
                        }));
                      }}
                    />
                    {visibilityScopeValidation.ok === false && visibilityScopeValidation.reason === 'publisher-team-required' && (
                      <p className="px-0.5 pt-1 text-xs text-[var(--cmd-palette-item-meta)]">
                        {t('skillhub.publishDialog.publisherTeamRequired')}
                      </p>
                    )}
                  </div>

                  {/* 谁可以使用 — 仅团队可见档显示 */}
                  {form.visibility === 'DEPARTMENT_SCOPED' && (hasDepts || userTeams.length > 0) && (
                    <div className="pt-2">
                      <AudiencePicker
                        value={{
                          visibleDeptIds: form.visibleDeptIds,
                          sharedTeamSlugs: form.sharedTeamSlugs,
                        }}
                        deptIds={currentUserDeptIds}
                        deptNames={currentUserDeptNames}
                        teams={userTeams}
                        lockedOwnerSlug={form.publisherMode === 'team' && form.ownerTeamSlug ? form.ownerTeamSlug : undefined}
                        disabled={isLocked}
                        onChange={(value) => setForm((f) => ({
                          ...f,
                          visibleDeptIds: value.visibleDeptIds,
                          sharedTeamSlugs: value.sharedTeamSlugs,
                        }))}
                      />
                      {visibilityScopeValidation.ok === false && visibilityScopeValidation.reason === 'audience-required' && (
                        <p className="px-0.5 pt-1 text-xs text-[var(--cmd-palette-item-meta)]">
                          {t('skillhub.publishDialog.audienceRequired')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}


              {/* Changelog — only for non-first publish */}
              {!effectiveFirstPublish && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <FieldLabel>{t('skillhub.publishDialog.changelogLabel')}</FieldLabel>
                    <span
                      className={cn(
                        'px-0.5 text-xs tabular-nums',
                        changelogError ? 'text-[var(--error-fg)]' : 'text-[var(--settings-source-meta)]',
                      )}
                    >
                      {form.changelog.length}/{PUBLISH_TEXT_LIMIT}
                    </span>
                  </div>
                  <TextareaInput
                    value={form.changelog}
                    onChange={(v) => setForm((f) => ({ ...f, changelog: v }))}
                    placeholder={t('skillhub.publishDialog.changelogPlaceholder')}
                    rows={3}
                    readOnly={isLocked}
                    maxLength={PUBLISH_TEXT_LIMIT}
                  />
                </div>
              )}
            </div>

            {/* ── err-banner (只在 failure 时显示) ───────────────────────── */}
            {isFailure && errorCopy && (
              <div className="px-5 pt-3 pb-0">
                <div
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl p-4',
                    'bg-[var(--chat-input-chip-bg)]',
                  )}
                >
                  <CircleAlert
                    size={18}
                    className="mt-0.5 shrink-0 text-[var(--settings-section-desc)]"
                  />
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-sm font-medium text-[var(--msg-assistant-text)]">
                      {errorCopy.title}
                    </span>
                    {errorCopy.message && (
                      <span className="text-xs leading-[1.5] text-[var(--cmd-palette-item-meta)]">
                        {errorCopy.message}
                      </span>
                    )}
                    {/*
                     * 只在 failurePayload.message 含有明显额外信息时才展示原文
                     * (多行,或者比静态文案长很多)
                     */}
                    {(() => {
                      const detail = pubState.failurePayload?.message?.trim();
                      if (!detail || detail === errorCopy.message) return null;
                      const hasMultiline = detail.includes('\n');
                      const isMuchLonger = detail.length > (errorCopy.message?.length ?? 0) + 40;
                      if (!hasMultiline && !isMuchLonger) return null;
                      return (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[hsl(var(--content-area))] p-2 font-mono text-[length:calc(var(--app-code-font-size)_-_3px)] leading-[1.4] text-[var(--settings-section-desc)] select-text">
                          {detail}
                        </pre>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}

            {/* ── Footer buttons ──────────────────────────────────────── */}
            <div className="flex items-center justify-end gap-2 p-4">
              {isWorking ? (
                <>
                  {pubState.phase !== 'scanning' && (
                    <WhitePillButton onClick={() => void handleCancelWorking()}>
                      {t('skillhub.publishDialog.cancelReview')}
                    </WhitePillButton>
                  )}
                  <BlackPillButton disabled>
                    <span className="inline-flex -translate-y-px">
                      <Spinner size={14} strokeWidth={1.75} />
                    </span>
                    {workingLabel}
                  </BlackPillButton>
                </>
              ) : isFailure && errorCopy ? (
                <>
                  {errorCopy.secondaryAction && (
                    <WhitePillButton
                      onClick={() => void handleFailureAction(errorCopy.secondaryAction!.type)}
                    >
                      {errorCopy.secondaryAction.label}
                    </WhitePillButton>
                  )}
                  <BlackPillButton
                    onClick={() => void handleFailureAction(errorCopy.primaryAction.type)}
                  >
                    <RefreshCw size={14} strokeWidth={1.75} />
                    {errorCopy.primaryAction.label}
                  </BlackPillButton>
                </>
              ) : (
                // empty
                <>
                  <WhitePillButton onClick={() => onOpenChange(false)}>{t('skillhub.publishDialog.cancel')}</WhitePillButton>
                  <BlackPillButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
                    <CloudUpload size={14} strokeWidth={1.75} />
                    {t('skillhub.publishDialog.startPublish')}
                  </BlackPillButton>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

    </>
  );
}
