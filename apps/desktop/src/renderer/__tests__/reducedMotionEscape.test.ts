/**
 * reducedMotionEscape.test.ts
 * ---------------------------------------------------------------------------
 * 减弱动效(prefers-reduced-motion)覆盖面的契约测试。
 *
 * 背景:globals.css 的 reduce 块曾只匹配 [class*='animate-spinner'],而字符串
 * "animate-spin" 不含 "animate-spinner" —— 37 处 Tailwind 裸 animate-spin 全部
 * 逃逸,其中十余处连组件级 motion-reduce:animate-none 兜底都没有,减弱动效下
 * 照转(无障碍缺陷)。修复是把选择器放宽为 [class*='animate-spin'](它是
 * spinner 的子串,一条覆盖两者)。本测试钉住修复,防止选择器回退。
 *
 * 降级策略分型(DESIGN.md §14.4 红线的补充,踩坑规则):
 *   - infinite 循环动画(spin / pulse / shimmer)→ animation: none 安全;
 *   - 带 forwards / both 的一次性入场动画 → 只能时长归零,不得 animation: none
 *     (否则元素停在 0% 帧的 opacity:0 直接消失)。本仓通过 motion token 归零
 *     实现(reduce 块把 --motion-* 全档置 0ms),测试同时钉住这条路径。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
  'utf8',
);
const sessionViewSource = readFileSync(
  fileURLToPath(
    new URL('../features/cc-agent/CCAgentSessionView.tsx', import.meta.url),
  ),
  'utf8',
);

/** 提取 @media (prefers-reduced-motion: reduce) 的所有块体(brace 平衡扫描)。 */
function collectReducedMotionBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    blocks.push(source.slice(re.lastIndex, i - 1));
  }
  return blocks;
}

const reduceBlocks = collectReducedMotionBlocks(css);
const reduceCss = reduceBlocks.join('\n');

describe('prefers-reduced-motion 覆盖面(globals.css)', () => {
  it('扫描逻辑确实抓到了 reduce 块(防正则失效空跑)', () => {
    expect(reduceBlocks.length).toBeGreaterThan(0);
    expect(reduceCss).toContain('animation: none');
  });

  it("匹配 Tailwind spinner 的选择器必须是 [class*='animate-spin'](spinner 的子串,一条覆盖两者)", () => {
    // 'animate-spin' 是 'animate-spinner' 的子串:这一条同时命中裸 animate-spin
    // 与自定义 animate-spinner(含 motion-safe: 变体的转义类名)。
    expect(reduceCss).toContain("[class*='animate-spin']");
  });

  it("不得回退成只匹配 [class*='animate-spinner'](animate-spin 会逃逸)", () => {
    // 匹配到 'animate-spinner' 说明有人把选择器改窄了;宽选择器已覆盖它,
    // 单独出现即是回退信号。
    expect(reduceCss).not.toContain("[class*='animate-spinner']");
  });

  it('motion token 全档在 reduce 块里归零(变体形态的 animate-* 靠它失效)', () => {
    for (const token of [
      '--motion-instant',
      '--motion-fast',
      '--motion-base',
      '--motion-enter',
      '--motion-exit',
      '--motion-spinner-cycle',
    ]) {
      expect(reduceCss, `reduce 块缺少 ${token} 归零`).toMatch(
        new RegExp(`${token}:\\s*0ms`),
      );
    }
  });

  it('带 forwards/both 的一次性动画不得被 animation: none 整类扑杀(会停在 opacity:0)', () => {
    // reduce 块允许 animation: none 的只有循环装饰类;一次性 confirm 类走
    // duration 归零。这里钉住 confirm 类的降级方式不被改成 none。
    expect(reduceCss).toMatch(
      /\.animate-confirm-overlay-in[\s\S]*?animation-duration:\s*0ms\s*!important/,
    );
  });
});

describe('RunningStatusBar cadenced shimmer 的运行期 reduced-motion 切换', () => {
  it('动画被摘时清空 playing/pending，并把 reducedMotion 纳入 effect 依赖', () => {
    expect(sessionViewSource).toContain("import { useReducedMotion } from '@/hooks/useReducedMotion'");
    expect(sessionViewSource).toContain('const reducedMotion = useReducedMotion();');
    expect(sessionViewSource).toContain('if (!visible || suppressContent || reducedMotion) {');
    expect(sessionViewSource).toContain('shimmerPlayingRef.current = false;');
    expect(sessionViewSource).toContain('shimmerPendingRef.current = false;');
    expect(sessionViewSource).toContain(
      '}, [visible, suppressContent, reducedMotion, status, tokenUsage]);',
    );
  });
});
