import { Component, type ReactNode } from 'react';
import { Alert, Appearance, Pressable, StyleSheet, View } from 'react-native';
import * as Updates from 'expo-updates';

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

import { Text } from '@/components/AppText';
import { darkColors, fontWeight, lightColors, radius, spacing, typeScale, type ThemeColors } from '@/theme/tokens';
import { i18n } from '@/i18n';
import { getCrashLogFile, hasCrashLog, recordReactError } from '@/debug/crashCapture';

/**
 * 最外层 ErrorBoundary:捕获渲染期错误,写进崩溃日志并渲染极简兜底屏(取代白屏),
 * 让用户就地导出日志 / 重载 App。
 *
 * 关键拓扑:本 boundary 必须挂在所有 Provider(Theme / Locale / Handoff)与启动
 * splash 覆盖层「之上」——目标正是「一开即退 / 启动白屏」,而这类错误往往发生在
 * Provider 或闸门层;若 boundary 在它们之内,①祖先(Provider/overlay 自身)的渲染
 * 错误抓不到,②即便抓到,常驻 splash 覆盖层(zIndex 1000)仍会盖住 fallback、用户
 * 点不到按钮。因此 fallback 刻意「自包含」:不依赖任何 Provider——配色用 Appearance
 * 直读系统深浅色 + tokens 调色板,文案用 i18n.t(import '@/i18n' 时已同步 init)。
 */

interface CrashBoundaryProps {
  children: ReactNode;
}

interface CrashBoundaryState {
  // 独立的布尔标志,而非「error 是否真值」:JS 允许 throw 任意值,抛出 null / 0 / '' 等
  // 假值时 error 仍为假,若据此判断兜底就不会触发、反而重挂崩溃子树。caught 保留原始值(unknown)。
  hasError: boolean;
  caught: unknown;
}

export class CrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  state: CrashBoundaryState = { hasError: false, caught: undefined };

  static getDerivedStateFromError(error: unknown): CrashBoundaryState {
    return { hasError: true, caught: error };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    recordReactError(error, info.componentStack ?? undefined);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, caught: undefined });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return <CrashFallback error={this.state.caught} onReset={this.handleReset} />;
    }
    return this.props.children;
  }
}

/** 从任意 throw 值取一段可展示的文本(可能不是 Error 实例)。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

async function exportLog(): Promise<void> {
  if (!hasCrashLog()) {
    Alert.alert(i18n.t('shared.crashScreen.emptyTitle'), i18n.t('shared.crashScreen.emptyBody'));
    return;
  }
  try {
    // 动态 import:expo-sharing 顶层 requireNativeModule('ExpoSharing'),旧 dev client
    // 缺原生模块时顶层 import 会炸整个 bundle。本组件挂在根部,静态 import 会让崩溃兜底
    // 自身变成全局崩溃源,尤其要走动态 import。
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert(i18n.t('shared.crashScreen.shareUnavailableTitle'), i18n.t('shared.crashScreen.shareUnavailableBody'));
      return;
    }
    await Sharing.shareAsync(getCrashLogFile().uri, {
      mimeType: 'text/plain',
      dialogTitle: i18n.t('shared.crashScreen.exportLog'),
    });
  } catch {
    Alert.alert(i18n.t('shared.crashScreen.shareUnavailableTitle'), i18n.t('shared.crashScreen.shareUnavailableBody'));
  }
}

// 不依赖 ThemeProvider:直读系统深浅色。崩溃兜底是静态一屏,不监听主题实时切换。
function CrashFallback({ error, onReset }: { error: unknown; onReset: () => void }): ReactNode {
  const colors: ThemeColors = Appearance.getColorScheme() === 'dark' ? darkColors : lightColors;
  const styles = makeStyles(colors);

  const reload = async (): Promise<void> => {
    try {
      await Updates.reloadAsync();
    } catch {
      // reloadAsync 在部分环境(dev / Expo Go)不可用:退回清空错误态重挂业务树。
      onReset();
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>{i18n.t('shared.crashScreen.title')}</Text>
      <Text style={styles.body}>{i18n.t('shared.crashScreen.body')}</Text>
      <Text style={styles.detail} numberOfLines={3}>
        {redactSensitiveText(messageOf(error))}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => void exportLog()}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        <Text style={styles.primaryLabel}>{i18n.t('shared.crashScreen.exportLog')}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => void reload()}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
      >
        <Text style={styles.secondaryLabel}>{i18n.t('shared.crashScreen.reload')}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      flex: 1,
      gap: spacing.sm,
      justifyContent: 'center',
      padding: spacing.xl,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.medium,
      textAlign: 'center',
    },
    body: {
      color: colors.textSecondary,
      fontSize: typeScale.body,
      textAlign: 'center',
    },
    detail: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      marginTop: spacing.xs,
      textAlign: 'center',
    },
    primaryButton: {
      backgroundColor: colors.textPrimary,
      // 单行交互按钮用 pill 几何(设计规范:8px control radius 仅用于不能做 pill 的内联控件)。
      borderRadius: radius.pill,
      marginTop: spacing.lg,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.sm,
    },
    primaryLabel: {
      color: colors.surface,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    secondaryButton: {
      borderRadius: radius.pill,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.sm,
    },
    secondaryLabel: {
      color: colors.textSecondary,
      fontSize: typeScale.body,
    },
    pressed: {
      opacity: 0.7,
    },
  });
