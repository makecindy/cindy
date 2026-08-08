/**
 * shareConversationImage — 「把选中的对话生成一张图」的光栅化管线(renderer)。
 *
 * 做法是**克隆聊天流里已渲染好的消息 DOM**,而不是拿消息数据重新渲染一遍 React。
 * 理由:正文里的 mermaid(懒加载 + 异步 render)、KaTeX、代码高亮、已 decode 的图片
 * 在流里都已是最终形态,克隆即可拿到;重新渲染要自己判定「什么时候算渲染完」,
 * 风险和代码量都高得多。被勾选的消息一定是用户当时看得见的,所以它的 DOM 必然在
 * MessageStream 的 render-window 内。
 *
 * 关键一步是**图片必须先转 data URL**:自定义协议(cindy-media:// 等)的图打进
 * canvas 会 taint,随后 toBlob 被跨源拦截 —— 这条教训已记录在 annotationBurnIn.ts
 * 文件头,那里的 `loadImageSourceBase64` 正是为此存在,这里直接复用。
 *
 * 脱敏只做凭证(产品口径):复用 maker-shared 的 redactSensitiveText,逐 text node
 * 改写,不碰 DOM 结构。
 */

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { diffChars } from 'diff';

import { isImageBytesReachable, loadImageSourceBase64 } from '@/lib/annotationBurnIn';
import { createLogger } from '@/lib/logger';
import { computeExportScale, domToPngBlob, resolveExportBackground } from '@/lib/rasterizeToImage';

const log = createLogger('ShareConversationImage');

/** 消息行挂的定位属性 —— 与 MessageStream 的 wrapper 保持一致。 */
export const SHARE_SESSION_ATTR = 'data-share-session-id';
export const SHARE_MESSAGE_ATTR = 'data-share-message-id';
/** 打了这个标记的元素是纯交互件(操作栏、复选框、hover 工具栏),不进图。 */
export const SHARE_EXCLUDE_ATTR = 'data-share-exclude';

/**
 * 克隆体里必须清掉的锚点属性:离屏容器挂在 document 内,这些 data 属性会让
 * 全局 querySelector(PrevMessageJumpChip 的 data-user-msg-id、消息导航的
 * data-message-client-id(s)、本模块自己的定位属性)命中克隆节点,干扰真实
 * 聊天流的滚动/跳转逻辑。
 * 注意**不清 `id`** —— mermaid / KaTeX 产物内部有 `url(#…)` 自引用,清掉会破图。
 */
const CLONE_STRIPPED_ATTRS = [
  'data-user-msg-id',
  'data-message-client-id',
  'data-message-client-ids',
  SHARE_SESSION_ATTR,
  SHARE_MESSAGE_ATTR,
] as const;

export interface BuildShareImageOptions {
  /** 会话 id —— 与 sessionId 一起定位,避免命中内嵌的第二个 MessageStream。 */
  sessionId: string;
  /** 已选 clientId,**必须按消息流顺序**传入(顺序即图片里的顺序)。 */
  orderedSelectedIds: readonly string[];
  /** 内容宽度(px),与聊天流同宽,保证换行与流里所见一致。 */
  contentWidth: number;
  /** 页脚品牌 logo 的 URL(打包资源,同源)。 */
  logoSrc: string;
  /** 页脚 Cindy 角色主视觉的 URL(打包资源,同源)。 */
  characterSrc?: string;
}

/** 找不到任何选中消息的 DOM 时抛这个 —— 调用方据此 toast。 */
export class ShareImageNoContentError extends Error {
  constructor() {
    super('no selected message nodes found');
    this.name = 'ShareImageNoContentError';
  }
}

/** 找不到仍挂载的已选消息时抛这个 —— 调用方应引导用户滚回后重试。 */
export class ShareImageSelectionNotMountedError extends Error {
  constructor() {
    super('one or more selected message nodes are not mounted');
    this.name = 'ShareImageSelectionNotMountedError';
  }
}

/** 选区过长或过宽、只能缩成低于 1x 的不可读缩略图时抛这个。 */
export class ShareImageTooLargeError extends Error {
  constructor() {
    super('selected content exceeds the readable share image size');
    this.name = 'ShareImageTooLargeError';
  }
}

/**
 * 当前**已渲染**的可选消息 id,按文档顺序(= 消息流顺序)。
 *
 * 为什么以 DOM 而不是 messages 数组为事实源:MessageStream 有 render-window,
 * 长会话里较早的消息还没 mount。若「全选」按 messages 全集来,窗口外那些消息会被
 * 选上却克隆不到,产物图静默缺内容 —— 用户看不出少了东西。而选择框本身也只长在
 * 已渲染的消息上(看不见的消息点不到),所以「可选 = 已渲染」本就是用户看到的语义。
 */
export function queryShareableMessageIds(sessionId: string): string[] {
  const selector = `[${SHARE_SESSION_ATTR}="${cssAttrValue(sessionId)}"][${SHARE_MESSAGE_ATTR}]`;
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map((el) => el.getAttribute(SHARE_MESSAGE_ATTR) ?? '')
    .filter(Boolean);
}

/**
 * 删掉纯交互件。给元素打 `data-share-exclude` 比在这里靠 class 名猜稳:
 * 组件改样式不会让清洗失效。
 */
export function stripInteractiveElements(root: HTMLElement): void {
  root.querySelectorAll(`[${SHARE_EXCLUDE_ATTR}]`).forEach((el) => el.remove());
}

/** 清掉会污染全局 querySelector 的锚点属性(见 CLONE_STRIPPED_ATTRS 注释)。 */
export function stripCloneAnchors(root: HTMLElement): void {
  for (const attr of CLONE_STRIPPED_ATTRS) {
    if (root.hasAttribute(attr)) root.removeAttribute(attr);
    root.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
  }
}

const REDACTION_SCOPE_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'FIELDSET',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);

interface TextNodeRange {
  node: Text;
  start: number;
  end: number;
}

function redactionScopeFor(node: Text, root: HTMLElement): Element {
  let current = node.parentElement;
  while (current && current !== root) {
    if (REDACTION_SCOPE_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return root;
}

function textNodeRanges(nodes: readonly Text[]): TextNodeRange[] {
  let offset = 0;
  return nodes.map((node) => {
    const text = node.nodeValue ?? '';
    const range = { node, start: offset, end: offset + text.length };
    offset = range.end;
    return range;
  });
}

function textNodeIndexAtOffset(ranges: readonly TextNodeRange[], offset: number): number {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (offset < range.end || (offset === range.end && index === ranges.length - 1)) {
      return index;
    }
  }
  return Math.max(0, ranges.length - 1);
}

function projectRedactedText(nodes: readonly Text[], redactedText: string): void {
  const ranges = textNodeRanges(nodes);
  const projected = nodes.map(() => '');
  const originalText = ranges.map((range) => range.node.nodeValue ?? '').join('');
  let originalOffset = 0;

  for (const change of diffChars(originalText, redactedText)) {
    if (change.added) {
      const index = textNodeIndexAtOffset(ranges, originalOffset);
      projected[index] += change.value;
      continue;
    }

    if (change.removed) {
      originalOffset += change.value.length;
      continue;
    }

    let valueOffset = 0;
    while (valueOffset < change.value.length) {
      const index = textNodeIndexAtOffset(ranges, originalOffset + valueOffset);
      const range = ranges[index];
      const available = range.end - (originalOffset + valueOffset);
      const chunkLength = Math.min(available, change.value.length - valueOffset);
      projected[index] += change.value.slice(valueOffset, valueOffset + chunkLength);
      valueOffset += chunkLength;
    }
    originalOffset += change.value.length;
  }

  nodes.forEach((node, index) => {
    node.nodeValue = projected[index];
  });
}

/**
 * 按逻辑连续文本段脱敏,再把结果投影回原有 text node。只改 nodeValue,不动结构 ——
 * 已渲染的 markdown(代码高亮的 span 切分、KaTeX 的字形节点)必须原样保留。
 * 不能逐 node 调用:JSON 高亮会把 key、分隔符、value 拆到多个 span,逐段脱敏会
 * 看不到完整的 assignment,从而把 opaque secret 原样带进图片。
 */
export function redactTextNodes(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const runs = new Map<Element, Text[]>();
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (textNode.nodeValue) {
      const scope = redactionScopeFor(textNode, root);
      const run = runs.get(scope);
      if (run) run.push(textNode);
      else runs.set(scope, [textNode]);
    }
    node = walker.nextNode();
  }

  for (const run of runs.values()) {
    const originalText = run.map((textNode) => textNode.nodeValue ?? '').join('');
    const redactedText = redactSensitiveText(originalText);
    if (redactedText !== originalText) projectRedactedText(run, redactedText);
  }
}

/**
 * 把克隆体里的图片换成 data URL。自定义协议图不转就会 taint canvas(见文件头)。
 * 字节不可达的图直接移除:留着会在产物里渲染成 broken 图标,比缺图更难看。
 */
export async function inlineCloneImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src');
      if (!src) {
        img.remove();
        return;
      }
      if (!isImageBytesReachable(src)) {
        log.warn('share image: unreachable image source, dropping', {
          scheme: src.slice(0, 16),
        });
        img.remove();
        return;
      }
      try {
        const { base64, mimeType } = await loadImageSourceBase64(src);
        img.setAttribute('src', `data:${mimeType};base64,${base64}`);
        img.setAttribute('loading', 'eager');
        img.removeAttribute('srcset');
      } catch (err) {
        log.warn('share image: failed to inline image, dropping', {
          error: err instanceof Error ? err.message : String(err),
        });
        img.remove();
      }
    }),
  );
}

/**
 * 分享图至少保留 1x CSS 像素密度。共享光栅化层的 4096 单边上限是内存硬边界，
 * 继续缩小虽能成功导出，但正文会退化成不可读缩略图；这里宁可明确拒绝。
 */
export function assertShareImageReadableSize(root: HTMLElement): void {
  if (computeExportScale(root.scrollWidth, root.scrollHeight, 2) < 1) {
    throw new ShareImageTooLargeError();
  }
}

/**
 * 让横向/纵向可滚动的块在产物里完整展开。
 *
 * 流内的宽表格、长代码行是 `overflow-x:auto` —— 用户能滚动看全。克隆进图片后
 * 滚动条不存在,右侧内容会被**静默裁掉**:接收方既看不到也不知道被裁了。所以
 * 导出时把这些容器改成按内容宽度展开,图会变宽但信息完整
 * (html-to-image 的画布宽取 `scrollWidth`,底色铺满整张画布,溢出区不会透明)。
 *
 * 必须在克隆体挂进 document **之后**调用 —— getComputedStyle 对游离节点无效。
 */
export function expandScrollableBlocks(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const overflowsX = el.scrollWidth > el.clientWidth;
    const overflowsY = el.scrollHeight > el.clientHeight;
    if (!overflowsX && !overflowsY) continue;

    const style = window.getComputedStyle(el);
    if (overflowsX && (style.overflowX === 'auto' || style.overflowX === 'scroll')) {
      el.style.overflowX = 'visible';
      // 只解除 overflow 不够:容器仍被父级宽度约束,内容照旧在边界处截断。
      el.style.width = 'max-content';
      el.style.maxWidth = 'none';
    }
    if (overflowsY && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
      el.style.overflowY = 'visible';
      el.style.maxHeight = 'none';
    }
  }
}

/**
 * 把克隆体里的消息恢复到完整可读状态。用户消息可能由 line-clamp-3/10 收起,
 * 克隆时正文其实已经在 DOM 中,但 clamp 会让图片只包含前几行;展开按钮也没有可用
 * 的交互,所以两者都必须在光栅化前移除。
 */
export function expandCollapsedMessages(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[class]').forEach((element) => {
    for (const className of Array.from(element.classList)) {
      if (/^line-clamp-\d+$/.test(className)) element.classList.remove(className);
    }
  });
  root.querySelectorAll('button[aria-expanded]').forEach((element) => element.remove());
}

/**
 * 跳选断点处的省略标记。
 *
 * 选了第 1、第 5 条时,两条在图里直接相邻 —— 接收方看不出中间还有对话被跳过,
 * 读起来像一段连续的完整记录。这是诚实性问题,所以断点必须可见。
 */
export function buildShareImageGapMarker(): HTMLElement {
  const marker = document.createElement('div');
  marker.textContent = '⋯';
  marker.style.textAlign = 'center';
  marker.style.fontSize = '14px';
  marker.style.lineHeight = '1';
  marker.style.letterSpacing = '2px';
  marker.style.color = 'var(--text-tertiary)';
  marker.setAttribute('data-share-gap', '');
  return marker;
}

/**
 * 同源资源 → data URL。页脚 logo 是打包 asset,html-to-image 本可自行内联,
 * 但预先转掉能把「产物里 logo 空白」这类不确定性彻底消掉。
 */
async function sameOriginToDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`share image asset fetch failed (${response.status})`);
  }
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Cindy 角色图标的边长(px)。 */
const FOOTER_CHARACTER_PX = 40;
/** 品牌 wordmark 高度(px)。 */
const FOOTER_LOGO_HEIGHT_PX = 24;

export interface ShareImageFooterAssets {
  /** 品牌 wordmark(按主题深浅选好的那一版)。 */
  logoSrc: string;
  /** Cindy 角色主视觉;缺省时页脚只有 logo。 */
  characterSrc?: string;
}

/**
 * 品牌页脚:角色图标与 logo 横向锁定、整体居中。
 * 角色图标直接保留源素材颜色,不额外调色。
 */
export function buildShareImageFooter({
  logoSrc,
  characterSrc,
}: ShareImageFooterAssets): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'flex flex-col items-center';
  footer.style.paddingTop = '48px';

  const lockup = document.createElement('div');
  lockup.className = 'flex items-center justify-center';
  lockup.style.gap = '8px';

  if (characterSrc) {
    const character = document.createElement('img');
    character.src = characterSrc;
    character.alt = '';
    character.style.height = `${FOOTER_CHARACTER_PX}px`;
    character.style.width = `${FOOTER_CHARACTER_PX}px`;
    character.style.borderRadius = '8px';
    character.style.objectFit = 'cover';
    character.style.flexShrink = '0';
    character.setAttribute('loading', 'eager');
    lockup.appendChild(character);
  }

  const logo = document.createElement('img');
  logo.src = logoSrc;
  logo.alt = '';
  logo.style.height = `${FOOTER_LOGO_HEIGHT_PX}px`;
  logo.style.width = 'auto';
  logo.setAttribute('loading', 'eager');
  lockup.appendChild(logo);
  footer.appendChild(lockup);
  return footer;
}

/**
 * 生成分享图片。产物为 PNG Blob;出口(剪贴板 / 另存为)由调用方决定。
 */
export async function buildShareImageBlob({
  sessionId,
  orderedSelectedIds,
  contentWidth,
  logoSrc,
  characterSrc,
}: BuildShareImageOptions): Promise<Blob> {
  const sourceNodes: HTMLElement[] = [];
  for (const clientId of orderedSelectedIds) {
    const selector = `[${SHARE_SESSION_ATTR}="${cssAttrValue(sessionId)}"][${SHARE_MESSAGE_ATTR}="${cssAttrValue(clientId)}"]`;
    const node = document.querySelector<HTMLElement>(selector);
    if (node) sourceNodes.push(node);
  }
  // 选中的消息里有克隆不到 DOM 的(被删除、或极端情况下已卸载):宁可整次失败,
  // 也不出一张静默缺内容的图 —— 用户不会知道少了哪一条。
  if (sourceNodes.length !== orderedSelectedIds.length) {
    log.warn('share image: selected message nodes are not mounted', {
      missingCount: orderedSelectedIds.length - sourceNodes.length,
    });
    throw new ShareImageSelectionNotMountedError();
  }
  if (sourceNodes.length === 0) throw new ShareImageNoContentError();

  // 实底色取自真实聊天流(天然跟随当前主题)。起点用消息的**父容器**而不是消息自身:
  // 搜索命中态的消息带高亮底色(--search-match-bg),从它起找会让整张图变成高亮色。
  const background = resolveExportBackground(sourceNodes[0].parentElement ?? sourceNodes[0]);

  // 离屏定位必须挂在**外层 host** 上,不能放到被光栅化的 stage 自己身上:
  // html-to-image 会把目标节点的 computed style 内联进产物 SVG,`position:fixed`
  // + `left:-99999px` 一起被复制过去,内容就被推出画布,产物只剩一片背景色
  // (2026-08-06 实测:图片全白就是这么来的)。host 负责藏,stage 保持静态定位。
  const host = document.createElement('div');
  host.setAttribute('data-share-export-host', '');
  host.style.position = 'fixed';
  host.style.left = '-99999px';
  host.style.top = '0';
  host.style.zIndex = '-1';
  host.style.pointerEvents = 'none';

  const stage = document.createElement('div');
  stage.setAttribute('data-share-export', '');
  // 显式静态定位 —— 见上:任何偏移类样式都会被内联进产物。
  stage.style.position = 'static';
  // content-box 是刻意的:全局 preflight 把 box-sizing 设成 border-box,那样
  // width 会连 padding 一起算,内容宽比聊天流窄 2×padding —— 换行位置就和用户
  // 在流里看到的不一样了。
  stage.style.boxSizing = 'content-box';
  stage.style.width = `${Math.max(320, Math.round(contentWidth))}px`;
  stage.style.backgroundColor = background;
  // 图片四周留一圈呼吸空间(产物是独立的一张图,不是页面局部截取)。
  stage.style.padding = '40px';
  // 条间距刻意比流内的 14px 宽:流内紧凑是为了信息密度,而独立的一张图要留白
  // 才读得开(§5「留白即品牌」)。
  stage.className = 'flex flex-col gap-6';
  host.appendChild(stage);

  // 跳选判据:选中项在「当前已渲染的可选序列」里是否相邻。以 DOM 序为准,
  // 与 queryShareableMessageIds / 全选同一个事实源。
  const allIds = queryShareableMessageIds(sessionId);
  const orderInAll = new Map(allIds.map((id, index) => [id, index]));

  try {
    let prevIndex: number | null = null;
    for (const [i, node] of sourceNodes.entries()) {
      const currentIndex = orderInAll.get(orderedSelectedIds[i]) ?? null;
      if (prevIndex !== null && currentIndex !== null && currentIndex - prevIndex > 1) {
        stage.appendChild(buildShareImageGapMarker());
      }
      stage.appendChild(node.cloneNode(true) as HTMLElement);
      prevIndex = currentIndex;
    }
    stripInteractiveElements(stage);
    expandCollapsedMessages(stage);
    stripCloneAnchors(stage);
    redactTextNodes(stage);

    // 品牌素材是同源打包资源,html-to-image 本可自行内联;预先转掉是为了把
    // 「产物里 logo / 形象空白」这类不确定性彻底消掉。任一失败都只降级该张图,
    // 不连带整次导出。
    const [footerLogo, footerCharacter] = await Promise.all([
      sameOriginToDataUrl(logoSrc).catch((err) => {
        log.warn('share image: logo inline failed, falling back to raw src', {
          error: err instanceof Error ? err.message : String(err),
        });
        return logoSrc;
      }),
      characterSrc
        ? sameOriginToDataUrl(characterSrc).catch((err) => {
            log.warn('share image: character inline failed, dropping character', {
              error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    stage.appendChild(
      buildShareImageFooter({
        logoSrc: footerLogo,
        ...(footerCharacter ? { characterSrc: footerCharacter } : {}),
      }),
    );

    document.body.appendChild(host);
    // 顺序要紧:展开可滚动块依赖 computed style,必须等挂进 document 之后。
    expandScrollableBlocks(stage);
    await inlineCloneImages(stage);
    // data URL 换上后等一次 decode,避免 html-to-image 序列化到尚未解码的图。
    await Promise.all(
      Array.from(stage.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)),
    );
    assertShareImageReadableSize(stage);

    return await domToPngBlob(stage, { background });
  } finally {
    host.remove();
  }
}

/**
 * 属性选择器里的值要转义。clientId 是内部生成的 id,理论上不含引号/反斜杠,
 * 但选择器拼接一律走转义 —— 不给未来的 id 格式变更留注入面。
 */
function cssAttrValue(value: string): string {
  return value.replace(/[\0-\x1f\x7f"\\]/g, (character) => {
    if (character === '\0') return '\uFFFD';
    if (character === '"' || character === '\\') return `\\${character}`;
    return `\\${character.codePointAt(0)?.toString(16) ?? ''} `;
  });
}
