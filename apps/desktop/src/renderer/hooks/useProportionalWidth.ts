import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * 主区域内容宽度 hook
 *
 * 同时返回两个宽度：
 *   messageWidth = min(maxWidth, containerWidth - sidePadding*2)   // 普通模式 50px/侧
 *   inputWidth   = messageWidth + INPUT_OUTSET (输入框每侧少 10px)
 *
 * maxWidth 为内容封顶宽（首参）：容器再宽,内容列也不超过它,超出部分靠 mx-auto
 * 居中留白。不传时回落到 MAX_MESSAGE_WIDTH(1200) 的历史默认。新建对话页与进行中
 * 对话页传同一个值(914),保证发送首条消息时输入框宽度不跳变,同时左右留出呼吸空间。
 *
 * - 消息流侧 (50px)：MessageStream 是 overflow-y-auto 的原生滚动容器,占满
 *   全宽 containerWidth，内部 contentRef `mx-auto` + `maxWidth=messageWidth`
 *   自然得到左右各 50px 的边距 ((containerWidth - messageWidth) / 2 = 50)。
 *   原生 scrollbar 由 globals.css `.is-scrolling` 体系自动隐藏(默认透明,
 *   滚动/hover 时显形,2s 无活动后淡出),布局不受 scrollbar 影响。
 * - 输入框侧 (40px)：overlay 用 left-[40px]/right-[40px]，内层 ChatInput
 *   用 inputWidth 完整填满
 *
 * 关系：inputWidth = messageWidth + 20，即输入框始终比消息流每侧多出 10px
 *   （padding 更小 = 更宽）。容器够宽时两者都封顶，超出部分由 mx-auto
 *   居中留白。
 *
 * compact 模式 (messagePad 50→20 / inputPad 40→10):
 *   - workdir-browse 右侧 chat rail:容器只有 340 宽时,默认 padding 会让
 *     messageWidth 只剩 240(70%);compact 提到 300(88%),视觉舒服得多。
 *   - 主会话:不再依赖宿主显式传 compact 切窄。本 hook 自身按实测容器宽度
 *     `< AUTO_COMPACT_THRESHOLD` 时自动切 compact,与 `opts.compact` 取 OR。
 *     这样右栏打开把主区压窄到阈值之下时,padding 平滑收紧, 既不臃肿也不会
 *     再出现"按 rightSidebarCollapsed 布尔切换"那次尝试的视觉跳变 —— 因为
 *     ResizeObserver 量到的是父区**已经收敛后**的宽度,不存在"主区还没缩、
 *     messageWidth 先扩出去顶过 parent"的中间帧。doc rail 走显式 `compact: true`
 *     仍恒 compact,行为不变。
 */
// 内容封顶宽的历史默认值:调用方不传首参时回落到它(旧行为)。
const MAX_MESSAGE_WIDTH = 1200;
const INPUT_OUTSET = 20; // 输入框比消息流每侧宽 10px（共 20px）
const DEFAULT_MESSAGE_PAD = 50;
// compact 之前用 10/0 太贴边了,input 完全没呼吸空间。20/10 仍比默认紧凑 60%,
// 同时保留视觉缝隙。
const COMPACT_MESSAGE_PAD = 20;
// 主消息流容器宽度低于此阈值时自动切 compact。700 与 ChatInput 的
// `TOOLBAR_DENSE_MAX_WIDTH=520` 对齐——后者对应 input 宽 520(折回容器约
// 600~620),700 留出向上 buffer,保证主区被右栏压到工具行还没开始 dense
// 之前 padding 就先收紧,过渡顺序自然(padding 收紧 → 必要时 toolbar dense
// → 必要时 toolbar compact)。
const AUTO_COMPACT_THRESHOLD = 700;
const DEFAULT_INPUT_PAD = Math.max(0, DEFAULT_MESSAGE_PAD - INPUT_OUTSET / 2);

export interface UseProportionalWidthOptions {
  /** 紧凑模式 (workdir-browse rail / 主会话右栏打开等窄容器场景),两侧 padding 由 50→20。 */
  compact?: boolean;
  /**
   * 内容宽度下限(px)。给"填满可用宽 + 封顶 1200"的自适应再补一个地板:容器
   * 足够宽时 inputWidth 不低于该值。为避免窄窗溢出,地板本身再夹到实测容器宽
   * 以内——窄于地板时回落成"填满容器",绝不撑出去。默认不传 = 无地板(旧行为)。
   * 新建对话页用它保证大屏之外也有一个体面的最小宽度(与对话页同源的 max 对称)。
   */
  minWidth?: number;
}

export function useProportionalWidth(
  maxWidth?: number,
  opts: UseProportionalWidthOptions = {},
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [messageWidth, setMessageWidth] = useState<number>(0);
  const [inputWidth, setInputWidth] = useState<number>(0);
  // inputPad 从恒定派生值改成跟随 effective compact 的 state:
  // 默认 50→40, auto/explicit compact 时 20→10。消费方(overlay 的
  // left-[...]/right-[...] 等)读这个值随容器宽度切换。
  const [inputPad, setInputPad] = useState<number>(DEFAULT_INPUT_PAD);
  // effective compact 标志:= opts.compact || containerWidth < AUTO_COMPACT_THRESHOLD。
  // 消费方据此挂 `chat-rail-compact` 让字号也跟着 padding 一起在 auto compact
  // 时收紧、回到宽态时还原。初始值跟随 opts.compact:doc rail 首帧就是 true,
  // 主会话默认 false,真实值在 useLayoutEffect 同步 compute() 时即被覆写,paint 前对齐。
  const [isCompact, setIsCompact] = useState<boolean>(!!opts.compact);

  const compute = useCallback(
    (containerWidth: number) => {
      if (containerWidth <= 0) return;
      // effective compact = 调用方显式要求 OR 容器实测宽小于阈值。
      // 主消息流不显式传 compact,靠 auto 触发;doc rail 显式传 true,与 auto 取 OR
      // 后仍恒 compact(行为不变)。
      const useCompact = opts.compact || containerWidth < AUTO_COMPACT_THRESHOLD;
      const messagePad = useCompact ? COMPACT_MESSAGE_PAD : DEFAULT_MESSAGE_PAD;
      const nextInputPad = Math.max(0, messagePad - INPUT_OUTSET / 2);
      const messageAvailable = Math.max(0, containerWidth - messagePad * 2);
      // 首参 maxWidth 为内容封顶宽;非法/未传时回落到历史默认 1200。
      const cap = maxWidth && maxWidth > 0 ? maxWidth : MAX_MESSAGE_WIDTH;
      const nextMessage = Math.min(cap, messageAvailable);
      let nextInput = nextMessage + INPUT_OUTSET;
      if (opts.minWidth && opts.minWidth > nextInput) {
        // 地板夹到实测容器宽以内:窄窗仍是"填满容器",不会溢出/裁切。
        nextInput = Math.min(opts.minWidth, containerWidth);
      }
      setMessageWidth(nextMessage);
      setInputWidth(nextInput);
      setInputPad(nextInputPad);
      setIsCompact(useCompact);
    },
    [maxWidth, opts.compact, opts.minWidth],
  );

  // useLayoutEffect + 同步量一次:消除 mount 第一帧 width=0 的视觉跳变。
  // 之前用 useEffect + ResizeObserver,顺序是 render(state=0) → DOM commit
  // → paint(用户看到 0 宽:每个汉字单独一行、输入框被压成一条) →
  // observer 回调 → setState → 再 commit/paint。切 session(remount)时
  // 必现一帧。改成 useLayoutEffect 后,同步 getBoundingClientRect 设新宽度
  // 触发同步重渲染,在 paint 前就已经是正确宽度,坏帧吃掉。ResizeObserver
  // 只负责后续窗口缩放等动态变更。
  //
  // 注:首帧的 compact 判定也走 compute(),所以 mount 进窄容器(<700)时第一
  // 帧就直接是 compact padding,不会出现 50→20 闪烁。后续右栏 transition 收敛
  // 会触发 ResizeObserver 回调,在父宽已稳定的那一帧切到对应 padding,无跳变。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    compute(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      compute(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [compute]);

  return { containerRef, messageWidth, inputWidth, inputPad, isCompact };
}
