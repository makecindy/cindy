import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createElement, type ReactNode } from 'react';

import {
  DEFAULT_FAMILY_ID,
  findFamilyByThemeId,
  resolveFamilyVariant,
  tryGetFamily,
} from '../themes/families';
import { onLocalThemesChange } from '../themes/local-themes';
import { presentTheme } from '../appearance/AppearancePresenter';
import type { ThemeType } from '../themes/types';
import { parseThemeSelection, type ThemeSelection } from '../../shared/appearanceDefinition';

export type Theme = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  familyId: string;
  setFamily: (familyId: string) => void;
  /**
   * 当前家族在请求 type 下没变体, 已 fallback 到另一个 type 时, 这里
   * 返回 "请求的 type" (供 UI 显示 "无浅色 / 无深色" 提示)。否则 null。
   */
  fallbackFromType: ThemeType | null;
}

const STORAGE_KEY = 'theme';
const FAMILY_KEY = 'theme.familyId';
const LOGIN_FIRST_LAUNCH_KEY = 'login.firstLaunchLightShown';
// Read-only upgrade sources. New selections are owned by the Host store.
const LEGACY_LIGHT_ID_KEY = 'theme.lightId';
const LEGACY_DARK_ID_KEY = 'theme.darkId';
const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveIsDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  // jsdom 等测试环境可能没有 matchMedia,兜底按 light 解析(不影响真实运行时)
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PREFERS_DARK_QUERY).matches;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
let legacySelection: ThemeSelection | undefined;
let themeMigration: Promise<boolean> | undefined;

function hostSelection(): ThemeSelection | null {
  return parseThemeSelection(window.electronAPI?.appearanceSettings?.getSync?.()?.themeSelection);
}

function readLegacySelectionOnce(): ThemeSelection {
  if (legacySelection) return legacySelection;
  let mode: Theme = 'system', familyId = DEFAULT_FAMILY_ID;
  try {
    const storedMode = localStorage.getItem(STORAGE_KEY);
    if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'system') mode = storedMode;
    const storedFamily = localStorage.getItem(FAMILY_KEY);
    if (storedFamily?.trim() && storedFamily.length <= 512) familyId = storedFamily;
    else familyId = findFamilyByThemeId(localStorage.getItem(LEGACY_DARK_ID_KEY))?.id ??
      findFamilyByThemeId(localStorage.getItem(LEGACY_LIGHT_ID_KEY))?.id ?? DEFAULT_FAMILY_ID;
  } catch { /* Preserve the in-memory choice if renderer storage is unavailable. */ }
  legacySelection = { mode, familyId };
  return legacySelection;
}

/** Called before React's first render. Failure retains old bytes and this session's choice. */
export async function migrateStoredThemeSelection(): Promise<boolean> {
  if (hostSelection()) return true;
  const bridge = window.electronAPI?.appearanceSettings;
  if (!bridge?.migrateTheme) return false;
  themeMigration ??= bridge.migrateTheme(readLegacySelectionOnce()).then(settings => !!parseThemeSelection(settings.themeSelection)).catch(() => {
    window.electronAPI?.logToMain?.('warn', 'renderer/appearance', 'Theme selection migration failed; saved selection retained');
    return false;
  });
  return themeMigration;
}

export function getStoredTheme(): Theme {
  return (hostSelection() ?? readLegacySelectionOnce()).mode;
}

/**
 * 从老的 theme.lightId / theme.darkId 推断 family id。优先级: dark 旧值
 * 的家族 → light 旧值的家族 → null (调用方落到 DEFAULT_FAMILY_ID)。
 * 大部分用户主用深色, 所以 dark 优先。
 */
export function getStoredFamilyId(): string {
  const stored = (hostSelection() ?? readLegacySelectionOnce()).familyId;
  return tryGetFamily(stored) ? stored : DEFAULT_FAMILY_ID;
}

function resolveActiveTheme(mode: Theme) {
  const isDark = resolveIsDark(mode);
  return resolveFamilyVariant(getStoredFamilyId(), isDark ? 'dark' : 'light');
}

function resolveSessionActiveTheme(mode: Theme) {
  return resolveActiveTheme(firstLaunchLightSession === true ? 'light' : mode);
}

function resolveSessionIsDark(mode: Theme): boolean {
  return resolveSessionActiveTheme(mode).theme.type === 'dark';
}

function systemModeFollowsSystem(familyId: string): boolean {
  const family = tryGetFamily(familyId);
  return Boolean(family?.light && family?.dark);
}

// 切主题时临时禁掉所有 transition,避免带 transition-colors 的元素(顶栏图标、
// 设置侧边活动项、Logout 按钮等)慢 150ms 淡到新色,看起来和瞬间换色的其他部分不同步。
// hover/active 等交互态的 transition 不受影响 —— 注入只在切换那一瞬生效,下一帧就移除。
function disableTransitionsTemporarily(): void {
  const style = document.createElement('style');
  style.appendChild(document.createTextNode('*,*::before,*::after{transition:none !important}'));
  document.head.appendChild(style);
  // 强制 reflow,确保 .dark 类切换 + 新计算样式已落盘,再移除禁用样式。
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  window.getComputedStyle(document.body).opacity;
  requestAnimationFrame(() => {
    style.remove();
  });
}

export function applyThemeClass(theme: Theme, force = false): void {
  const root = document.documentElement;
  const wasDark = root.classList.contains('dark');
  // 首启亮色门激活期间(pre-login 会话)一律按亮色解析——ThemeProvider 挂载
  // 重放与系统色变化都不会把登录界面翻回暗色;门由登录页卸载时结束。
  const { theme: nextTheme } = resolveSessionActiveTheme(theme);
  const nextDark = nextTheme.type === 'dark';

  if (!force && nextDark === wasDark && root.dataset.theme === nextTheme.id) {
    return;
  }

  if (nextDark !== wasDark) {
    disableTransitionsTemporarily();
  }

  presentTheme(nextTheme);
}

/** 无 ThemeProvider 的窗口用。 */
export function followLocalThemeChanges(): () => void {
  return onLocalThemesChange(() => applyThemeClass(getStoredTheme(), true));
}

/** index.tsx bootstrap 用 —— 不依赖 React context。首启亮色门在此生效:
 * 真首启(见 initLoginFirstLaunchLightGate)整个 pre-login 会话按亮色解析,
 * 品牌舞台首帧即亮色,无暗→亮闪变。 */
export function getInitialThemeVariant() {
  return resolveActiveTheme(initLoginFirstLaunchLightGate() ? 'light' : getStoredTheme());
}

/**
 * 登录首启亮色门(主题跟随产品逻辑,DESIGN.md §16.5):用户**首次**打开 Cindy
 * → 亮色登录界面(默认);**第二次起** → 跟随用户上一次使用的主题。
 *
 * 会话级判定,首次调用即定型(bootstrap 在任何渲染前调用,品牌舞台首帧就是
 * 亮色——不存在暗→亮闪变):
 *  - 已有标记 → false(第二次起,跟随正常主题解析);
 *  - 无标记且 renderer localStorage 为空且主进程无存量会话(sync 线索,见
 *    decideLoginFirstLaunchLight)→ **真首启**,true 并落盘标记;
 *  - 无标记但已有其它本地状态、或主进程持有存量会话(持久化 refresh token /
 *    local 模式——renderer 存储被清空的已登录用户,认证恢复后直进受保护路由)
 *    → false(绝不能把他们的界面强制成亮色,哪怕一帧),同样落盘标记防复判。
 * 门激活期间 applyThemeClass 全部按亮色解析(含系统色变化重放);登录页卸载
 * 时经 endLoginFirstLaunchLightGate 结束并恢复存储主题。不改用户 theme 偏好。
 */
let firstLaunchLightSession: boolean | null = null;

/**
 * 首启判定核心(纯函数,供单测):三个条件缺一不可——无「已展示」标记、
 * renderer 本地存储全空、主进程无存量会话。第三条堵住 localStorage 被清空
 * 但主进程仍持有会话的误判:那种启动会跳过 LoginPage 直进应用,若激活门,
 * 暗色用户会先看到亮色首帧(修复前甚至因清理路径不触发而整个会话锁亮色)。
 */
export function decideLoginFirstLaunchLight(input: {
  hasShownMarker: boolean;
  rendererStorageEmpty: boolean;
  mainHasPersistedSession: boolean;
}): boolean {
  if (input.hasShownMarker) return false;
  return input.rendererStorageEmpty && !input.mainHasPersistedSession;
}

/** 主进程存量会话线索(preload sendSync 桥)。API 缺失 / 抛错按「无会话」兜底,
 * 行为退化为旧的 localStorage 判定。 */
function mainProcessHasPersistedSession(): boolean {
  try {
    return window.electronAPI?.authHasPersistedSessionHintSync?.() === true;
  } catch {
    return false;
  }
}

/** 判定并激活首启门 —— **只由 bootstrap(getInitialThemeVariant)调用**,任何
 * 渲染前执行一次即定型;组件侧一律走无副作用的 loginFirstLaunchLightActive()
 * 读取(测试挂载组件不会误触发判定/写标记)。 */
function initLoginFirstLaunchLightGate(): boolean {
  if (firstLaunchLightSession !== null) return firstLaunchLightSession;
  try {
    const hasShownMarker = localStorage.getItem(LOGIN_FIRST_LAUNCH_KEY) !== null;
    firstLaunchLightSession = decideLoginFirstLaunchLight({
      hasShownMarker,
      rendererStorageEmpty: localStorage.length === 0 && !hostSelection(),
      mainHasPersistedSession: mainProcessHasPersistedSession(),
    });
    if (!hasShownMarker) {
      localStorage.setItem(LOGIN_FIRST_LAUNCH_KEY, String(Date.now()));
    }
  } catch {
    // localStorage 不可用时不强制亮色,按正常主题解析兜底
    firstLaunchLightSession = false;
  }
  return firstLaunchLightSession;
}

/** 首启亮色门当前是否激活(无副作用读取,供登录页卸载钩子判断)。 */
export function loginFirstLaunchLightActive(): boolean {
  return firstLaunchLightSession === true;
}

/** 结束首启亮色门(登录页卸载 = 登录完成/离开时调用),恢复存储主题解析。 */
export function endLoginFirstLaunchLightGate(): void {
  if (firstLaunchLightSession !== true) return;
  firstLaunchLightSession = false;
  const mode = getStoredTheme();
  const familyId = getStoredFamilyId();
  applyThemeClass(mode, true);
  // 首启门结束不会改变 ThemeProvider 的 React state，因此对应 effect 不会自动重跑。
  // 在这里用恢复后的实际主题立即同步 backing，同时保留用户原始模式供下次冷启动解析。
  window.electronAPI?.theme?.applyVibrancy?.(
    familyId,
    resolveSessionIsDark(mode),
    mode,
    systemModeFollowsSystem(familyId),
    document.documentElement.dataset.wallpaperActive === 'true',
    document.documentElement.dataset.desktopBackground === 'true'
      ? Number(document.documentElement.dataset.desktopBlur ?? 0) : null,
  );
}

export function __resetLoginFirstLaunchLightGateForTest(): void {
  firstLaunchLightSession = null;
  legacySelection = undefined;
  themeMigration = undefined;
}

export function ThemeProvider({
  children,
  syncWindowVibrancy = true,
}: {
  children: ReactNode;
  syncWindowVibrancy?: boolean;
}) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [familyId, setFamilyIdState] = useState<string>(getStoredFamilyId);
  // 跟踪系统色偏好, 让 fallbackFromType 在 OS theme 变化时也能正确刷新。
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia(PREFERS_DARK_QUERY).matches,
  );
  // Invalidate memos that depend on family membership when local themes change.
  // The catalog and Host snapshot are rebuildable projections, never preference owners.
  const [localThemeRev, bumpLocalThemeRev] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onLocalThemesChange(() => {
    setFamilyIdState(getStoredFamilyId());
    bumpLocalThemeRev();
    applyThemeClass(getStoredTheme(), true);
  }), []);

  const requestedSelection = useRef<ThemeSelection | undefined>(undefined);
  const requestSelection = useCallback((patch: Partial<ThemeSelection>) => {
    const bridge = window.electronAPI?.appearanceSettings;
    if (!bridge?.selectTheme) return;
    const next = { ...(requestedSelection.current ?? hostSelection() ?? readLegacySelectionOnce()), ...patch };
    requestedSelection.current = next;
    void bridge.selectTheme(next).catch(() => {
      window.electronAPI?.logToMain?.('warn', 'renderer/appearance', 'Theme selection write failed; saved selection retained');
    }).finally(() => { if (requestedSelection.current === next) requestedSelection.current = undefined; });
  }, []);

  const setTheme = useCallback((next: Theme) => requestSelection({ mode: next }), [requestSelection]);

  const setFamily = useCallback(
    (next: string) => {
      if (!tryGetFamily(next)) return;
      requestSelection({ familyId: next });
    },
    [requestSelection],
  );

  // 初始挂载和宿主 mode 推送都从同一快照应用；相同投影由 dataset 比较短路。
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  useEffect(() => {
    window.electronAPI?.setUpdateRelaunchTheme?.(
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    );
  }, [familyId, systemPrefersDark, theme]);

  // OS 色偏好变化: 在 system 模式下重新 apply, 同时同步 systemPrefersDark
  // 让 fallbackFromType 刷新。非 system 模式只同步 state, 不动 DOM。
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia(PREFERS_DARK_QUERY);
    const handleChange = () => {
      setSystemPrefersDark(mediaQuery.matches);
      if (theme === 'system') {
        applyThemeClass('system');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [theme]);

  // Cross-window synchronization consumes the same Host appearance publication.
  useEffect(() => {
    return window.electronAPI?.appearanceSettings?.onChanged?.(settings => {
      const next = parseThemeSelection(settings.themeSelection);
      if (!next) return;
      setThemeState(next.mode);
      setFamilyIdState(tryGetFamily(next.familyId) ? next.familyId : DEFAULT_FAMILY_ID);
      applyThemeClass(next.mode, true);
    });
  }, []);

  // E4D 毛玻璃(R1 audit,用户裁决透壁纸 2026-07-17):family/theme 变化或 mount 时
  // 通知 main 开关 macOS vibrancy(仅 CINDY family 启用,其他恢复不透明)。覆盖
  // setFamily/宿主跨窗口推送/mount 三个场景(任一变化都重应用)。
  useEffect(() => {
    if (!syncWindowVibrancy) return;
    const root = document.documentElement;
    let lastState: string | undefined;
    const sync = () => {
      // Use the same condition as the opaque wallpaper canvas, including a
      // retained image while its replacement loads and the 0%-visibility veil.
      const covered = root.dataset.wallpaperActive === 'true';
      const desktopBlur = root.dataset.desktopBackground === 'true'
        ? Number(root.dataset.desktopBlur ?? 0) : null;
      const state = `${covered}:${desktopBlur}`;
      if (state === lastState) return;
      lastState = state;
      window.electronAPI?.theme?.applyVibrancy?.(
        familyId,
        resolveSessionIsDark(theme),
        theme,
        systemModeFollowsSystem(familyId),
        covered,
        desktopBlur,
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-wallpaper-active', 'data-desktop-background', 'data-desktop-blur'] });
    return () => observer.disconnect();
  }, [familyId, localThemeRev, syncWindowVibrancy, theme, systemPrefersDark]);

  const fallbackFromType = useMemo<ThemeType | null>(() => {
    void localThemeRev;
    const family = tryGetFamily(familyId);
    if (!family) return null;
    const isDarkRequested = theme === 'dark' || (theme === 'system' && systemPrefersDark);
    const requestedType: ThemeType = isDarkRequested ? 'dark' : 'light';
    return family[requestedType] === null ? requestedType : null;
  }, [familyId, theme, systemPrefersDark, localThemeRev]);

  return createElement(
    ThemeContext.Provider,
    {
      value: {
        theme,
        setTheme,
        familyId,
        setFamily,
        fallbackFromType,
      },
    },
    children,
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
