// @vitest-environment jsdom
/**
 * rasterizeToImage — 导出倍率收敛与 SVG 固有尺寸解析的单测。
 *
 * 这两段纯计算是「复制为图片」大图内存保护的核心(默认 4096 边长 + 4096²
 * 输出像素预算);canvas / clipboard 等浏览器 API 行为不在 jsdom 里模拟,
 * 由运行时验证覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  EXPORT_MAX_EDGE_PX,
  EXPORT_MAX_OUTPUT_PIXELS,
  EXPORT_PNG_SCALE,
  computeExportScale,
  parseSvgIntrinsicSize,
} from '@/lib/rasterizeToImage';

describe('computeExportScale', () => {
  it('普通尺寸用满目标倍率(默认 3x)', () => {
    expect(computeExportScale(400, 300)).toBe(EXPORT_PNG_SCALE);
  });

  it('大图按 4096 边长收敛倍率', () => {
    // 2048 宽 → 3x 会到 6144,超上限;收敛到 4096/2048 = 2
    expect(computeExportScale(2048, 100)).toBe(2);
    // 以长边为准
    expect(computeExportScale(100, 2048)).toBe(2);
  });

  it('内容本身超过上限时允许任意小的缩小倍率,maxEdge 是硬上限', () => {
    expect(computeExportScale(8192, 100)).toBe(EXPORT_MAX_EDGE_PX / 8192);
    // 超长内容(>40960px)不得为可读性抬倍率突破边长上限(review P1)
    expect(computeExportScale(1_000_000, 100)).toBe(EXPORT_MAX_EDGE_PX / 1_000_000);
    expect(1_000_000 * computeExportScale(1_000_000, 100)).toBeLessThanOrEqual(EXPORT_MAX_EDGE_PX);
  });

  it('非法尺寸回退 1', () => {
    expect(computeExportScale(0, 100)).toBe(1);
    expect(computeExportScale(Number.NaN, 100)).toBe(1);
    expect(computeExportScale(-5, 100)).toBe(1);
  });

  it('自定义目标倍率同样受上限收敛', () => {
    expect(computeExportScale(400, 300, 2)).toBe(2);
    expect(computeExportScale(4000, 300, 2)).toBeCloseTo(4096 / 4000);
  });

  it('自定义长边允许窄长图超过 4096,同时守住同一输出像素预算', () => {
    const width = 800;
    const height = 10_000;
    const scale = computeExportScale(width, height, 2, 16_384, EXPORT_MAX_OUTPUT_PIXELS);

    expect(scale).toBeGreaterThan(1);
    expect(Math.max(width, height) * scale).toBeLessThanOrEqual(16_384);
    expect(width * height * scale * scale).toBeCloseTo(EXPORT_MAX_OUTPUT_PIXELS);
  });
});

describe('parseSvgIntrinsicSize', () => {
  it('viewBox 优先(与显示期 CSS 收缩无关)', () => {
    const svg = '<svg viewBox="0 0 747.75 412.5" width="100" height="50"></svg>';
    expect(parseSvgIntrinsicSize(svg)).toEqual({ width: 747.75, height: 412.5 });
  });

  it('缺 viewBox 回退 width/height 属性(剥单位)', () => {
    const svg = '<svg width="640px" height="480px"></svg>';
    expect(parseSvgIntrinsicSize(svg)).toEqual({ width: 640, height: 480 });
  });

  it('viewBox 支持逗号分隔', () => {
    const svg = '<svg viewBox="0,0,100,200"></svg>';
    expect(parseSvgIntrinsicSize(svg)).toEqual({ width: 100, height: 200 });
  });

  it('无 svg 元素或无可用尺寸返回 null', () => {
    expect(parseSvgIntrinsicSize('<div></div>')).toBeNull();
    expect(parseSvgIntrinsicSize('<svg></svg>')).toBeNull();
    expect(parseSvgIntrinsicSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
  });
});
