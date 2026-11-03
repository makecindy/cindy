/**
 * 测试价值
 * - 生产入口与可观察结果:页签拖拽落点的纯判定(computeChatEdgeZones / pickTabDropZone);
 *   可观察的是聊天区四条边带的位置与厚度、源组所在边不成为落点、角落按先到先得归左右边、
 *   边带外返回 null。亮区与提交共用同一判定,所见即所得。
 * - Bug / 规则依据:页签可拖到聊天区任一边(页签组模型);边带太薄抓不住、太厚会盖住聊天正文。
 * - 现有覆盖缺口:新模块。
 * - 最小失败输入:一个 1000×800 的聊天区矩形。
 * - tier:unit。
 */

import { describe, expect, it } from 'vitest';

import {
  computeChatEdgeZones,
  isPointerOutsideWindow,
  pickTabDropZone,
} from '../TabDragController';

describe('computeChatEdgeZones / pickTabDropZone', () => {
  const chat = { left: 100, top: 50, width: 1000, height: 800 };

  it('四条边带厚度取短边 22% 并夹到 [72,180];排除源组所在的边', () => {
    const zones = computeChatEdgeZones(chat, new Set(['right']));
    expect(zones.map((z) => z.group)).toEqual(['left', 'top', 'bottom']);
    const left = zones.find((z) => z.group === 'left')!.rect;
    expect(left).toEqual({ left: 100, top: 50, width: 176, height: 800 });
    const bottom = zones.find((z) => z.group === 'bottom')!.rect;
    expect(bottom).toEqual({ left: 100, top: 674, width: 1000, height: 176 });

    const tiny = computeChatEdgeZones({ left: 0, top: 0, width: 200, height: 200 });
    expect(tiny[0].rect.width).toBe(72);
    expect(computeChatEdgeZones({ left: 0, top: 0, width: 0, height: 0 })).toEqual([]);
  });

  it('命中按先到先得:角落归左右边;边带外与无落点返回 null', () => {
    const zones = computeChatEdgeZones(chat);
    expect(pickTabDropZone(150, 60, zones)?.group).toBe('left');
    expect(pickTabDropZone(600, 60, zones)?.group).toBe('top');
    expect(pickTabDropZone(1090, 840, zones)?.group).toBe('right');
    expect(pickTabDropZone(600, 400, zones)).toBeNull();
    expect(pickTabDropZone(600, 400, [])).toBeNull();
  });

  it('窗外判定:可视区外(含右 / 下边界本身)为真,区内为假', () => {
    expect(isPointerOutsideWindow(-1, 10, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(10, -1, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(800, 10, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(10, 600, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(0, 0, 800, 600)).toBe(false);
    expect(isPointerOutsideWindow(799, 599, 800, 600)).toBe(false);
  });
});
