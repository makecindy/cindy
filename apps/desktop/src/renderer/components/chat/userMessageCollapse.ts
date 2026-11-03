import { useLayoutEffect, useRef, useState } from 'react';

/**
 * 用户消息气泡的"过长自动收起"判定。
 *
 * 最终判定以前端真实排版为准:useUserMessageAutoCollapse 用一个与正文同宽
 * 同字号的隐藏镜像节点测量实际视觉行数,并通过 ResizeObserver 跟随气泡宽度
 * 变化(窗口缩放、侧栏开合)动态重算。纯文本估算只承担两个轻量角色:
 * (a) shouldAutoCollapseUserMessageContent — 首帧渲染前的初始猜测,避免超长
 *     消息先整段富文本渲染、测量后又立刻收起;
 * (b) mayExceedVisualLineThreshold — 上界粗筛,短消息直接跳过镜像节点与
 *     ResizeObserver 的开销。
 *
 * 阈值分两档:手打消息用 LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD;自动化任务
 * 注入的消息(automationOrigin 存在)是模板化调度 prompt、每轮重复出现,用
 * 更低的 AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,收起后也只留更少行数
 * (UserMessage 侧 line-clamp-3 vs line-clamp-10)。
 */
export const LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 14;

/** 自动化任务消息的收起阈值:超过 4 个视觉行即收起。 */
export const AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 4;

/** 每个视觉行约可容纳的半宽字符单位数(456px 内容区 / 15px 字号,全宽字符按 2 计)。 */
const HALF_WIDTH_UNITS_PER_VISUAL_LINE = 60;

/**
 * 粗筛专用的保守行容量:按"气泡内容区被窗口 / 侧栏 / 协同面板压到约 180px"
 * 的最窄情况折算(≈12 个全宽字符 = 24 个半宽单位)。粗筛若用名义宽度(60),
 * 窄气泡下本该收起的中等长度消息会被挡在测量之外,且 resize 也无法补救
 * (镜像节点根本没挂)。粗筛只负责排除"任何宽度下都排不满阈值"的短消息,
 * 是否收起一律由镜像节点按真实宽度实测。
 */
const MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE = 24;

/** 镜像节点测不出 line-height 时的兜底(15px 字号 × leading-[1.6])。 */
const FALLBACK_LINE_HEIGHT_PX = 24;

// 全宽字符范围:CJK 统一表意 / 假名 / 谚文 / 全宽标点与符号等。
// 仅用于宽度估算,不追求 Unicode East Asian Width 的完整精度。
const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/g;

const LINE_BREAK_RE = /\r\n|\r|\n/;

function estimateVisualLineCount(line: string): number {
  if (!line) return 1;
  const wideCount = line.match(WIDE_CHAR_RE)?.length ?? 0;
  const units = line.length + wideCount;
  return Math.max(1, Math.ceil(units / HALF_WIDTH_UNITS_PER_VISUAL_LINE));
}

/** 纯文本估算版收起判定:仅作为镜像测量完成前的初始猜测。 */
export function shouldAutoCollapseUserMessageContent(
  content: string,
  threshold: number = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  let visualLines = 0;
  for (const line of trimmed.split(LINE_BREAK_RE)) {
    visualLines += estimateVisualLineCount(line);
    if (visualLines > threshold) return true;
  }
  return false;
}

/**
 * 上界粗筛:按"全部是全宽字符 + 气泡被压到最窄"的最坏情况折算视觉行数上界
 * (逻辑行数 + 2×字符数/保守行容量),都排不满阈值的内容在任何支持的气泡
 * 宽度下都不可能需要收起,调用方据此跳过镜像节点渲染与测量。
 */
export function mayExceedVisualLineThreshold(
  content: string,
  threshold: number = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;

  const logicalLines = trimmed.split(LINE_BREAK_RE).length;
  return (
    logicalLines + (trimmed.length * 2) / MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE >
    threshold
  );
}

/**
 * 同一正文在同一阈值下最近一次的实测结论。切回长任务时整屏气泡重新挂载,逐个在
 * layout effect 里同步测量会在挂载中途强制排版;有上次结论时直接沿用,只交给
 * ResizeObserver 在排版完成后复核(宽度变了照样纠正)。只存布尔,不落盘。
 * 正文本身是键,会话窗口被淘汰后仍被它持有:条数与总字符数都封顶(按插入序淘汰),
 * 超长单条直接不缓存,照旧同步测量。
 */
const MEASURED_COLLAPSE_LIMIT = 500;
const MEASURED_COLLAPSE_MAX_CHARACTERS = 1_000_000;
const MEASURED_COLLAPSE_MAX_ENTRY_CHARACTERS = 64 * 1024;
/** 正文 → (阈值 → 是否收起)。 */
const measuredCollapse = new Map<string, Map<number, boolean>>();
let measuredCollapseCharacters = 0;

function readMeasuredCollapse(content: string, threshold: number): boolean | undefined {
  return measuredCollapse.get(content)?.get(threshold);
}

function rememberMeasuredCollapse(content: string, threshold: number, collapse: boolean): void {
  if (content.length > MEASURED_COLLAPSE_MAX_ENTRY_CHARACTERS) return;
  let byThreshold = measuredCollapse.get(content);
  if (byThreshold) measuredCollapse.delete(content);
  else {
    byThreshold = new Map();
    measuredCollapseCharacters += content.length;
  }
  byThreshold.set(threshold, collapse);
  measuredCollapse.set(content, byThreshold);
  // The new entry is last and below the total cap, so this never evicts it.
  while (
    measuredCollapse.size > MEASURED_COLLAPSE_LIMIT ||
    measuredCollapseCharacters > MEASURED_COLLAPSE_MAX_CHARACTERS
  ) {
    const oldest = measuredCollapse.keys().next().value;
    if (oldest === undefined) break;
    measuredCollapse.delete(oldest);
    measuredCollapseCharacters -= oldest.length;
  }
}

/**
 * 以真实排版为准的长消息收起判定 hook。
 *
 * 调用方把 mirrorRef 挂到气泡内的隐藏镜像节点(与正文同宽、同字号、同换行
 * 规则的纯文本,max-h-0 + overflow-hidden 不占布局),本 hook 用
 * scrollHeight / line-height 推出实际视觉行数,并用 ResizeObserver 跟随
 * 气泡宽度变化重算。enabled 为 false(orca 消息 / 粗筛未命中)时不做任何
 * 测量,恒返回 false。threshold 按消息来源分档(手打 / 自动化任务)。
 */
export function useUserMessageAutoCollapse(
  content: string,
  enabled: boolean,
  threshold: number = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  // 首帧优先用同一正文上次的实测结论,没有时用纯文本估算兜底;后者由
  // useLayoutEffect 的真实测量在首次绘制前修正。
  const [shouldCollapse, setShouldCollapse] = useState(
    () =>
      enabled &&
      (readMeasuredCollapse(content, threshold) ??
        shouldAutoCollapseUserMessageContent(content, threshold)),
  );

  useLayoutEffect(() => {
    if (!enabled) {
      setShouldCollapse(false);
      return;
    }
    const el = mirrorRef.current;
    if (!el) return;

    const measure = () => {
      const lineHeight =
        Number.parseFloat(getComputedStyle(el).lineHeight) || FALLBACK_LINE_HEIGHT_PX;
      // Math.round 是有意的容差带:镜像是单一字号的纯文本,内容高度按行盒
      // 量化,真实多出一行会让比值整整 +1,而亚像素 / 高字形(emoji)只带来
      // <0.5 行的偏差。改成 ceil 会让恰好压线的消息被 +1px 伪差错误收起。
      const lines = Math.round(el.scrollHeight / lineHeight);
      rememberMeasuredCollapse(content, threshold, lines > threshold);
      setShouldCollapse(lines > threshold);
    };

    const remembered = readMeasuredCollapse(content, threshold);
    if (remembered === undefined) measure();
    else setShouldCollapse(remembered);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content, enabled, threshold]);

  return { mirrorRef, shouldCollapse };
}
