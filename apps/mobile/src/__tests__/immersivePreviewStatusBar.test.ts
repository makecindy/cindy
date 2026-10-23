import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 沉浸式预览的状态栏合同(源码守护)。
 *
 * 背景:RemoteDesktopHost 的悬浮层在 Stack 之外,层里任何 SwiftUI Host
 * (@expo/ui)都会把一个 UIHostingController 挂成根 VC 的最后一个子 VC;
 * react-native-screens 只看 childViewControllers.lastObject,于是找不到 Stack,
 * 屏幕的 statusBarHidden 整个失效,状态栏盖在灵动岛两侧的按钮上,且 iOS 把状态栏
 * 区域的点击吞掉,返回/键盘/设置点不动。沉浸态的三个按钮因此必须是纯 RN 视图。
 */
const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('immersive preview controls and the status bar', () => {
  it.each([
    'src/remote-desktop/RemoteDesktopImmersiveControls.tsx',
    'src/remote-desktop/ImmersiveGlassSurface.tsx',
    'src/remote-desktop/ImmersiveGlassSurface.ios.tsx',
  ])('%s does not mount a SwiftUI Host', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/@expo\/ui/);
    expect(source).not.toMatch(/<Host\b/);
  });

  it('the screen swaps in the plain controls only for the immersive preview', () => {
    const source = read('src/remote-desktop/RemoteDesktopScreen.tsx');
    expect(source).toContain(
      'immersivePreview ? RemoteDesktopImmersiveToolbar : RemoteDesktopToolbar',
    );
    expect(source).toContain(
      '? RemoteDesktopImmersiveBack\n    : RemoteDesktopBackButton',
    );
  });

  it('the settings sheet Host is mounted in the immersive preview only while it is open', () => {
    const source = read('src/remote-desktop/RemoteDesktopScreen.tsx');
    expect(source).toContain(
      '(operations || (Platform.OS === "ios" && !immersivePreview))',
    );
  });

  it('the route keeps asking for a hidden status bar', () => {
    const source = read('app/devices/desktop/[deviceId].tsx');
    expect(source).toContain('statusBarHidden: true');
  });
});
