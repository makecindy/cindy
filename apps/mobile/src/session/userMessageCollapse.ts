/**
 * 手机版用户消息气泡的"过长自动收起"判定(对齐桌面 renderer 的
 * userMessageCollapse:同一套两档阈值,收起策略一致)。
 *
 * 最终判定以真实排版为准:MessageBubble 在气泡里挂一个与正文同宽同字号的
 * 隐藏测量 Text(absolute、opacity 0、不占布局),用 RN 原生 onTextLayout
 * 报的行数决定是否收起;字号缩放 / 转屏引起的宽度变化会触发重新布局回调,
 * 无需额外监听。本文件的纯文本估算只承担两个轻量角色:
 * (a) shouldAutoCollapseUserMessageContent — 测量回调到达前的首帧猜测,
 *     避免超长消息先整段 markdown 渲染、测量后又立刻收起;
 * (b) mayExceedVisualLineThreshold — 上界粗筛,短消息直接跳过测量节点开销。
 *
 * 阈值分两档:手打消息用 LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD;自动化任务
 * 注入的消息(automationOrigin 存在)是模板化调度 prompt、每轮重复出现,用
 * 更低的 AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,收起后也只留更少行数。
 */
export const LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 14;

/** 自动化任务消息的收起阈值:超过 4 个视觉行即收起。 */
export const AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 4;

/** 手打消息收起后保留的行数(numberOfLines)。 */
export const LONG_USER_MESSAGE_COLLAPSED_LINES = 10;

/** 自动化任务消息收起后保留的行数(numberOfLines)。 */
export const AUTOMATION_USER_MESSAGE_COLLAPSED_LINES = 3;

/**
 * 每个视觉行约可容纳的半宽字符单位数:小屏 iPhone(375pt)气泡内容区
 * ≈ 375×86% − 2×16 padding ≈ 290pt,bodyLarge 17pt 半宽 ≈ 8.5pt → ≈34。
 */
const HALF_WIDTH_UNITS_PER_VISUAL_LINE = 34;

/**
 * 粗筛专用的保守行容量:按"最窄支持屏(320pt)+ 系统字号放大 1.2×"折算
 * (≈243pt / 10.2pt ≈ 24 个半宽单位)。粗筛只负责排除"任何宽度下都排不满
 * 阈值"的短消息,是否收起一律由测量 Text 按真实排版实测。
 */
export const MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE = 24;

// 全宽字符范围:CJK 统一表意 / 假名 / 谚文 / 全宽标点与符号等。
// 仅用于宽度估算,不追求 Unicode East Asian Width 的完整精度。
const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/g;

const LINE_BREAK_RE = /\r\n|\r|\n/;

function estimateVisualLineCount(
  line: string,
  halfWidthUnitsPerLine: number = HALF_WIDTH_UNITS_PER_VISUAL_LINE,
): number {
  if (!line) return 1;
  const wideCount = line.match(WIDE_CHAR_RE)?.length ?? 0;
  const units = line.length + wideCount;
  return Math.max(1, Math.ceil(units / halfWidthUnitsPerLine));
}

export function estimateTextVisualLineCount(
  content: string,
  halfWidthUnitsPerLine: number = HALF_WIDTH_UNITS_PER_VISUAL_LINE,
): number {
  if (!content) return 0;
  return content
    .split(LINE_BREAK_RE)
    .reduce((total, line) => total + estimateVisualLineCount(line, halfWidthUnitsPerLine), 0);
}

/** 截取与消息收起态同量级的纯文本前缀，避免分享图带出未显示正文。 */
export function truncateTextToVisualLines(
  content: string,
  maxLines: number,
  halfWidthUnitsPerLine: number = HALF_WIDTH_UNITS_PER_VISUAL_LINE,
): string {
  if (maxLines <= 0 || !content) return '';
  let visualLine = 1;
  let lineUnits = 0;
  let truncated = false;
  let result = '';
  for (const character of content) {
    if (character === '\n') {
      if (visualLine >= maxLines) {
        truncated = true;
        break;
      }
      result += character;
      visualLine += 1;
      lineUnits = 0;
      continue;
    }
    WIDE_CHAR_RE.lastIndex = 0;
    const units = WIDE_CHAR_RE.test(character) ? 2 : 1;
    WIDE_CHAR_RE.lastIndex = 0;
    if (lineUnits > 0 && lineUnits + units > halfWidthUnitsPerLine) {
      if (visualLine >= maxLines) {
        truncated = true;
        break;
      }
      visualLine += 1;
      lineUnits = 0;
    }
    result += character;
    lineUnits += units;
  }
  return truncated ? result.trimEnd() : result;
}

/** 纯文本估算版收起判定:仅作为测量回调到达前的首帧猜测。 */
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
 * 宽度下都不可能需要收起,调用方据此跳过测量 Text 的渲染。
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
 * 汇总收起判定:onTextLayout 实测行数到达后以实测为准,否则用首帧估算兜底。
 * 抽成纯函数以便在无 RN 渲染环境的单测里覆盖。
 */
export function resolveUserMessageCollapse(
  content: string,
  measuredLines: number | null,
  threshold: number,
): boolean {
  if (measuredLines !== null) return measuredLines > threshold;
  return shouldAutoCollapseUserMessageContent(content, threshold);
}
