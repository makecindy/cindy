import { appearanceSettings, UI_FONT_PRESETS, CODE_FONT_PRESETS, TERMINAL_FONT_PRESETS } from './AppearanceSection.settings-search';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';

import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  Copy,
  FolderOpen,
  Import as ImportIcon,
  Palette,
  RefreshCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { basename, cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { prefillThemeCreatorDraft } from '@/lib/themeCreatorDraft';
import { resolveIsDark, useTheme } from '@/hooks/useTheme';
import {
  clampFontSize,
  clampUiFontSize,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  useFontSettings,
} from '@/hooks/useFontSettings';
import { useSidebarCardMode, useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import { getThemeFamilies, resolveFamilyVariant, type ThemeFamily } from '@/themes/families';
import { resolveThemeValue } from '@/themes/theme-service';
import type { Theme } from '@/themes/types';
import { buildCopyFromTheme, onLocalThemesChange, refreshLocalThemes } from '@/themes/local-themes';
import { toast } from '@/lib/toast';
import { isLocalThemeId } from '../../../shared/local-themes';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { Slider } from '@/components/ui/slider';
import { extractIpcError } from '@/utils/ipcError';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { DockIconPicker } from './DockIconPicker';
import { SettingsTextInput } from './SettingsTextInput';
import { FontFamilyPicker } from './FontFamilyPicker';
import { LayoutResetControl } from './LayoutResetControl';
import { SETTINGS_PAGE_TITLE_CLASS, SettingsCard, SettingsField, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { WallpaperSection } from './WallpaperSection';
import {
  APPEARANCE_LIMITS,
  clampAppearanceTerminalSize,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from '../../../shared/appearanceSettings';

const log = createLogger('settings/AppearanceSection');

/** IPC 错误码 → 专门文案；未列出的码落到通用 importFailed。 */
const IMPORT_ERROR_KEYS: Record<string, string> = {
  THEME_UNSUPPORTED_FILE: 'settings.appearance.localThemes.importUnsupported',
  THEME_CONTRAST_UNSUPPORTED: 'settings.appearance.localThemes.importContrastUnsupported',
  THEME_USES_INCLUDE: 'settings.appearance.localThemes.importUsesInclude',
  THEME_NOT_A_FILE: 'settings.appearance.localThemes.importNotAFile',
  THEME_FILE_TOO_LARGE: 'settings.appearance.localThemes.importTooLarge',
  THEME_WRITE_ERROR: 'settings.appearance.localThemes.importWriteError',
  THEME_IMPORT_INTERNAL: 'settings.appearance.localThemes.importInternalError',
};

type ThemeOption = 'light' | 'dark' | 'system';

const THEME_OPTIONS = appearanceSettings.modeLabel.options.map(({ value }) => value);







const CODE_FONT_PREVIEW_SAMPLE =
  '// preview 0O 1lI\n' +
  'const greet = (name: string, n = 3): string =>\n' +
  '  `Hello, ${name}!`.repeat(n);\n' +
  'if (greet("AI", 0).length !== 0) throw new Error("oops");';

/** 缩略图配色:取所选配色主题的真实 token,让三张预览随配色变化。 */
interface ModePalette {
  canvas: string;
  sidebar: string;
  line: string;
  field: string;
  send: string;
  ink: string;
}

function modePalette(theme: Theme): ModePalette {
  // 回退用同名语义角色的 CSS 变量,不写字面色值(所选主题缺项时跟随当前全局主题)。
  const value = (id: string) => resolveThemeValue(theme, id) ?? `var(--${id})`;
  return {
    canvas: value('surface'),
    sidebar: value('surface-chip'),
    line: value('border-default'),
    field: value('surface-elevated'),
    send: value('text-primary'),
    ink: value('text-tertiary'),
  };
}

/** 一张迷你 Cindy 窗口:左侧栏、右上用户消息、几行回复、底部输入框与发送键。 */
function ModeThumbnail({ palette }: { palette: ModePalette }) {
  const bar = 'absolute h-[2px] rounded-full';
  return (
    <span className="absolute inset-0" style={{ background: palette.canvas }} aria-hidden>
      <span
        className="absolute inset-y-0 left-0 w-[20px] border-r"
        style={{ background: palette.sidebar, borderColor: palette.line }}
      >
        <span
          className="absolute left-[7px] top-[7px] h-[6px] w-[6px] rounded-full"
          style={{ background: palette.ink, opacity: 0.55 }}
        />
        <span
          className={cn(bar, 'left-[5px] top-[18px] w-[10px]')}
          style={{ background: palette.ink, opacity: 0.3 }}
        />
        <span
          className={cn(bar, 'left-[5px] top-[23px] w-[8px]')}
          style={{ background: palette.ink, opacity: 0.3 }}
        />
      </span>
      <span
        className="absolute right-[8px] top-[8px] h-[7px] w-[30px] rounded-[3px]"
        style={{ background: palette.ink, opacity: 0.22 }}
      />
      <span
        className={cn(bar, 'left-[28px] top-[21px] w-[44px]')}
        style={{ background: palette.ink, opacity: 0.45 }}
      />
      <span
        className={cn(bar, 'left-[28px] top-[26px] w-[50px]')}
        style={{ background: palette.ink, opacity: 0.45 }}
      />
      <span
        className={cn(bar, 'left-[28px] top-[31px] w-[32px]')}
        style={{ background: palette.ink, opacity: 0.45 }}
      />
      <span
        className="absolute bottom-[6px] left-[26px] right-[6px] h-[11px] rounded-full border"
        style={{ background: palette.field, borderColor: palette.line }}
      >
        <span
          className="absolute right-[2px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full"
          style={{ background: palette.send }}
        />
      </span>
    </span>
  );
}

interface ThemeCardProps {
  value: ThemeOption;
  label: string;
  ariaLabel: string;
  light: ModePalette;
  dark: ModePalette;
  isSelected: boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** 当前主题只有一种方案时，显示模式不可选。 */
  disabled?: boolean;
}

/**
 * 显示模式缩略图:外圈 12px(2px 描边 + 2px 间隙)与内图 8px 同心;选中态外圈用
 * 现有 preview-border-active,未选中透明、悬停时显出普通描边。「跟随系统」左浅右深。
 */
function ThemeCard({
  value,
  label,
  ariaLabel,
  light,
  dark,
  isSelected,
  onClick,
  onKeyDown,
  disabled = false,
}: ThemeCardProps) {
  return (
    <button data-setting-id={appearanceSettings.modeLabel.id}
      type="button"
      role="radio"
      aria-checked={isSelected}
      aria-label={ariaLabel}
      tabIndex={isSelected ? 0 : -1}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="group flex flex-col items-center gap-1.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
      data-theme-value={value}
    >
      <span
        className={cn(
          'block rounded-xl border-2 p-[2px] transition-colors',
          isSelected
            ? 'border-[var(--settings-theme-preview-border-active)]'
            : cn(
                'border-transparent',
                !disabled && 'group-hover:border-[var(--settings-theme-preview-border)]',
              ),
        )}
      >
        <span
          className="relative block h-[60px] w-[92px] overflow-hidden rounded-[8px] border"
          style={{ borderColor: 'var(--settings-theme-preview-border)' }}
        >
          <ModeThumbnail palette={value === 'dark' ? dark : light} />
          {value === 'system' ? (
            <span className="absolute inset-0" style={{ clipPath: 'inset(0 0 0 50%)' }}>
              <ModeThumbnail palette={dark} />
            </span>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          'text-12 transition-colors',
          isSelected
            ? 'font-medium text-[var(--settings-theme-label-active)]'
            : 'text-[var(--settings-theme-label)]',
        )}
      >
        {label}
      </span>
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
      <Button data-settings-search-action="Copy, reveal or refresh local theme files"
        variant="secondary"
        size="lg"
        className="w-9 px-0"
        type="button"
        aria-label={label}
        onClick={onClick}
      >
        <Icon size={16} />
      </Button>
    </Tip>
  );
}

interface FamilyDropdownProps {
  label: string;
  createAction: ReactNode;
  ariaLabel: string;
  families: ThemeFamily[];
  selectedId: string;
  onSelect: (familyId: string) => void;
  getLabel: (family: ThemeFamily) => string;
  /** 只有浅色或只有深色方案的主题，在名称后标注「仅浅色 / 仅深色」。 */
  getVariantBadge: (family: ThemeFamily) => string | null;
}

function singleVariantType(family: ThemeFamily): 'light' | 'dark' | null {
  if (family.light && !family.dark) return 'light';
  if (!family.light && family.dark) return 'dark';
  return null;
}

function VariantBadge({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--surface-chip)] px-2 py-1 text-11 font-medium leading-none text-[var(--text-secondary)]">
      {text}
    </span>
  );
}

/**
 * 主题选择:一行设置——左侧名称,右侧与「显示语言」同款的胶囊下拉(Radix Select,
 * 同尺寸、同展开面板与选中样式)。单方案主题在名称后标「仅浅色 / 仅深色」。
 */
function FamilyDropdown({
  label,
  createAction,
  ariaLabel,
  families,
  selectedId,
  onSelect,
  getLabel,
  getVariantBadge,
}: FamilyDropdownProps) {
  const selected = families.find((f) => f.id === selectedId) ?? families[0];

  return (
    <SettingsRow
      className="gap-6"
      title={<span className="flex min-w-0 flex-wrap items-center gap-2">{label}{createAction}</span>}
      trailing={
      <Select data-setting-id={appearanceSettings.themeLabel.id}
        label={ariaLabel}
        value={selected.id}
        options={families.map((family) => ({
          value: family.id,
          label: getLabel(family),
          endAdornment: getVariantBadge(family) ? <VariantBadge text={getVariantBadge(family)} /> : undefined,
        }))}
        triggerAdornment={getVariantBadge(selected) ? <VariantBadge text={getVariantBadge(selected)} /> : undefined}
        truncateOptions
        onValueChange={onSelect}
        width="md"
        className="shrink-0"
      />
      }
    />
  );
}

export function AppearanceSection() {
  const navigate = useNavigate();
  const { theme, setTheme, familyId, setFamily } = useTheme();
  const {
    customizedKeys,
    uiFamily,
    codeFamily,
    uiSize,
    codeSize,
    terminalFamily,
    terminalSize,
    setUiFamily,
    setCodeFamily,
    setUiSize,
    setCodeSize,
    setTerminalFamily,
    setTerminalSize,
    resetUiFamily,
    resetCodeFamily,
    resetUiSize,
    resetCodeSize,
    resetTerminalFamily,
    resetTerminalSize,
  } = useFontSettings();
  const customized = (key: string, legacy: boolean) => customizedKeys ? customizedKeys.includes(key) : legacy;
  const { mode: sidebarViewMode, setMode: setSidebarViewMode } = useSidebarCardMode();
  const { mode: sidebarMainViewMode, setMode: setSidebarMainViewMode } = useSidebarMainViewMode();
  const { t } = useTranslation();
  const [creatingTheme, setCreatingTheme] = useState(false);
  const [localThemesVersion, setLocalThemesVersion] = useState(0);
  const [uiSizeInput, setUiSizeInput] = useState(String(uiSize));
  const [codeSizeInput, setCodeSizeInput] = useState(String(codeSize));
  const [terminalSizeInput, setTerminalSizeInput] = useState(String(terminalSize));
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

  useEffect(() => {
    setTerminalSizeInput(String(terminalSize));
  }, [terminalSize]);

  useEffect(
    () =>
      onLocalThemesChange(() => {
        setLocalThemesVersion((version) => version + 1);
      }),
    [],
  );

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
    (family: ThemeFamily) =>
      isLocalThemeId(family.id)
        ? `${family.name} ${t('settings.appearance.localBadge')}`
        : family.name,
    [t],
  );

  const handleCreateTheme = useCallback(async () => {
    if (creatingTheme) return;
    setCreatingTheme(true);
    try {
      const result = await prefillThemeCreatorDraft(t('settings.appearance.createTheme.prompt'));
      if (result === 'prepared') navigate('/cc-agent/new');
      else if (result === 'unavailable') toast.error(t('settings.appearance.createTheme.unavailable'));
    } catch (error) {
      log.warn('Failed to prepare theme creation draft:', error);
      toast.error(t('settings.appearance.createTheme.startFailed'));
    } finally {
      setCreatingTheme(false);
    }
  }, [creatingTheme, navigate, t]);

  const handleExport = useCallback(async () => {
    const isDark = resolveIsDark(theme);
    const { theme: activeTheme } = resolveFamilyVariant(familyId, isDark ? 'dark' : 'light');
    const { baseId, theme: themeJson } = buildCopyFromTheme(activeTheme);
    const result = await window.electronAPI.localThemes.write({
      baseId,
      theme: themeJson,
    });
    if (!result.success) {
      toast.error(t('settings.appearance.localThemes.exportFailed', { error: result.error }));
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
      toast.error(t('settings.appearance.localThemes.openDirFailed', { error: result.error }));
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

  const commitTerminalSizeInput = useCallback(() => {
    const trimmed = terminalSizeInput.trim();
    const next = Number(terminalSizeInput);
    if (trimmed !== '' && Number.isFinite(next)) {
      const normalized = clampAppearanceTerminalSize(next);
      setTerminalSize(normalized);
      setTerminalSizeInput(String(normalized));
      return;
    }
    setTerminalSizeInput(String(terminalSize));
  }, [terminalSize, terminalSizeInput, setTerminalSize]);

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

  // 三张缩略图按所选配色的浅 / 深方案上色;配色缺某一方案时用另一方案(此时模式已锁定)。
  const lightPalette = modePalette(resolveFamilyVariant(selectedFamily.id, 'light').theme);
  const darkPalette = modePalette(resolveFamilyVariant(selectedFamily.id, 'dark').theme);

  // 只有一种方案的主题:显示模式固定为该方案,模式卡片只读并按实际显示选中;
  // 用户保存的显示模式不改,换回双方案主题后照旧生效。
  const lockedType = singleVariantType(selectedFamily);
  const modeSelected = (option: ThemeOption) =>
    lockedType ? option === lockedType : theme === option;
  const getVariantBadge = (family: ThemeFamily) => {
    const only = singleVariantType(family);
    return only ? t(`settings.appearance.singleVariant.${only}Only`) : null;
  };

  // 「外观」已是独立分区,页内不再重复页名;按主题 / 壁纸 / 字体 / 侧边栏与面板分节,
  // 每节标题在卡片外,卡片内是带分割线的设置行(settings-rows)。
  return (
    <div className="flex flex-col gap-6">
      {/* 页面标题:比各节标题(16px)高一级,标题段 20px / 1.3 */}
      <h2 className={SETTINGS_PAGE_TITLE_CLASS}>
        {t('settings.appearance.title')}
      </h2>

      <div className="flex flex-col gap-[36px]">
        <SettingsSection
          id="settings-search-target-appearance-theme"
          aria-label={t(appearanceSettings.themeLabel.titleKey)}
        >
          {/* 主题卡片紧接页面标题,不再另设节标题 */}
          <SettingsCard id={appearanceSettings.themeLabel.targetId}>
            <FamilyDropdown
              label={t(appearanceSettings.themeLabel.titleKey)}
              createAction={
                <Tip text={t(appearanceSettings.createTheme.descriptionKey)}>
                  <Button
                    id={appearanceSettings.createTheme.targetId}
                    data-setting-id={appearanceSettings.createTheme.id}
                    variant="secondary"
                    size="sm"
                    compact
                    type="button"
                    loading={creatingTheme}
                    onClick={() => { void handleCreateTheme(); }}
                  >
                    <Palette size={14} aria-hidden="true" />
                    {t(appearanceSettings.createTheme.titleKey)}
                  </Button>
                </Tip>
              }
              ariaLabel={t('settings.appearance.themeAriaLabel')}
              families={families}
              selectedId={familyId}
              onSelect={setFamily}
              getLabel={getFamilyLabel}
              getVariantBadge={getVariantBadge}
            />

            {/* Appearance mode — 主题决定可用方案,故排在主题之后;左名称、右缩略图 */}
            <SettingsRow
              className="cindy-segmented-row"
              title={<span id={appearanceSettings.modeLabel.targetId}>{t(appearanceSettings.modeLabel.titleKey)}</span>}
              hint={lockedType
                ? t(`settings.appearance.singleVariant.${lockedType}Notice`, { name: selectedFamily.name })
                : undefined}
              trailing={
              <div
                className="flex shrink-0 gap-3"
                role="radiogroup"
                aria-label={t(appearanceSettings.modeLabel.titleKey)}
                aria-disabled={lockedType ? true : undefined}
              >
                <ThemeCard
                  value="light"
                  label={t(appearanceSettings.modeLabel.options[0].labelKey)}
                  ariaLabel={t('settings.appearance.themeAria.light')}
                  light={lightPalette}
                  dark={darkPalette}
                  isSelected={modeSelected('light')}
                  disabled={lockedType !== null}
                  onClick={() => setTheme('light')}
                  onKeyDown={handleKeyDown}
                />

                <ThemeCard
                  value="dark"
                  label={t(appearanceSettings.modeLabel.options[1].labelKey)}
                  ariaLabel={t('settings.appearance.themeAria.dark')}
                  light={lightPalette}
                  dark={darkPalette}
                  isSelected={modeSelected('dark')}
                  disabled={lockedType !== null}
                  onClick={() => setTheme('dark')}
                  onKeyDown={handleKeyDown}
                />

                <ThemeCard
                  value="system"
                  label={t(appearanceSettings.modeLabel.options[2].labelKey)}
                  ariaLabel={t('settings.appearance.themeAria.system')}
                  light={lightPalette}
                  dark={darkPalette}
                  isSelected={modeSelected('system')}
                  disabled={lockedType !== null}
                  onClick={() => setTheme('system')}
                  onKeyDown={handleKeyDown}
                />
              </div>
              }
            />

            {window.electronAPI?.platform === 'darwin' ? (
              <SettingsRow
                className="cindy-segmented-row"
                title={<span id={appearanceSettings.appIcon.targetId}>{t(appearanceSettings.appIcon.titleKey)}</span>}
                hint={t(appearanceSettings.appIcon.descriptionKey)}
                trailing={<DockIconPicker />}
              />
            ) : null}

            <SettingsRow
              wrap
              title={<span id={appearanceSettings.localThemesTitle.targetId}>{t(appearanceSettings.localThemesTitle.titleKey)}</span>}
              trailing={
              <div className="flex flex-wrap gap-2">
                <LocalThemeIconButton
                  icon={Copy}
                  label={t('settings.appearance.localThemes.export')}
                  onClick={() => {
                    void handleExport();
                  }}
                />
                <LocalThemeIconButton
                  icon={ImportIcon}
                  label={t('settings.appearance.localThemes.import')}
                  onClick={() => {
                    void handleImport();
                  }}
                />
                <LocalThemeIconButton
                  icon={FolderOpen}
                  label={t('settings.appearance.localThemes.openDir')}
                  onClick={() => {
                    void handleOpenDir();
                  }}
                />
                <LocalThemeIconButton
                  icon={RefreshCw}
                  label={t('settings.appearance.localThemes.refresh')}
                  onClick={() => {
                    void handleRefresh();
                  }}
                />
              </div>
              }
            />
          </SettingsCard>
        </SettingsSection>

        <WallpaperSection />

        <SettingsSection
          id={appearanceSettings.fonts.targetId}
          headingLevel={3}
          title={t(appearanceSettings.fonts.titleKey)}
          aria-label={t(appearanceSettings.fonts.titleKey)}
        >
          <SettingsCard>
            <SettingsField
              id={appearanceSettings.fontUiFamilyLabel.targetId}
              title={t(appearanceSettings.fontUiFamilyLabel.titleKey)}
              hint={t(appearanceSettings.fontUiFamilyLabel.descriptionKey)}
              action={<DefaultOverrideControls isCustomized={customized('uiFamily', Boolean(uiFamily.trim()))} onReset={resetUiFamily} />}
            >
              <FontFamilyPicker data-setting-id={appearanceSettings.fontUiFamilyLabel.id}
                ariaLabel={t('settings.appearance.font.uiFamily.aria')}
                value={uiFamily}
                presets={UI_FONT_PRESETS}
                previewSample={t('settings.appearance.font.previewSamples.ui')}
                previewFallbackFamily="var(--app-font-ui-default)"
                onChange={setUiFamily}
              />
            </SettingsField>

            <SettingsField
              title={<span id={appearanceSettings.fontUiSizeLabel.targetId}>{t(appearanceSettings.fontUiSizeLabel.titleKey)}</span>}
              hint={t(appearanceSettings.fontUiSizeLabel.descriptionKey)}
              action={<DefaultOverrideControls isCustomized={customized('uiSize', uiSize !== DEFAULT_UI_FONT_SIZE)} onReset={resetUiSize} />}
            >
              <div className="flex items-center gap-3">
                <Slider data-setting-id={appearanceSettings.fontUiSizeLabel.id}
                  min={12}
                  max={24}
                  step={1}
                  value={[uiSize]}
                  onValueChange={([next]) => {
                    if (typeof next === 'number') setUiSize(next);
                  }}
                  aria-label={t('settings.appearance.font.uiSize.aria')}
                />
                <SettingsTextInput data-setting-id={appearanceSettings.fontUiSizeLabel.id}
                  type="number"
                  aria-label={t(appearanceSettings.fontUiSizeLabel.titleKey)}
                  min={12}
                  max={24}
                  step={1}
                  value={uiSizeInput}
                  onChange={setUiSizeInput}
                  onBlur={commitUiSizeInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitUiSizeInput();
                      e.currentTarget.blur();
                    }
                  }}
                  size="md"
                  mono
                  className="w-[72px] shrink-0"
                  inputClassName="px-3 text-right"
                />
              </div>
            </SettingsField>

            <SettingsField
              id={appearanceSettings.fontCodeFamilyLabel.targetId}
              title={t(appearanceSettings.fontCodeFamilyLabel.titleKey)}
              hint={t(appearanceSettings.fontCodeFamilyLabel.descriptionKey)}
              action={<DefaultOverrideControls isCustomized={customized('codeFamily', Boolean(codeFamily.trim()))} onReset={resetCodeFamily} />}
            >
              <FontFamilyPicker data-setting-id={appearanceSettings.fontCodeFamilyLabel.id}
                ariaLabel={t('settings.appearance.font.codeFamily.aria')}
                value={codeFamily}
                presets={CODE_FONT_PRESETS}
                previewSample={CODE_FONT_PREVIEW_SAMPLE}
                previewLanguage="typescript"
                previewFallbackFamily="var(--app-font-code-default)"
                onChange={setCodeFamily}
              />
            </SettingsField>

            <SettingsField
              title={<span id={appearanceSettings.fontCodeSizeLabel.targetId}>{t(appearanceSettings.fontCodeSizeLabel.titleKey)}</span>}
              hint={t(appearanceSettings.fontCodeSizeLabel.descriptionKey)}
              action={<DefaultOverrideControls isCustomized={customized('codeSize', codeSize !== DEFAULT_CODE_FONT_SIZE)} onReset={resetCodeSize} />}
            >
              <div className="flex items-center gap-3">
                <Slider data-setting-id={appearanceSettings.fontCodeSizeLabel.id}
                  min={10}
                  max={24}
                  step={1}
                  value={[codeSize]}
                  onValueChange={([next]) => {
                    if (typeof next === 'number') setCodeSize(next);
                  }}
                  aria-label={t('settings.appearance.font.codeSize.aria')}
                />
                <SettingsTextInput data-setting-id={appearanceSettings.fontCodeSizeLabel.id}
                  type="number"
                  aria-label={t(appearanceSettings.fontCodeSizeLabel.titleKey)}
                  min={10}
                  max={24}
                  step={1}
                  value={codeSizeInput}
                  onChange={setCodeSizeInput}
                  onBlur={commitCodeSizeInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitCodeSizeInput();
                      e.currentTarget.blur();
                    }
                  }}
                  size="md"
                  mono
                  className="w-[72px] shrink-0"
                  inputClassName="px-3 text-right"
                />
              </div>
            </SettingsField>

            <SettingsField
              id={appearanceSettings.fontTerminalFamilyLabel.targetId}
              title={t(appearanceSettings.fontTerminalFamilyLabel.titleKey)}
              hint={t(appearanceSettings.fontTerminalFamilyLabel.descriptionKey)}
              action={<DefaultOverrideControls isCustomized={customized('terminalFamily', Boolean(terminalFamily.trim()))} onReset={resetTerminalFamily} />}
            >
              <FontFamilyPicker data-setting-id={appearanceSettings.fontTerminalFamilyLabel.id}
                ariaLabel={t('settings.appearance.font.terminalFamily.aria')}
                value={terminalFamily}
                presets={TERMINAL_FONT_PRESETS}
                previewSample={t('settings.appearance.font.previewSamples.terminal')}
                previewFallbackFamily={DEFAULT_TERMINAL_FONT_FAMILY}
                onChange={setTerminalFamily}
              />
            </SettingsField>

            <SettingsField
              title={<span id={appearanceSettings.fontTerminalSizeLabel.targetId}>{t(appearanceSettings.fontTerminalSizeLabel.titleKey)}</span>}
              hint={t(appearanceSettings.fontTerminalSizeLabel.descriptionKey)}
              action={<DefaultOverrideControls isCustomized={customized('terminalSize', terminalSize !== DEFAULT_TERMINAL_FONT_SIZE)} onReset={resetTerminalSize} />}
            >
              <div className="flex items-center gap-3">
                <Slider data-setting-id={appearanceSettings.fontTerminalSizeLabel.id}
                  min={APPEARANCE_LIMITS.terminalSize.min}
                  max={APPEARANCE_LIMITS.terminalSize.max}
                  step={1}
                  value={[terminalSize]}
                  onValueChange={([next]) => {
                    if (typeof next === 'number') setTerminalSize(next);
                  }}
                  aria-label={t('settings.appearance.font.terminalSize.aria')}
                />
                <SettingsTextInput data-setting-id={appearanceSettings.fontTerminalSizeLabel.id}
                  type="number"
                  aria-label={t(appearanceSettings.fontTerminalSizeLabel.titleKey)}
                  min={APPEARANCE_LIMITS.terminalSize.min}
                  max={APPEARANCE_LIMITS.terminalSize.max}
                  step={1}
                  value={terminalSizeInput}
                  onChange={setTerminalSizeInput}
                  onBlur={commitTerminalSizeInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitTerminalSizeInput();
                      e.currentTarget.blur();
                    }
                  }}
                  size="md"
                  mono
                  className="w-[72px] shrink-0"
                  inputClassName="px-3 text-right"
                />
              </div>
            </SettingsField>
          </SettingsCard>
        </SettingsSection>

        {/* Sidebar view modes — 置顶段(三态) / 主列表(两态)分离(sidebar-redesign B 期)。
          独立卡片，沿用 NotificationSection 的 label+hint+Switch 行模式。 */}
        <SettingsSection
          id={appearanceSettings.sidebar.targetId}
          headingLevel={3}
          title={t(appearanceSettings.sidebar.titleKey)}
          aria-label={t(appearanceSettings.sidebar.titleKey)}
        >
          <SettingsCard>
            <SettingsRow
              className="cindy-segmented-row"
              title={<span id={appearanceSettings.sidebarCardModeLabel.targetId}>{t(appearanceSettings.sidebarCardModeLabel.titleKey)}</span>}
              hint={t(appearanceSettings.sidebarCardModeLabel.descriptionKey)}
              trailing={
                <SegmentedControl data-setting-id={appearanceSettings.sidebarCardModeLabel.id}
                  aria-label={t('settings.appearance.sidebarCardMode.aria')}
                  value={sidebarViewMode}
                  onValueChange={setSidebarViewMode}
                  options={appearanceSettings.sidebarCardModeLabel.options.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
                />
              }
            />

            <SettingsRow
              className="cindy-segmented-row"
              title={<span id={appearanceSettings.sidebarMainListModeLabel.targetId}>{t(appearanceSettings.sidebarMainListModeLabel.titleKey)}</span>}
              hint={t(appearanceSettings.sidebarMainListModeLabel.descriptionKey)}
              trailing={
                <SegmentedControl data-setting-id={appearanceSettings.sidebarMainListModeLabel.id}
                  aria-label={t('settings.appearance.sidebarMainListMode.aria')}
                  value={sidebarMainViewMode}
                  onValueChange={setSidebarMainViewMode}
                  options={appearanceSettings.sidebarMainListModeLabel.options.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
                />
              }
            />

            <LayoutResetControl />
          </SettingsCard>
        </SettingsSection>
      </div>
    </div>
  );
}
