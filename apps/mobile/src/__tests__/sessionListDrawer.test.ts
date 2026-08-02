import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

/**
 * 宽屏任务列表抽屉的设计与行为门(与 sessionHeaderDesktopFirst 同款源码字符串门):
 * 本仓 mobile 测试体系是纯函数 + 源码门,没有组件渲染设施,关键交互约定用字符串锁住。
 */
describe('mobile session list drawer', () => {
  const source = () =>
    readTextLf(resolve(process.cwd(), 'src/session/SessionListDrawer.tsx'), 'utf8');

  it('keeps the drawer on design-system tokens with zero shadows and binary radii', () => {
    const text = source();
    // 零阴影 + 无硬编码色(dark 模式红线);圆角只允许 token(pill / container)。
    expect(text).not.toMatch(/shadow[A-Z]/);
    expect(text).not.toContain('elevation:');
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(text).not.toMatch(/borderRadius:\s*\d/);
    expect(text).toContain('borderRadius: radius.pill');
    expect(text).toContain('borderRadius: radius.container');
    // 主题接入模式:模块级 makeStyles + useThemedStyles,不用静态色。
    expect(text).toContain('const makeStyles = (colors: ThemeColors) =>');
    expect(text).toContain('useThemedStyles(makeStyles)');
  });

  it('respects the reduce-motion convention (only animate when explicitly false)', () => {
    const text = source();
    expect(text).toContain("import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';");
    expect(text).toContain('reduceMotion === false');
  });

  it('drives all motion through the shared motion tokens (no hardcoded durations)', () => {
    const text = source();
    // 动效全走 motionDuration/motionEasing 档位(review #1328):入场 enter+out、
    // 退场 exit+in、回弹 fast+move、spinner 走 spinnerCycle 语义例外档。
    expect(text).toContain('duration: motionDuration.enter');
    expect(text).toContain('duration: motionDuration.exit');
    expect(text).toContain('duration: motionDuration.fast');
    expect(text).toContain('duration: motionDuration.spinnerCycle');
    expect(text).toContain('Easing.bezier(...motionEasing.out)');
    expect(text).toContain('Easing.bezier(...motionEasing.in)');
    expect(text).toContain('Easing.bezier(...motionEasing.move)');
    expect(text).not.toMatch(/duration:\s*\d/);
  });

  it('closes on Android hardware back and folds drag offset into the timing animation', () => {
    const text = source();
    expect(text).toContain("BackHandler.addEventListener('hardwareBackPress', () => {");
    // 多处除以 panelWidth,宽度必须有正下限(除零保险,不寄托在调用方身上)。
    expect(text).toContain('Math.max(1, width + insets.left)');
    // 手势位移并回 progress:关闭动画从当前视觉位置继续,不跳帧。
    expect(text).toContain('progress.value + dragX.value / panelWidth');
    // 拖拽关闭只认「向左」意图:右拖 16pt 判失败,纵向 16pt 先到滚动优先(review #1328)。
    expect(text).toContain('.activeOffsetX(-16)');
    expect(text).toContain('.failOffsetX(16)');
    expect(text).toContain('.failOffsetY([-16, 16])');
    // 关闭动画期间 overlay 恒拦截,不放行点击穿透半透明 scrim(review #1328)。
    expect(text).toContain('pointerEvents="auto"');
    // 抽屉 presentation 必须带权威设备身份,防 canonicalDeviceId 被弱推断覆盖(review #1328)。
    expect(text).toContain('devices: remoteSessionStore.getDeviceIdentity(),');
    // 行内状态与标题兜底与首页同口径:pending/liveActivity 索引 + 已解析 unnamedLabel(review #1328)。
    expect(text).toContain('remoteSessionStore.getPendingInteractions(session.id).length');
    expect(text).toContain('remoteSessionStore.getSessionLiveActivity(session.id)');
    expect(text).toContain("unnamedLabel: t('session.menu.unnamedTitle')");
    // 底部主操作行触控目标 >=44。
    expect(text).toContain('minHeight: 44,');
  });

  it('keeps the drawer aligned with the home list presentation pipeline', () => {
    const text = source();
    // 与首页同一套共享层口径:排序 / 置顶 / 自动化折叠 / Orca worker 过滤 / 右槽状态档位。
    expect(text).toContain('excludeOrcaWorkerSessions(sessions)');
    expect(text).toContain('buildMobileHomePresentation({');
    expect(text).toContain('buildHomeSections(home, false, false)');
    expect(text).toContain('resolveMobileSessionRightStatus({');
    expect(text).toContain('buildRemoteSessionCardPreview(item, { running })');
    expect(text).toContain('formatRemoteSessionSidebarTime(lastActivityAt)');
  });

  it('exposes stable testIDs and modal accessibility semantics', () => {
    const text = source();
    for (const testId of [
      'sessionDrawer.overlay',
      'sessionDrawer.scrim',
      'sessionDrawer.panel',
      'sessionDrawer.newSession',
      'sessionDrawer.home',
    ]) {
      expect(text).toContain(`testID="${testId}"`);
    }
    expect(text).toContain('accessibilityViewIsModal={open}');
    expect(text).toContain("t('home.drawer.closeA11y')");
    // 读屏焦点管理(review #1328):打开移焦到面板首控件,关闭归还三条杠;
    // 导航型关闭(本屏已失焦)不归还,不抢新屏焦点。
    expect(text).toContain('AccessibilityInfo.setAccessibilityFocus(node)');
    expect(text).toContain('AccessibilityInfo.setAccessibilityFocus(returnNode)');
    expect(text).toContain('ref={newSessionButtonRef}');
    expect(text).toContain('if (!navigation.isFocused()) return;');
  });
});
