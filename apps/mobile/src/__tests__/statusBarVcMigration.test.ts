import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * iOS 状态栏 VC-based 迁移的源码合同测试(PR #1129)。
 *
 * 背景:Info.plist 的 UIViewControllerBasedStatusBarAppearance=YES 后
 * (见 nativeAppConfig.test.ts 的对应断言),RN StatusBar 的样式/隐藏调用在
 * iOS 上失效并触发 RCTLogError;iOS 改经 react-native-screens 的
 * statusBarStyle / statusBarHidden screen options,Android 保持组件式
 * StatusBar 老链路。这些平台守卫分支散在 4 个文件里,merge conflict 误删
 * 任何一个守卫都不会有类型错误——用源码合同把它们钉住。
 */
const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('status bar VC-based migration source contracts', () => {
  it('_layout.tsx: Android 用组件式 StatusBar,iOS 用 Stack screenOptions statusBarStyle', () => {
    const source = read('app/_layout.tsx');
    // Android-only 组件式 StatusBar(覆盖 Stack 未挂载的启动闸门期)
    expect(source).toContain("{Platform.OS === 'android' ? (");
    expect(source).toContain(
      "style={splashActive || mode === 'dark' ? 'light' : 'dark'}",
    );
    // iOS-only 的 RNS 通道:statusBarStyle 只在 iOS 进 screenOptions
    expect(source).toContain("...(Platform.OS === 'ios'");
    expect(source).toContain(
      "{ statusBarStyle: statusBarTheme === 'dark' ? 'light' : 'dark' }",
    );
    // splash 覆盖期跟舞台有效主题(首启亮色门),释放后跟系统主题
    expect(source).toContain(
      'const statusBarTheme = splashActive ? stageTheme : mode;',
    );
  });

  it('MobileLoginHandoffStage.tsx: 组件式 StatusBar 必须锁在 Android 分支内', () => {
    const source = read('src/components/MobileLoginHandoffStage.tsx');
    expect(source).toContain("{Platform.OS === 'android' ? (");
    expect(source).toContain(
      "<StatusBar style={mode === 'dark' ? 'light' : 'dark'} />",
    );
    // iOS 不得无守卫挂载 expo-status-bar 组件(会触发 RCTLogError):
    // 每个 <StatusBar 出现点都要能配对到 android 守卫。
    const statusBarUses = source.match(/<StatusBar /g) ?? [];
    const androidGuards =
      source.match(/Platform\.OS === 'android' \? \(\s*<StatusBar /g) ?? [];
    expect(statusBarUses.length).toBeGreaterThan(0);
    expect(androidGuards.length).toBe(statusBarUses.length);
  });

  it('ImageLightbox.tsx: iOS 走宿主屏 statusBarHidden option,Android 保留 Modal 内 StatusBar hidden', () => {
    const source = read('src/session/ImageLightbox.tsx');
    // iOS:经 navigation.setOptions 走 VC-based 通道,卸载时恢复
    expect(source).toContain("if (Platform.OS !== 'ios') return;");
    expect(source).toContain(
      'navigation.setOptions({ statusBarHidden: true });',
    );
    expect(source).toContain(
      'navigation.setOptions({ statusBarHidden: false });',
    );
    // Android:组件式 hidden 保持老链路,且必须锁在 android 守卫内
    expect(source).toContain(
      "{Platform.OS === 'android' ? <StatusBar hidden /> : null}",
    );
  });

  it('login.tsx: 登录屏按舞台有效主题在 iOS 设置 statusBarStyle screen option', () => {
    const source = read('app/(auth)/login.tsx');
    // 首启亮色门可强制舞台为 light(系统可能是 dark):样式必须跟舞台而非系统
    expect(source).toContain(
      'resolveStartupSplashHandoff(firstLaunchGate, systemTheme).targetTheme',
    );
    expect(source).toContain("{Platform.OS === 'ios' ? (");
    expect(source).toContain(
      "statusBarStyle: stageTheme === 'dark' ? 'light' : 'dark',",
    );
  });
});
