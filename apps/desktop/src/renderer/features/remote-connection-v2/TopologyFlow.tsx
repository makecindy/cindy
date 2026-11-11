/**
 * TopologyFlow —— 拓扑线上的「消息在走」(DESIGN.md §14.4「Remote connection message packets」)。
 * ---------------------------------------------------------------------------
 * 用户裁决(2026-11-07):连着是绿色实线;最近几秒有业务收发时,这条绿线变成朝消息方向流动的绿色虚线。
 * 不用光点、不用第二种颜色。做法是在实线上放一排卡片底色的小段,沿线匀速往前走(每秒 SPEED px),
 * 看着就是虚线在流;往哪边流跟消息走,两边都有时往设备流。停了就整层卸载、线回到实线。
 *
 * 性能红线(engineering-conventions §7):小段是 HTML 元素,只动 transform / opacity,走合成线程;
 * 底下的 SVG 线不做动画。同时在动的线最多 MAX_LANES 条;窗口隐藏时整层卸载;
 * 系统减弱动效时、以及刚打开页面图还没稳定时不挂载(调用方判断)。
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { samplePath, speckKeyframes, type LineShape } from './topologyGeometry';
import type { TopologyFlow } from './topologyModel';

/** 同时在动的线最多几条。 */
export const MAX_LANES = 8;
/** 虚线流动的速度(px / 秒),所有线一样快。 */
export const SPEED = 16;
/** 虚线一节(一段实线 + 一个空隙)的长度(px);按线长取整,让空隙刚好均匀排满一条线。 */
export const SPACING = 12;

export interface FlowLine {
  id: string;
  /** 变成流动虚线的那条线 */
  shape: LineShape;
  flow: TopologyFlow;
}

/** 一条线上放几个空隙、走一趟多久。 */
export function streamFor(length: number): { count: number; duration: number } {
  return { count: Math.max(3, Math.round(length / SPACING)), duration: Math.max(1, (length / SPEED) * 1000) };
}

/** 形状按值比较:拓扑每 2 秒重算一次(新对象、同一条线),线没变就不能重启动画。 */
function shapeKey(s: LineShape): string {
  return `${s.a.x},${s.a.y},${s.k.x},${s.k.y},${s.b?.x ?? ''},${s.b?.y ?? ''}`;
}

function Dashes({ shape, reverse }: { shape: LineShape; reverse: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const key = shapeKey(shape);
  const { count } = streamFor(samplePath(shape).length);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const { points, length } = samplePath(shape);
    const { count: n, duration } = streamFor(length);
    const frames = speckKeyframes(points, length, reverse);
    const clocked = typeof document.timeline?.currentTime === 'number';
    const animations: Animation[] = [];
    Array.from(host.children).forEach((el, i) => {
      if (typeof (el as HTMLElement).animate !== 'function') return;
      const a = (el as HTMLElement).animate(frames, { duration, iterations: Infinity, easing: 'linear', iterationStart: i / n });
      // 相位钉在文档时钟上:拓扑重算让这条线重新挂载时,虚线停在原处接着流,不会跳一下。
      if (clocked) a.startTime = 0;
      animations.push(a);
    });
    return () => {
      for (const a of animations) a.cancel();
    };
    // shape 每次渲染都是新对象;按 key(形状)和方向决定是否重启。
  }, [key, reverse, count]);

  return (
    <span ref={ref}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="rcv2-gap" />
      ))}
    </span>
  );
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

/** 一层绝对定位的流动空隙;坐标与 SVG 线同一坐标系(拓扑容器左上角)。 */
export function TopologyFlowLayer({ lines }: { lines: readonly FlowLine[] }) {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
  if (!visible || lines.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {lines.slice(0, MAX_LANES).map((line) => (
        <Dashes key={line.id} shape={line.shape} reverse={line.flow === 'in'} />
      ))}
    </div>
  );
}
