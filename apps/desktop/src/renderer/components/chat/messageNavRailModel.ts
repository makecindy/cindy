/**
 * messageNavRailModel
 * ---------------------------------------------------------------------------
 * MessageNavRail(左缘"提问导航条")的纯逻辑层:条目派生 / 当前提问判定 /
 * 空间与截断规划。全部为无 DOM 依赖的纯函数,按 scrollAnchoringDetect /
 * viewportFillDetect 的既有惯例拆出,在 node 环境直接单测。
 *
 * 组件侧(MessageNavRail.tsx)只负责测量与渲染:把 DOM 几何量喂进来,拿结果画。
 */

import type { ChatMessage } from '@/hooks/useCCAgentChat';
import { stripChatQuoteMarkerLines } from '@/lib/chatQuotes';
import { resolveUserDisplayText } from './userMessageDisplayText';

export interface NavRailEntry {
  /** user 消息的 clientId,同时是 data-message-client-id 锚点值。 */
  id: string;
  /** scheduler 注入的自动化提问;导航条用更短的刻度与手动提问区分。 */
  isAutomation?: boolean;
  /**
   * 提问的单行预览。不是原文首行:user 消息可能带 composer 引用标记行
   * (`> <!-- cindy-composer-quote -->`),直接截原文会把内部标记裸奔进
   * 预览卡(2026-07-28 验收实锤)。派生时先经 resolveUserDisplayText 取
   * 显示文本(hook / Orca 消息与气泡正文同源),再剥引用标记行,并优先取
   * 用户自己的话(引用块之外的首个非空行)。content 已由 store 归一成可见
   * 正文,不做二次 parseUserContent(提问本身是 JSON 字面量会被解空丢刻度,
   * PR #830 review)。
   */
  preview: string;
  /**
   * 纯附件且取不到任何文件名时(粘贴截图无 originalName),preview 为空、
   * 这里记附件数,组件用 i18n 文案("附件 N 件")兜底渲染预览与 aria ——
   * 纯附件提问是真实提问,必须有刻度(PR #830 review 回归修复)。
   */
  attachmentsOnly?: number;
  /**
   * 该轮回答开头的摘要(已压平空白、截断)。agent 对话里大量提问是
   * "继续 / 不对,重来"这类不含识别信息的短指令,回答摘要才是用户认出
   * "这根刻度是哪一轮"的主载体 — 它是识别的必需品,不是装饰。
   * 回答尚未产生(流式中 / 被打断)时为 undefined,预览卡只显示提问行。
   */
  answerExcerpt?: string;
}

/**
 * 少于这个数量不出导航条。设计依据:少于 4 轮的对话通常一两屏内看完,
 * "地图"没有价值;且用提问数(而非内容高度)做门槛,流式输出把回答撑长时
 * 门槛判定不抖动,导航条不会闪现/消失。
 */
export const NAV_RAIL_MIN_ENTRIES = 4;

/**
 * 点击刻度后,目标提问顶边停在滚动容器顶下方这么多像素。
 * 轮次跳转的目的是"重读这一轮":视口应恰好框住 提问 → 回答,上一轮的
 * 尾巴一行都不该露。所以不走消息通用锚点的 scroll-mt-20(那 80px 是给
 * 搜索跳转留上文语境用的,是另一个任务),改由跳转侧手动计算滚动位置。
 */
export const NAV_RAIL_JUMP_TOP_OFFSET_PX = 12;

/**
 * "当前提问"阈值线距容器顶的偏移。必须大于 NAV_RAIL_JUMP_TOP_OFFSET_PX:
 * 跳转落定后目标自身恰好压线成为当前项,刻度加深不漂移到上一条。
 */
export const NAV_RAIL_ACTIVE_FUDGE_PX = 40;

/** 回答摘要的最大长度(预览卡 CSS 再做 3 行 clamp,这里只防超长字符串)。 */
export const NAV_RAIL_EXCERPT_MAX_CHARS = 200;

/**
 * 空闲补页的目标提问数。导航条是"整段对话的地图",而老会话打开时只加载
 * 尾部切片 —— 尾部提问太少时地图没法用。8 = 出场门槛(4)的两倍:不止
 * "勉强出现",而是一张有导航价值的近期地图,通常一页历史就能凑齐。
 */
export const NAV_RAIL_BACKFILL_TARGET_ENTRIES = 8;

/**
 * 空闲补页的轮数预算(每轮 = 一次 onLoadMore 翻页)。超大会话的内存兜底:
 * 预算用完仍不足 8 条就到此为止,更早的地图随用户上滚自然补齐。
 * "打开会话即拥有全量地图"需要独立的提问索引查询(与消息加载解耦),
 * 涉及主进程与远程隧道路由,留作后续方向,不在本改动内。
 */
export const NAV_RAIL_BACKFILL_MAX_ROUNDS = 3;

/**
 * 是否还需要为导航条补一页历史。纯判定,由 MessageStream 在空闲期调用;
 * 翻页动作本身沿现有 onLoadMore 通道(F-SYNC-2 滚动补偿协议照走)。
 */
export function shouldBackfillForNavRail(input: {
  entryCount: number;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  rounds: number;
}): boolean {
  if (!input.hasMoreMessages || input.isLoadingMore) return false;
  if (input.rounds >= NAV_RAIL_BACKFILL_MAX_ROUNDS) return false;
  return input.entryCount < NAV_RAIL_BACKFILL_TARGET_ENTRIES;
}

/**
 * 内容列左侧留白至少这么宽才有导航条的位置。
 * 组成:左缘留白 8px + 刻度触达区 24px + 与内容列的安全间距 12px。
 * 不够宽(窄窗口 / 嵌入式小面板)时整条隐藏,绝不压在气泡上。
 */
export const NAV_RAIL_MIN_GUTTER_PX = 44;

/** 每根刻度占用的纵向空间(2px 线 + 7px 间距)。实测验收结论:9px 紧凑但
 *  单根可辨认;14px 被否(松散难看)。调整前先实机看效果再动。 */
export const NAV_RAIL_TICK_PITCH_PX = 9;
/** 空间不足时允许压缩到的最小纵距;再小刻度就粘连不可点了。 */
export const NAV_RAIL_TICK_MIN_PITCH_PX = 5;

/**
 * 刻度带可用高度低于这个值时导航条不出场(与横向留白门槛同级的纵向门槛)。
 * 极矮视口 / 输入 overlay 占满高度时,连出场门槛条数的刻度都摆不下,
 * 硬渲染会溢出压到输入区(PR #830 review)。取值 = 门槛条数 × 标准纵距。
 */
export const NAV_RAIL_MIN_AVAIL_HEIGHT_PX = NAV_RAIL_MIN_ENTRIES * NAV_RAIL_TICK_PITCH_PX;

/**
 * 从已加载的 messages 派生导航条目(每条真实提问一根刻度)。
 *
 * 过滤规则与 PrevMessageJumpChip 的 userMessageIds 同源,再加一条:
 * - isSyntheticTrigger:合成指令行渲染 null,没有可滚动的锚点;
 * - systemCardType:user 位次上的系统卡(compact / learn …),不是用户提问。
 *
 * 回答摘要取该提问之后第一条非空 assistant 正文的开头(thinking / tool 行
 * 不算正文):它可能是开工叙述而非最终结论,但作为"这一轮在干什么"的识别
 * 线索足够,且流式期间就有值。
 *
 * 注意输入是全量已加载 messages 而非 visibleRenderItems —— 导航条要覆盖
 * 整段已加载历史,渲染窗口外的目标由跳转侧扩窗解决(见 MessageStream 的
 * rail-jump layout effect)。更早的未加载 DB 分页(hasMoreMessages)不在
 * 条目里,随用户上滚加载后自然补齐。
 */
export function deriveNavRailEntries(messages: readonly ChatMessage[]): NavRailEntry[] {
  const entries: NavRailEntry[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.isSyntheticTrigger) continue;
      if (m.systemCardType) continue;
      // 运行中插话(steer)不是新一轮问答:MessageStream 的轮次语义也不把
      // 它当边界,算成刻度会把进行中的回答错挂到插话名下(PR #830 review)。
      if (m.delivery === 'steer') continue;
      // 预览来源按序:显示文本(hook 消息取 userText / 剥 <thread_context>,
      // Orca 通信行解包 JSON,与 UserMessage 气泡正文同源,见
      // userMessageDisplayText.ts;PR #830 review)→ ChatMessage 顶层
      // images/files 字段的附件名(store 入库时已把封装解到顶层,content 即
      // 可见正文,PR #830 review)。
      let preview = promptPreviewLine(resolveUserDisplayText(m));
      const attachmentNames = [
        ...(m.images ?? []).map((image) =>
          'originalName' in image ? image.originalName : undefined,
        ),
        ...(m.files ?? []).map((file) => file.name),
      ].filter((name): name is string => Boolean(name));
      if (!preview) preview = attachmentNames.join(' · ');
      const attachmentCount = (m.images?.length ?? 0) + (m.files?.length ?? 0);
      if (preview) {
        entries.push({ id: m.clientId, preview, isAutomation: Boolean(m.automationOrigin) });
      } else if (attachmentCount > 0) {
        // 有附件但一个名字都取不到(粘贴截图):仍是真实提问,保留刻度,
        // 预览文案由组件按 attachmentsOnly 用 i18n 兜底。
        entries.push({
          id: m.clientId,
          preview: '',
          attachmentsOnly: attachmentCount,
          isAutomation: Boolean(m.automationOrigin),
        });
      }
      // 无文本、无附件 → 无法识别的空刻度,不当成提问(PR #830 review)。
      continue;
    }
    if (m.role !== 'assistant') continue;
    const last = entries[entries.length - 1];
    if (!last || last.answerExcerpt !== undefined) continue;
    const excerpt = normalizeExcerpt(m.content);
    if (excerpt) last.answerExcerpt = excerpt;
  }
  return entries;
}

/**
 * 提问(可见正文)→ 单行预览。无条件剥引用标记行(不赌 quotesEncoded 旗标),
 * 优先取引用块之外用户自己的话;全引用消息退回引用文字本身。
 *
 * 输入按**已归一化的可见正文**处理,不再 parseUserContent:store 侧两条入库
 * 路径(发送存 text / 历史映射存 parsed.text)都已解掉附件封装,附件名在
 * ChatMessage 顶层 images/files。这里再解析一次,提问本身恰好是 JSON 字面量
 * 时(如只输入 `[1,2,3]`)会被误当成附件封装 / SDK content blocks,预览解空、
 * 真实提问丢刻度,出场门槛也被算小(PR #830 review)。
 */
export function promptPreviewLine(visibleText: string): string {
  const lines = stripChatQuoteMarkerLines(visibleText).split('\n');
  const own = lines.find((line) => line.trim() && !line.trimStart().startsWith('>'));
  const anyLine = lines.find((line) => line.trim()) ?? '';
  return (own ?? anyLine).replace(/^\s*>\s?/, '').trim();
}

/**
 * 摘要净化:剥常见 Markdown 标记 → 压平空白成单行 → 截断到上限。
 * AI 回答几乎都是 Markdown,不剥标记的话预览卡里全是 `**` / 反引号 / 标题井号
 * 这类源码噪音。只做轻量文本级剥离(粗体星号 / 行内代码 / 标题与引用前缀 /
 * 无序列表符 / 链接留文字),不追求完整 Markdown 解析 —— 预览要的是可扫读,
 * 不是保真渲染。下划线不动(文件名 / 标识符里是正文)。
 * 全空白返回空串(调用方按 falsy 丢弃)。
 */
export function normalizeExcerpt(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '') // HTML 注释(含 composer 引用标记)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片留文字
    .replace(/^#{1,6}\s+/gm, '') // 标题前缀
    .replace(/^>\s?/gm, '') // 引用前缀
    .replace(/^[-+]\s+/gm, '') // 无序列表符(星号由下一条统一剥)
    .replace(/[*`]/g, '') // 粗体/斜体星号、行内代码反引号
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAV_RAIL_EXCERPT_MAX_CHARS);
}

/**
 * 判定"当前提问":视口顶端正在阅读的内容归属于哪条提问。
 *
 * 语义 = 最后一条"顶边已越过视口顶部阈值线"的提问(它的回答正被阅读)。
 * 全部都还在阈值线之下(视口停在对话最顶端)时,当前提问 = 第一条。
 *
 * @param topAt 取第 i 条的顶边位置(getBoundingClientRect().top)。
 *   `null` = 该消息在渲染窗口外未挂载。渲染窗口是"锚点 → 末尾"的后缀切片,
 *   未挂载必然在窗口起点之前、也就在视口上方 —— 视作"已越过阈值"。
 * @param thresholdTop 视口顶部阈值线(容器 top + fudge)。fudge 要盖过
 *   scroll-mt-20 的 80px 锚点偏移,跳转落定后目标自身恰好压线变为当前项。
 */
export function pickActiveNavId(
  ids: ReadonlyArray<string>,
  thresholdTop: number,
  topAt: (index: number) => number | null,
): string | null {
  if (ids.length === 0) return null;
  const idx = lastIndexAtOrBelow(ids.length, thresholdTop, topAt, true);
  return idx >= 0 ? ids[idx] : ids[0];
}

/**
 * 二分查找"最后一个顶边不超过 limit 的条目下标"(找不到返回 -1)。
 *
 * 前提:tops 随文档序单调不减,未挂载(null)视作 -∞ 且只出现在前缀
 * (渲染窗口是"锚点 → 末尾"的后缀切片)。每次 topAt 是一次
 * querySelector + getBoundingClientRect 强制布局读,且判定在 rAF 里逐帧
 * 跑 —— 线性反向扫描在"滚动到长会话历史顶部"场景下每帧要测几百个锚点,
 * 二分降到 O(log n)(PR #830 review)。
 */
function lastIndexAtOrBelow(
  count: number,
  limit: number,
  topAt: (index: number) => number | null,
  inclusive: boolean,
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const top = topAt(mid) ?? Number.NEGATIVE_INFINITY;
    if (inclusive ? top <= limit : top < limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 范围判定的底部容差:轮次顶边至少要探进视口底这么多像素才算可见。 */
export const NAV_RAIL_RANGE_BOTTOM_EDGE_PX = 8;

export interface NavRailVisibleRange {
  /** 视口内首个可见轮次的条目下标(含)。 */
  startIndex: number;
  /** 视口内最后一个可见轮次的条目下标(含)。 */
  endIndex: number;
}

/**
 * 判定"当前视口正显示着哪些轮次"(整段高亮用,与单一"当前项"互补:
 * 当前项 = 阅读锚点,加长;可见范围 = 屏上内容的归属轮次,提亮)。
 *
 * 轮次 i 的内容区间 = [top_i, top_{i+1});最后一轮延伸到无穷。与
 * [viewTop, viewBottom) 相交即可见。tops 随文档序单调递增;`null`(渲染
 * 窗口外未挂载)视作 -∞ —— 其轮次内容必在视口上方。
 *
 * 边界语义:调用方传入的应是**有效视口**,即已经扣除容差的边界 ——
 * 顶部与"当前项"共用 NAV_RAIL_ACTIVE_FUDGE_PX(视口顶部的几十像素往往
 * 是上一轮的收尾空白:消息间距 + 跳转落点偏移,一行内容都没露,严格几何
 * 相交会把上一轮误点亮,2026-07-28 实拍验收抓到的缺陷);底部扣
 * NAV_RAIL_RANGE_BOTTOM_EDGE_PX 防 1 像素露头就点亮。顶部与当前项共线的
 * 推论:当前项恒等于亮带首项,加长与提亮两个信号永不打架。
 *
 * 视口整体在第一条提问之前(还没有任何轮次开始)时返回 null。
 */
export function pickVisibleNavRange(
  ids: ReadonlyArray<string>,
  viewTop: number,
  viewBottom: number,
  topAt: (index: number) => number | null,
): NavRailVisibleRange | null {
  const n = ids.length;
  if (n === 0) return null;
  // 末端:最后一个"轮次起点已进入视口底之上"的条目。
  const endIndex = lastIndexAtOrBelow(n, viewBottom, topAt, false);
  if (endIndex < 0) return null;
  // 起端:最后一个"顶边仍在视口顶之上(含压线)"的条目 —— 它以及它之后
  // 到 endIndex 的轮次都有内容落在视口里;不存在时视口从第一条开始。
  const startIndex = Math.min(endIndex, Math.max(0, lastIndexAtOrBelow(n, viewTop, topAt, true)));
  return { startIndex, endIndex };
}

export interface NavRailPlan {
  /** 从这个下标开始渲染(之前的条目被截断,只保留最近的一段)。 */
  startIndex: number;
  /** 实际采用的纵距(px/根)。 */
  pitchPx: number;
  /** 被截掉的更早条目数;>0 时组件渲染"更早还有 N 条"占位刻度。 */
  hiddenCount: number;
}

/**
 * 纵向空间规划:先压缩间距,还放不下就截断只保留最近的一段。
 * 截断时预留一根刻度的位置给"更早还有 N 条"占位。
 */
export function planNavRailTicks(entryCount: number, availableHeightPx: number): NavRailPlan {
  if (entryCount <= 0 || availableHeightPx <= 0) {
    return { startIndex: 0, pitchPx: NAV_RAIL_TICK_PITCH_PX, hiddenCount: 0 };
  }
  if (entryCount * NAV_RAIL_TICK_PITCH_PX <= availableHeightPx) {
    return { startIndex: 0, pitchPx: NAV_RAIL_TICK_PITCH_PX, hiddenCount: 0 };
  }
  const compressed = Math.floor(availableHeightPx / entryCount);
  if (compressed >= NAV_RAIL_TICK_MIN_PITCH_PX) {
    return { startIndex: 0, pitchPx: compressed, hiddenCount: 0 };
  }
  // 最小纵距也放不下:截断。留一格给"更早还有 N 条"占位刻度。
  const slots = Math.max(2, Math.floor(availableHeightPx / NAV_RAIL_TICK_MIN_PITCH_PX));
  const shown = Math.min(entryCount, slots - 1);
  return {
    startIndex: entryCount - shown,
    pitchPx: NAV_RAIL_TICK_MIN_PITCH_PX,
    hiddenCount: entryCount - shown,
  };
}

/**
 * 导航条是否有横向空间:内容列(maxWidth 截断后)左侧的实际留白够不够。
 * 内容列由 mx-auto 居中,留白 = (容器宽 - 内容实际宽) / 2。
 */
export function hasNavRailRoom(containerWidthPx: number, contentMaxWidthPx: number): boolean {
  if (containerWidthPx <= 0) return false;
  const contentWidth = Math.min(containerWidthPx, contentMaxWidthPx);
  return (containerWidthPx - contentWidth) / 2 >= NAV_RAIL_MIN_GUTTER_PX;
}
