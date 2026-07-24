import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { palettes, type ThemeColors, type ThemeMode } from './tokens';

interface ThemeValue {
  mode: ThemeMode;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeValue>({ mode: 'light', colors: palettes.light });

/**
 * 跟随系统 light / dark,向下提供当前主题色板。挂在 SafeAreaProvider 内、其它业务 Provider 之上。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const mode: ThemeMode = scheme === 'dark' ? 'dark' : 'light';
  const value = useMemo<ThemeValue>(() => ({ mode, colors: palettes[mode] }), [mode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** 读取当前主题(mode + 色板)。用于 JSX 内联色:lucide `color=`、ActivityIndicator、placeholderTextColor 等。 */
export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/**
 * 子树级主题覆盖。为「登录首启亮色门」(DESIGN.md §16.5 主题跟随:首次打开
 * Cindy → 亮色登录;第二次起跟随)提供作用域强制 mode 的通道——只覆盖包裹的
 * 子树(登录界面),不影响全局 ThemeProvider 与其它界面。mode 传 null 时透传
 * 外层主题(等价不覆盖)。
 */
export function ThemeOverrideProvider({
  mode,
  children,
}: {
  mode: ThemeMode | null;
  children: ReactNode;
}) {
  const parent = useContext(ThemeContext);
  const value = useMemo<ThemeValue>(
    () => (mode == null ? parent : { mode, colors: palettes[mode] }),
    [mode, parent],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

type StyleFactory<T> = (colors: ThemeColors) => T;

/**
 * 按 scheme 记忆化的 StyleSheet 工厂缓存。
 *
 * 模块级 `WeakMap<makeStyles, { light?, dark? }>` 保证每个 `makeStyles` 工厂**每种模式只编译一次** sheet
 * (整个 app 生命周期),组件 re-render 只做缓存查找——热路径(MessageRenderer 每条消息渲染、长列表)
 * 零 StyleSheet 分配。WeakMap 让热重载 / 卸载模块的工厂可被 GC。
 */
const sheetCache = new WeakMap<StyleFactory<unknown>, Partial<Record<ThemeMode, unknown>>>();

/**
 * 把"随主题变化的 StyleSheet"接入组件。
 *
 * @param make 一个 `(colors) => StyleSheet.create({...})` 工厂。
 *   ⚠️ **必须是模块级常量**(身份稳定),不要在组件体内内联定义——否则 WeakMap 缓存每次都 miss,
 *   退化成每帧新建 sheet,拖垮热路径。
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(make: StyleFactory<T>): T {
  const { mode, colors } = useTheme();
  return useMemo(() => {
    const factory = make as StyleFactory<unknown>;
    let byMode = sheetCache.get(factory);
    if (!byMode) {
      byMode = {};
      sheetCache.set(factory, byMode);
    }
    if (!byMode[mode]) {
      byMode[mode] = StyleSheet.create(make(colors));
    }
    return byMode[mode] as T;
  }, [make, mode, colors]);
}
