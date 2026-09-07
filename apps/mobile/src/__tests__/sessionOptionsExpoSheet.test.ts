import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * iOS 左滑「选项」Sheet 的关闭时序(回归锚点):
 * 删除 / 重命名的后续弹窗都挂在 onClosed 上等 Sheet 真正卸载后再 present。
 * `@expo/ui` 通用 BottomSheet 的 onDismiss 只在**用户**下拉 / 点背板时触发
 * (原生只在 isPresented 状态与 props 不一致时派发 onIsPresentedChange);
 * 点菜单项后由 JS 把 isPresented 置 false 属于程序化关闭,不会回调,
 * pendingSheetActionRef 里的删除确认永远不弹——用户看到「删除按钮没反应」。
 * 因此 iOS 路径必须直接用 swift-ui BottomSheet 的 onDismiss(SwiftUI
 * `.sheet(onDismiss:)`,两种关闭方式都触发)来驱动 onClosed。
 */
describe('SessionOptionsExpoSheet dismiss lifecycle', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/session/SessionOptionsExpoSheet.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('uses the swift-ui BottomSheet whose onDismiss also fires for programmatic close', () => {
    expect(source).toContain("from \"@expo/ui/swift-ui\"");
    expect(source).not.toMatch(/import \{[^}]*\bBottomSheet\b[^}]*\} from "@expo\/ui";/);
  });

  it('drives onClosed from onDismiss (fully dismissed), not from onIsPresentedChange', () => {
    const sheetStart = source.indexOf('<BottomSheet');
    const sheetEnd = source.indexOf('<Group', sheetStart);
    const sheetProps = source.slice(sheetStart, sheetEnd);
    expect(sheetProps).toMatch(/onDismiss=\{[\s\S]*onClosed\?\.\(\)/);
    expect(sheetProps).not.toMatch(/onIsPresentedChange=\{[\s\S]*onClosed/);
  });
});
