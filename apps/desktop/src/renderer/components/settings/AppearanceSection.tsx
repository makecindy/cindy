import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sun,
  Moon,
  Monitor,
  ChevronDown,
  Check,
  Copy,
  FolderOpen,
  Import as ImportIcon,
  RefreshCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { basename, cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { resolveIsDark, useTheme } from '@/hooks/useTheme';
import {
  clampFontSize,
  clampUiFontSize,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  useFontSettings,
} from '@/hooks/useFontSettings';
import { useSidebarCardMode, type SidebarViewMode } from '@/hooks/useSidebarCardMode';
import {
  getThemeFamilies,
  resolveFamilyVariant,
  type ThemeFamily,
} from '@/themes/families';
import {
  buildCopyFromTheme,
  onLocalThemesChange,
  refreshLocalThemes,
} from '@/themes/local-themes';
import { toast } from '@/lib/toast';
import { isLocalThemeId } from '../../../shared/local-themes';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { Slider } from '@/components/ui/slider';
import { extractIpcError } from '@/utils/ipcError';
import { FontFamilyPicker, type FontPreset } from './FontFamilyPicker';

const log = createLogger('settings/AppearanceSection');

/** IPC 错误码 → 专门文案；未列出的码落到通用 importFailed。 */
const IMPORT_ERROR_KEYS: Record<string, string> = {
  THEME_UNSUPPORTED_FILE: 'settings.appearance.localThemes.importUnsupported',
  THEME_USES_INCLUDE: 'settings.appearance.localThemes.importUsesInclude',
  THEME_NOT_A_FILE: 'settings.appearance.localThemes.importNotAFile',
  THEME_FILE_TOO_LARGE: 'settings.appearance.localThemes.importTooLarge',
  THEME_WRITE_ERROR: 'settings.appearance.localThemes.importWriteError',
  THEME_IMPORT_INTERNAL: 'settings.appearance.localThemes.importInternalError',
};

type ThemeOption = 'light' | 'dark' | 'system';

const THEME_OPTIONS: ThemeOption[] = ['light', 'dark', 'system'];

const UI_FONT_PRESETS: FontPreset[] = [
  {
    id: 'default',
    labelKey: 'settings.appearance.font.presetsUi.default',
    family: '',
  },
  {
    id: 'codexStyle',
    labelKey: 'settings.appearance.font.presetsUi.codexStyle',
    family: '-apple-system, BlinkMacSystemFont, "Segoe UI"',
  },
  {
    id: 'harmonyOS',
    labelKey: 'settings.appearance.font.presetsUi.harmonyOS',
    family: '"HarmonyOS Sans SC"',
  },
];

const CODE_FONT_PRESETS: FontPreset[] = [
  {
    id: 'default',
    labelKey: 'settings.appearance.font.presetsCode.default',
    family: '',
  },
  {
    id: 'jetbrainsMono',
    labelKey: 'settings.appearance.font.presetsCode.jetbrainsMono',
    family: '"JetBrains Mono Variable", "JetBrains Mono"',
  },
];

const CODE_FONT_PREVIEW_SAMPLE =
  '// preview 0O 1lI\n' +
  'const greet = (name: string, n = 3): string =>\n' +
  '  `Hello, ${name}!`.repeat(n);\n' +
  'if (greet("AI", 0).length !== 0) throw new Error("oops");';

interface ThemeCardProps {
  value: ThemeOption;
  label: string;
  ariaLabel: string;
  preview: React.ReactNode;
  isSelected: boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Theme-locked preview background (固定不跟随当前主题). Auto 卡片内部自带 split 背景时省略此项。 */
  previewBg?: string;
  /** Active 态描边色覆写。Auto 卡片在 split 背景上无法用纯黑/白，需显式传 Stone 等中灰。 */
  activeRingColor?: string;
}

function ThemeCard({
  value,
  label,
  ariaLabel,
  preview,
  isSelected,
  onClick,
  onKeyDown,
  previewBg,
  activeRingColor,
}: ThemeCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      aria-label={ariaLabel}
      tabIndex={isSelected ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="flex flex-1 flex-col items-center gap-2"
      data-theme-value={value}
    >
      {/* Preview box — 72px tall, rounded 12, 1px Board / 2px active ring */}
      <div
        className={cn(
          'flex h-[72px] w-full items-center justify-center overflow-hidden rounded-xl',
          'transition-colors',
          isSelected ? 'border-2' : 'border',
        )}
        style={{
          backgroundColor: previewBg,
          borderColor: isSelected
            ? activeRingColor ?? 'var(--settings-theme-preview-border-active)'
            : 'var(--settings-theme-preview-border)',
        }}
      >
        {preview}
      </div>

      {/* Label row — 13/500, Stone → active Pure Black/White; active has trailing dot */}
      <div className="flex items-center gap-1">
        <span
          className={cn(
            'text-13 font-medium transition-colors',
            isSelected
              ? 'text-[var(--settings-theme-label-active)]'
              : 'text-[var(--settings-theme-label)]',
          )}
        >
          {label}
        </span>
        {isSelected ? (
          <span
            className="h-1.5 w-1.5 rounded-full bg-[var(--settings-theme-label-active)]"
            aria-hidden
          />
        ) : null}
      </div>
    </button>
  );
}

/**
 * 本地主题工具按钮 —— icon-only 方钮（36×36），hover 出 tooltip 显示文案。
 * 三个动作（新建副本 / 打开目录 / 刷新）统一描边样式、同色图标，主次靠分组而非配色区分。
 */
function LocalThemeIconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-xl',
          'border border-[var(--settings-input-border)]',
          'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
          'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
        )}
      >
        <Icon size={16} />
      </button>
    </Tip>
  );
}

interface FamilyDropdownProps {
  label: string;
  ariaLabel: string;
  families: ThemeFamily[];
  selectedId: string;
  onSelect: (familyId: string) => void;
  getLabel: (family: ThemeFamily) => string;
}

function FamilyDropdown({
  label,
  ariaLabel,
  families,
  selectedId,
  onSelect,
  getLabel,
}: FamilyDropdownProps) {
  const [open, setOpen] = useState(false);
  const selected = families.find((f) => f.id === selectedId) ?? families[0];

  return (
    <div className="flex flex-col gap-2">
      <p
        className="text-13 font-medium text-[var(--settings-section-sublabel)]"
        style={{ letterSpacing: '0.12px' }}
      >
        {label}
      </p>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              'flex h-10 w-full items-center justify-between rounded-xl px-3',
              'border border-[var(--settings-input-border)]',
              'bg-[var(--settings-input-bg)] text-left',
              'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
            )}
          >
            <span className="truncate text-13 font-medium text-[var(--settings-input-text)]">
              {getLabel(selected)}
            </span>
            <ChevronDown size={14} className="shrink-0 text-[var(--settings-eye-icon)]" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'w-[var(--radix-popover-trigger-width)] rounded-xl p-2',
            'border border-[var(--settings-input-border)]',
            'bg-[var(--settings-theme-card-bg)]',
          )}
        >
          <div className="flex flex-col gap-[2px]" role="listbox" aria-label={ariaLabel}>
            {families.map((family) => {
              const isSelected = selectedId === family.id;
              return (
                <button
                  key={family.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onSelect(family.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[8px] px-3 py-2',
                    'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
                    isSelected && 'bg-[var(--settings-menu-bg-hover)]',
                  )}
                >
                  <span className="text-13 font-medium text-[var(--settings-input-text)]">
                    {getLabel(family)}
                  </span>
                  {isSelected ? (
                    <Check size={16} className="shrink-0 text-[var(--settings-theme-icon-active)]" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function AppearanceSection() {
  const { theme, setTheme, familyId, setFamily, fallbackFromType } = useTheme();
  const {
    uiFamily,
    codeFamily,
    uiSize,
    codeSize,
    setUiFamily,
    setCodeFamily,
    setUiSize,
    setCodeSize,
    resetUiFamily,
    resetCodeFamily,
    resetUiSize,
    resetCodeSize,
  } = useFontSettings();
  const { mode: sidebarViewMode, setMode: setSidebarViewMode } = useSidebarCardMode();
  const { t } = useTranslation();
  const [localThemesVersion, setLocalThemesVersion] = useState(0);
  const [uiSizeInput, setUiSizeInput] = useState(String(uiSize));
  const [codeSizeInput, setCodeSizeInput] = useState(String(codeSize));
  const families = useMemo(() => getThemeFamilies(), [localThemesVersion]);
  const selectedFamily = families.find((f) => f.id === familyId) ?? families[0];

  useEffect(() => {
    void refreshLocalThemes();
  }, []);

  useEffect(() => {
    setUiSizeInput(String(uiSize));
  }, [uiSize]);

  useEffect(() => {
    setCodeSizeInput(String(codeSize));
  }, [codeSize]);

  useEffect(() => onLocalThemesChange(() => {
    setLocalThemesVersion((version) => version + 1);
  }), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = THEME_OPTIONS.indexOf(theme);
      let nextIndex = currentIndex;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (currentIndex + 1) % THEME_OPTIONS.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = (currentIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        return;
      } else {
        return;
      }

      setTheme(THEME_OPTIONS[nextIndex]);
    },
    [theme, setTheme],
  );

  const getFamilyLabel = useCallback(
    (family: ThemeFamily) => isLocalThemeId(family.id)
      ? `${family.name} ${t('settings.appearance.localBadge')}`
      : family.name,
    [t],
  );

  const handleExport = useCallback(async () => {
    const isDark = resolveIsDark(theme);
    const { theme: activeTheme } = resolveFamilyVariant(
      familyId,
      isDark ? 'dark' : 'light',
    );
    const { baseId, theme: themeJson } = buildCopyFromTheme(activeTheme);
    const result = await window.electronAPI.localThemes.write({
      baseId,
      theme: themeJson,
    });
    if (!result.success) {
      toast.error(
        t('settings.appearance.localThemes.exportFailed', { error: result.error }),
      );
      return;
    }
    // openDir 失败只 log,不退化 success toast — 文件已落盘是主要事实
    const [, openResult] = await Promise.all([
      refreshLocalThemes(),
      window.electronAPI.localThemes.openDir(),
    ]);
    if (!openResult.success) {
      log.warn('Failed to open themes dir after export:', openResult.error);
    }
    toast.success(
      t('settings.appearance.localThemes.exportSuccess', { file: basename(result.path) }),
    );
  }, [familyId, t, theme]);

  const handleImport = useCallback(async () => {
    let result;
    try {
      result = await window.electronAPI.localThemes.importExternal();
    } catch (err) {
      const ipcErr = extractIpcError(err);
      const key = ipcErr ? IMPORT_ERROR_KEYS[ipcErr.code] : undefined;
      toast.error(
        key
          ? t(key)
          : t('settings.appearance.localThemes.importFailed', { error: ipcErr?.code ?? 'UNKNOWN' }),
      );
      return;
    }
    if (result.canceled) return;
    await refreshLocalThemes();
    const name = result.written[0]?.name ?? '';
    const skipped = result.report.skippedProtected;
    const unresolved = result.report.unresolved.length;
    const derived = result.report.derivedRoles.length;
    if (skipped > 0 || unresolved > 0 || derived > 0) {
      toast.success(
        t('settings.appearance.localThemes.importPartial', {
          name,
          themeCount: result.written.length,
          skipped,
          unresolved,
          derived,
        }),
      );
      return;
    }
    toast.success(
      t('settings.appearance.localThemes.importSuccess', {
        name,
        themeCount: result.written.length,
      }),
    );
  }, [t]);

  const handleOpenDir = useCallback(async () => {
    const result = await window.electronAPI.localThemes.openDir();
    if (!result.success) {
      toast.error(
        t('settings.appearance.localThemes.openDirFailed', { error: result.error }),
      );
    }
  }, [t]);

  const handleRefresh = useCallback(async () => {
    await refreshLocalThemes();
    if (isLocalThemeId(familyId)) setFamily(familyId);
    toast.success(t('settings.appearance.localThemes.refreshed'));
  }, [familyId, setFamily, t]);

  const commitCodeSizeInput = useCallback(() => {
    const trimmed = codeSizeInput.trim();
    const next = Number(codeSizeInput);
    if (trimmed !== '' && Number.isFinite(next)) {
      const normalized = clampFontSize(next);
      setCodeSize(normalized);
      setCodeSizeInput(String(normalized));
      return;
    }
    setCodeSizeInput(String(codeSize));
  }, [codeSize, codeSizeInput, setCodeSize]);

  const commitUiSizeInput = useCallback(() => {
    const trimmed = uiSizeInput.trim();
    const next = Number(uiSizeInput);
    if (trimmed !== '' && Number.isFinite(next)) {
      const normalized = clampUiFontSize(next);
      setUiSize(normalized);
      setUiSizeInput(String(normalized));
      return;
    }
    setUiSizeInput(String(uiSize));
  }, [uiSize, uiSizeInput, setUiSize]);

  // 预览背景与图标色按选项「主题锁定」——Light 卡永远展示亮态，Dark 卡永远展示暗态，
  // 不再跟随当前 theme，让三张卡片的预览语义一致（都展示选中后的实际外观）。
  // Auto 卡片用 split 背景已经表达「双状态」，无需 previewBg。
  const LIGHT_PREVIEW_BG = '#f8f8f6';
  const DARK_PREVIEW_BG = '#1f1f1e';
  // Auto 卡 active ring 在 split 背景上需要中灰才能两半都可见，避免纯黑/纯白被吞。
  const AUTO_ACTIVE_RING = '#737373';

  // fallbackFromType = 'light': 用户要 light, 家族没 light, 已 fallback 到 dark
  //                            → 提示 "xx 主题没有提供浅色方案"
  // fallbackFromType = 'dark' : 反之
  const noticeKey =
    fallbackFromType === 'light'
      ? 'settings.appearance.missingLightNotice'
      : fallbackFromType === 'dark'
        ? 'settings.appearance.missingDarkNotice'
        : null;

  return (
    <div className="flex flex-col gap-[14px]">
      {/* Section title — outside the card */}
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.appearance.title')}
      </h2>

      {/* Theme card — rounded 12, Card bg, 1px Board, padding 20 */}
      <div
        className={cn(
          'flex flex-col gap-[14px] rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        {/* Appearance mode */}
        <p
          className="text-13 font-medium text-[var(--settings-section-sublabel)]"
          style={{ letterSpacing: '0.12px' }}
        >
          {t('settings.appearance.modeLabel')}
        </p>

        {/* Theme options — gap 12 */}
        <div
          className="flex gap-3"
          role="radiogroup"
          aria-label={t('settings.appearance.themeAriaLabel')}
        >
          <ThemeCard
            value="light"
            label={t('settings.appearance.theme.light')}
            ariaLabel={t('settings.appearance.themeAria.light')}
            previewBg={LIGHT_PREVIEW_BG}
            preview={<Sun size={28} style={{ color: '#262626' }} />}
            isSelected={theme === 'light'}
            onClick={() => setTheme('light')}
            onKeyDown={handleKeyDown}
          />

          <ThemeCard
            value="dark"
            label={t('settings.appearance.theme.dark')}
            ariaLabel={t('settings.appearance.themeAria.dark')}
            previewBg={DARK_PREVIEW_BG}
            preview={<Moon size={28} style={{ color: '#d4d4d4' }} />}
            isSelected={theme === 'dark'}
            onClick={() => setTheme('dark')}
            onKeyDown={handleKeyDown}
          />

          <ThemeCard
            value="system"
            label={t('settings.appearance.theme.system')}
            ariaLabel={t('settings.appearance.themeAria.system')}
            activeRingColor={AUTO_ACTIVE_RING}
            preview={
              <div
                className="flex h-full w-full items-center justify-center"
                style={{
                  background:
                    'linear-gradient(90deg, var(--settings-theme-auto-dark) 0%, var(--settings-theme-auto-dark) 50%, var(--settings-theme-auto-light) 50%, var(--settings-theme-auto-light) 100%)',
                }}
              >
                {/* Monitor icon 用 Stone #737373，跨 split 两半都有足够对比度。 */}
                <Monitor size={28} className="text-[var(--settings-theme-icon)]" />
              </div>
            }
            isSelected={theme === 'system'}
            onClick={() => setTheme('system')}
            onKeyDown={handleKeyDown}
          />
        </div>

        <FamilyDropdown
          label={t('settings.appearance.themeLabel')}
          ariaLabel={t('settings.appearance.themeAriaLabel')}
          families={families}
          selectedId={familyId}
          onSelect={setFamily}
          getLabel={getFamilyLabel}
        />

        <div className="flex flex-col gap-2 pt-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.appearance.localThemes.title')}
          </p>
          <div className="flex flex-wrap gap-2">
            <LocalThemeIconButton
              icon={Copy}
              label={t('settings.appearance.localThemes.export')}
              onClick={() => { void handleExport(); }}
            />
            <LocalThemeIconButton
              icon={ImportIcon}
              label={t('settings.appearance.localThemes.import')}
              onClick={() => { void handleImport(); }}
            />
            <LocalThemeIconButton
              icon={FolderOpen}
              label={t('settings.appearance.localThemes.openDir')}
              onClick={() => { void handleOpenDir(); }}
            />
            <LocalThemeIconButton
              icon={RefreshCw}
              label={t('settings.appearance.localThemes.refresh')}
              onClick={() => { void handleRefresh(); }}
            />
          </div>
        </div>

        {noticeKey ? (
          <p className="text-12 leading-[1.5] text-[var(--settings-section-sublabel)]">
            {t(noticeKey, { name: selectedFamily.name })}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          'flex flex-col gap-[14px] rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <FontFamilyPicker
          label={t('settings.appearance.font.uiFamily.label')}
          description={t('settings.appearance.font.uiFamily.description')}
          ariaLabel={t('settings.appearance.font.uiFamily.aria')}
          value={uiFamily}
          presets={UI_FONT_PRESETS}
          previewSample={t('settings.appearance.font.previewSamples.ui')}
          previewFallbackFamily="var(--app-font-ui-default)"
          onChange={setUiFamily}
          onReset={resetUiFamily}
        />

        <div className="h-px bg-[var(--settings-input-border)]" />

        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                className="text-13 font-medium text-[var(--settings-section-sublabel)]"
                style={{ letterSpacing: '0.12px' }}
              >
                {t('settings.appearance.font.uiSize.label')}
              </p>
              <p className="mt-1 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.appearance.font.uiSize.description')}
              </p>
            </div>
            <Tip text={t('settings.appearance.font.reset')}>
              <button
                type="button"
                aria-label={t('settings.appearance.font.reset')}
                onClick={resetUiSize}
                disabled={uiSize === DEFAULT_UI_FONT_SIZE}
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                  'border border-[var(--settings-input-border)]',
                  'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                  'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
                  'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-[var(--settings-input-bg)]',
                )}
              >
                <RefreshCw size={14} />
              </button>
            </Tip>
          </div>

          <div className="flex items-center gap-3">
            <Slider
              min={12}
              max={24}
              step={1}
              value={[uiSize]}
              onValueChange={([next]) => {
                if (typeof next === 'number') setUiSize(next);
              }}
              aria-label={t('settings.appearance.font.uiSize.aria')}
            />
            <input
              type="number"
              min={12}
              max={24}
              step={1}
              value={uiSizeInput}
              onChange={(e) => setUiSizeInput(e.target.value)}
              onBlur={commitUiSizeInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitUiSizeInput();
                  e.currentTarget.blur();
                }
              }}
              className={cn(
                'h-9 w-[72px] rounded-xl border px-3 text-right text-[13px] outline-none',
                'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                'font-mono text-[var(--settings-input-text)]',
                'focus:border-[var(--settings-input-border-focus)]',
              )}
            />
          </div>
        </div>

        <div className="h-px bg-[var(--settings-input-border)]" />

        <FontFamilyPicker
          label={t('settings.appearance.font.codeFamily.label')}
          description={t('settings.appearance.font.codeFamily.description')}
          ariaLabel={t('settings.appearance.font.codeFamily.aria')}
          value={codeFamily}
          presets={CODE_FONT_PRESETS}
          previewSample={CODE_FONT_PREVIEW_SAMPLE}
          previewLanguage="typescript"
          previewFallbackFamily="var(--app-font-code-default)"
          onChange={setCodeFamily}
          onReset={resetCodeFamily}
        />

        <div className="h-px bg-[var(--settings-input-border)]" />

        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                className="text-13 font-medium text-[var(--settings-section-sublabel)]"
                style={{ letterSpacing: '0.12px' }}
              >
                {t('settings.appearance.font.codeSize.label')}
              </p>
              <p className="mt-1 text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
                {t('settings.appearance.font.codeSize.description')}
              </p>
            </div>
            <Tip text={t('settings.appearance.font.reset')}>
              <button
                type="button"
                aria-label={t('settings.appearance.font.reset')}
                onClick={resetCodeSize}
                disabled={codeSize === DEFAULT_CODE_FONT_SIZE}
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                  'border border-[var(--settings-input-border)]',
                  'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                  'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
                  'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-[var(--settings-input-bg)]',
                )}
              >
                <RefreshCw size={14} />
              </button>
            </Tip>
          </div>

          <div className="flex items-center gap-3">
            <Slider
              min={10}
              max={24}
              step={1}
              value={[codeSize]}
              onValueChange={([next]) => {
                if (typeof next === 'number') setCodeSize(next);
              }}
              aria-label={t('settings.appearance.font.codeSize.aria')}
            />
            <input
              type="number"
              min={10}
              max={24}
              step={1}
              value={codeSizeInput}
              onChange={(e) => setCodeSizeInput(e.target.value)}
              onBlur={commitCodeSizeInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitCodeSizeInput();
                  e.currentTarget.blur();
                }
              }}
              className={cn(
                'h-9 w-[72px] rounded-xl border px-3 text-right text-[13px] outline-none',
                'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
                'font-mono text-[var(--settings-input-text)]',
                'focus:border-[var(--settings-input-border-focus)]',
              )}
            />
          </div>
        </div>
      </div>

      {/* Sidebar card mode — 卡片瀑布流 vs 紧凑列表（sidebar-card-mode redesign）。
          独立卡片，沿用 NotificationSection 的 label+hint+Switch 行模式。 */}
      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl p-5',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {t('settings.appearance.sidebarCardMode.label')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.appearance.sidebarCardMode.hint')}
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label={t('settings.appearance.sidebarCardMode.aria')}
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--settings-theme-card-border)] p-0.5"
        >
          {([
            { value: 'text', labelKey: 'ccAgent.sidebar.viewStyleList' },
            { value: 'card', labelKey: 'ccAgent.sidebar.viewStyleCard' },
            { value: 'list', labelKey: 'ccAgent.sidebar.viewStyleListWide' },
          ] as Array<{ value: SidebarViewMode; labelKey: string }>).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={sidebarViewMode === opt.value}
              onClick={() => setSidebarViewMode(opt.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                sidebarViewMode === opt.value
                  ? 'bg-[var(--chat-input-chip-bg)] font-medium text-[var(--msg-assistant-text)]'
                  : 'text-[var(--settings-section-sublabel)] hover:bg-sidebar-item-hover',
              )}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
