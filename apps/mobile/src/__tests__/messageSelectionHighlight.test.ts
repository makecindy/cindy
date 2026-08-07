import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 病因留档(PR #1427):消息正文的选中高亮曾逐 view 覆写 selectionColor ——
 * 先是 surfaceChip(不透明近白,浅色主题下选区对底色仅 1.04:1,选了看不见);
 * 改稿换 inputCaret(不透明品牌蓝,选中文字对比度跌到 2.6:1,看得见但读不了)。
 * 不透明覆写两头都讨不到好,而 Android 不传 selectionColor 时回落 Activity 主题的
 * textColorHighlight(accent 色 ~26% 透明度的半透明 tint),选区可见性与文字可读性
 * 天然兼得,与 iOS 路径(UITextView 用系统高亮)同构。
 *
 * 结论:消息渲染器一律不覆写 selectionColor,选中高亮交还系统。本守卫锁住该决定;
 * 若未来要品牌化选中色,正路是原生主题层设 accent(会改 fingerprint、走冷更门),
 * 不是回到逐 view 覆写。composer 输入框的 TextInput selectionColor(光标/手柄)
 * 是另一语义,不受本守卫约束。
 */
describe('mobile message text selection highlight', () => {
  it('never overrides the platform selection highlight in the message renderer', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    expect(source).not.toMatch(/selectionColor=/);
  });
});
