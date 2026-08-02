import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile session header desktop-first surface', () => {
  it('releases the new-session handoff heavy topic when the session screen unmounts', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toMatch(
      /unsubscribe\(`session:\$\{sessionId\}`, deviceId, \['sessions', `session:\$\{sessionId\}`\]\)/,
    );
  });

  it('keeps queue state as an icon attention signal instead of extra mobile-only counters', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).not.toContain('sessionHeaderActionBadge');
    expect(source).not.toContain('sessionHeaderIconBadge');
    expect(source).not.toContain('sessionHeaderIconBadgeText');
    expect(source).not.toContain('badge={');
    expect(source).not.toContain("if (queueCount > 0) return `队列 ${queueCount}`;");
    expect(source).toContain("if (!session) return syncing ? i18n.t('session.screen.syncingSession') : null;\n  if (syncing) return i18n.t('session.screen.syncing');");
    // 后台静默刷新:同步提示由 showSyncingIndicator gate —— 仅首次加载、还没有任何内容时显示,
    // 已有 messages(重开已看过的会话)时后台对账静默,不再弹"正在同步"。
    expect(source).toContain('const showSyncingIndicator = loading && messages.length === 0;');
    expect(source).toContain("if (queuePaused) return i18n.t('session.screen.queuePausedNotice');\n  return null;");
    expect(source).toContain('attention ? (');
  });

  it('keeps the visible header chrome compact while preserving full settings access', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 返回自愈:canGoBack 与真实栈不一致(reload 恢复深路由 / 重复压栈残留)时 GO_BACK
    // 会被静默吞掉,收敛到 useGuardedBack(back 后校验 pathname,没走成 replace 兜底)。
    expect(source).toContain('const goBackToHome = useGuardedBack();');
    expect(source).toContain("import { useGuardedBack } from '@/utils/useGuardedBack';");
    expect(source).toContain('onBack={goBackToHome}');
    expect(source).toContain('<Icon color={color} size={iconSize.action} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('testID="session.controlsToggle"');
    expect(source).toContain('const insets = useSafeAreaInsets();');
    expect(source).toContain('<View style={styles.safeArea} testID="session.screen">');
    expect(source).not.toContain('<SafeAreaView style={styles.safeArea} testID="session.screen">');
    expect(source).not.toContain("import { BlurView } from 'expo-blur';");
    expect(source).toContain("import { BlurBackdrop } from '@/session/BlurBackdrop';");
    expect(source).toContain("function TranslucentBackdrop()");
    expect(source).toContain("<TranslucentBackdrop />");
    expect(source).toContain('return <BlurBackdrop intensity={40} overlayColor={colors.chatHeaderSurface} style={styles.translucentBackdrop} />;');
    expect(source).toContain('<View onLayout={handleTopOverlayLayout} pointerEvents="box-none" style={styles.sessionChrome} testID="session.chrome">');
    expect(source).toContain('<View style={[styles.sessionChromeContent, { paddingTop: insets.top }]}>');
    expect(source).toContain("sessionChrome: {\n    left: 0,\n    overflow: 'hidden',\n    position: 'absolute',");
    expect(source).toContain('sessionChromeContent: {');
    expect(source).not.toContain("colors.glassTint");
    expect(source).not.toContain("colors.glassHighlight");
    expect(source).toContain("sessionHeaderBar: {\n    alignItems: 'center',\n    backgroundColor: 'transparent'");
    expect(source).toContain("borderBottomColor: colors.chatHeaderDivider");
    expect(source).toContain('minHeight: 50');
    expect(source).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(source).toContain('<ScreenBackButton');
    expect(source).toContain('testID="session.backButton"');
    expect(source).toContain("sessionHeaderBackButton: {\n    flexShrink: 0,\n  }");
    expect(source).toContain("sessionHeaderIconButton: {\n    alignItems: 'center',\n    borderRadius: radius.pill,\n    height: 38,");
    expect(source).toContain('fontWeight: fontWeight.medium');
    expect(source).not.toContain('size={20} strokeWidth={2}');
    expect(source).not.toContain('minHeight: 54');
  });

  it('switches the leading control to the session-list hamburger on wide-screen navigation', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 宽屏(iPad / 折叠屏展开 / 横屏手机)导航形态:断点判定走 wideSessionNav 纯函数,
    // 左上角三条杠替代返回,抽屉原地 replace 切任务;窄屏保持 ScreenBackButton(上一用例已锁)。
    expect(source).toContain("import { buildWideSessionNavLayout } from '@/session/wideSessionNav';");
    expect(source).toContain("import { SessionListDrawer } from '@/session/SessionListDrawer';");
    // 按平台分闸(发布策略):iOS 只发 iPad,iPhone 横屏也保持返回键;安卓纯宽度闸。
    expect(source).toContain('iosPad: Platform.OS === \'ios\' && Platform.isPad,');
    expect(source).toContain('platform: Platform.OS,');
    expect(source).toContain('onOpenSessionList={wideSessionNav.enabled ? openSessionListDrawer : undefined}');
    expect(source).toContain('icon={Menu}');
    expect(source).toContain('testID="session.sessionListButton"');
    expect(source).toContain('{onOpenSessionList ? (');
    // 抽屉切任务是「原地切换」:replace 保持导航栈 [主页, 会话],不逐层压栈。
    expect(source).toContain("pathname: '/sessions/[sessionId]'");
    expect(source).toContain('const handleDrawerSelectSession = useCallback((item: RemoteSessionListItem) => {');
    expect(source).toContain('router.replace({');
    // 旋转 / 分屏收窄回窄屏时抽屉必须自动收起(没有入口的悬空 overlay)。
    expect(source).toContain('if (!wideSessionNav.enabled) setSessionListDrawerOpen(false);');
    // 打开抽屉先收键盘(树内 overlay 盖不住键盘)。
    expect(source).toContain('Keyboard.dismiss();\n    setSessionListDrawerOpen(true);');
    // 读屏模态语义双平台配对:iOS accessibilityElementsHidden + Android importantForAccessibility
    // (accessibilityViewIsModal 只对 iOS 生效,安卓优先发布不能漏 TalkBack)。
    expect(source).toContain('accessibilityElementsHidden={sessionListDrawerOpen}');
    expect(source).toContain("importantForAccessibility={sessionListDrawerOpen ? 'no-hide-descendants' : 'auto'}");
    // 选任务失败路径:校验先于关闭动画——先关再弹 Alert 会让焦点归还抢走弹窗焦点。
    expect(source).toContain("Alert.alert(t('devices.list.error.sessionDeviceNotFound'));\n      return;\n    }\n    setSessionListDrawerOpen(false);");
  });

  it('keeps pending history access as a lightweight control without message counters', () => {
    const source = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const start = source.indexOf('function MessageHistoryToggle');
    const end = source.indexOf('function readRouteParam', start);
    const toggleSource = source.slice(start, end);

    expect(toggleSource).toContain("expanded ? t('session.screen.collapseHistory') : t('session.screen.expandHistory')");
    expect(source).toContain('borderRadius: radius.pill');
    expect(toggleSource).not.toContain('messageCount');
    expect(toggleSource).not.toContain('历史消息已展开');
    expect(toggleSource).not.toContain('历史消息已折叠');
    expect(toggleSource).not.toContain('当前先处理上方请求');
    expect(toggleSource).not.toContain('条消息');
  });
});
