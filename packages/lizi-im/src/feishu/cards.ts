/**
 * feishu/cards.ts
 * ---------------------------------------------------------------------------
 * Feishu interactive-card JSON shape templates.
 *
 * 飞书有两套 schema：
 *   - v1: {config, header, elements:[{tag:'div'|'action', ...}]} — supports
 *     button actions (interactive). 我们用这个。
 *   - v2: {schema:'2.0', body:{elements:[...]}} — 弃用了 action tag (实测
 *     2026-04 长连接模式下 v2+action 会报 230099/200861 "no longer support
 *     this capability"). 不用。
 *
 * 流式纯文本卡片（无按钮）走 v2 markdown 元素效率更高 (纯渲染) — 见
 * `streamingText.ts` 里的 `buildStreamingTextCard`.
 */

import type { InteractiveCardSpec } from '../types.js';
import { collectXdtImageRefs } from '../xdtRefs.js';

/**
 * 去掉 markdown inline code 的反引号，保留 fenced code block（```）不动。
 * 飞书深色主题下 inline code 渲染为高对比黑底色块，大量使用时视觉噪音很重。
 */
function stripInlineCode(text: string): string {
  const parts: string[] = [];
  // 按 fenced code block 切分，奇数段是代码块内容（保持原样）
  const segments = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 1) {
      parts.push(segments[i]);
    } else {
      // 非代码块区域：去掉 inline code 反引号（支持 `` `code` `` 和 ``` ``code`` ```）
      parts.push(stripSegmentInlineCode(segments[i]));
    }
  }
  return parts.join('');
}

/**
 * `seg.replace(/`+([^`]+)`+/g, '$1')` 的线性扫描等价实现：
 * 「反引号串 + 非反引号内容 + 反引号串」只留内容。原正则在长反引号串上
 * 会 O(n²) 回溯（CodeQL js/polynomial-redos）。
 */
function stripSegmentInlineCode(seg: string): string {
  let out = '';
  let i = 0;
  while (i < seg.length) {
    const open = seg.indexOf('`', i);
    if (open === -1) {
      out += seg.slice(i);
      break;
    }
    out += seg.slice(i, open);
    let openEnd = open + 1;
    while (openEnd < seg.length && seg.charCodeAt(openEnd) === 0x60) openEnd += 1;
    const close = seg.indexOf('`', openEnd);
    if (close === -1) {
      // 后面再无反引号，闭合不了，剩余部分原样保留
      out += seg.slice(open);
      break;
    }
    out += seg.slice(openEnd, close);
    let closeEnd = close + 1;
    while (closeEnd < seg.length && seg.charCodeAt(closeEnd) === 0x60) closeEnd += 1;
    i = closeEnd;
  }
  return out;
}

// ── interactive (with buttons) — schema v1 ─────────────────────────────────────

interface ButtonValueWrapper {
  /** Business-defined button id, mapped from InteractiveCardButton.id. */
  id: string;
  /** Remaining payload, mapped from InteractiveCardButton.payload. */
  [key: string]: unknown;
}

function buttonElement(text: string, type: 'primary' | 'default' | 'danger', value: ButtonValueWrapper): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value,
  };
}

/**
 * 飞书 v1 单个 action 模块最多 5 个交互组件。超出时拆成多个 action 模块,
 * 否则 sendInteractiveCard 会被拒绝, 调用方按空 answers 继续。
 */
export const FEISHU_V1_ACTION_MAX_COMPONENTS = 5;

function chunkButtons<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

/**
 * Build a feishu v1 interactive card JSON from an InteractiveCardSpec.
 * Buttons are split across action modules of FEISHU_V1_ACTION_MAX_COMPONENTS
 * (同一模块内飞书会自动换行, 但单模块不能超过 5 个).
 */
export function buildInteractiveCardV1(spec: InteractiveCardSpec): unknown {
  const elements: unknown[] = [];

  if (spec.title) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${spec.title}**` },
    });
  }
  if (spec.body) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: stripInlineCode(spec.body) },
    });
  }
  if (spec.buttons.length > 0) {
    for (const group of chunkButtons(spec.buttons, FEISHU_V1_ACTION_MAX_COMPONENTS)) {
      elements.push({
        tag: 'action',
        actions: group.map((b) =>
          buttonElement(b.label, b.type ?? 'default', {
            id: b.id,
            ...(b.payload ?? {}),
          }),
        ),
      });
    }
  }

  return {
    // update_multi: true 把卡片标记为"共享卡片", 让 im.v1.message.patch 的更新
    // 持久化到消息历史 — 否则飞书按"独立卡片"处理, patch 只对当下操作的人临时
    // 生效, 历史里 content 还是原卡, 换设备/重新拉取会 revert 回最初样子。
    config: { wide_screen_mode: true, update_multi: true },
    elements,
  };
}

// ── plain markdown (no buttons) — schema v2 ───────────────────────────────────

/**
 * Build a feishu v2 markdown-only card. Used by streamingText for high-frequency
 * patches (v2 is more efficient for pure-text rendering).
 */
export function buildMarkdownCardV2(text: string): unknown {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: stripInlineCode(text),
        },
      ],
    },
  };
}

/**
 * Build a feishu v2 card with mixed markdown text and inline `img` elements
 * for managed-image references resolved to feishu image_keys. Falls back
 * to italicised "_[图片加载失败:alt]_" placeholder text when imageMap is
 * missing the URL (upload failed).
 *
 * 图片引用识别用 xdtRefs 的共享双协议正则(老 xdt-image + 媒体总仓
 * cindy-media)——此前这里是只认 xdt-image 的本地副本,cindy-media 引用
 * 匹配不上:上传拿到了 image_key 却拼不进卡片,正文残留字面量 markdown。
 *
 * Used by streamingText during finalize after all managed image URLs have
 * been uploaded in parallel.
 */
export function buildMixedMarkdownCardV2(
  text: string,
  imageMap: Map<string, string>,
  appendImageKeys?: ReadonlyArray<string>,
): unknown {
  const elements: unknown[] = [];
  let lastIdx = 0;
  for (const ref of collectXdtImageRefs(text)) {
    const before = text.slice(lastIdx, ref.start);
    if (before) elements.push({ tag: 'markdown', content: stripInlineCode(before) });
    const { alt, url } = ref;
    const key = imageMap.get(url);
    if (key) {
      elements.push({
        tag: 'img',
        img_key: key,
        alt: { tag: 'plain_text', content: alt },
      });
    } else {
      elements.push({
        tag: 'markdown',
        content: `_[图片加载失败:${alt || url}]_`,
      });
    }
    lastIdx = ref.end;
  }
  const tail = text.slice(lastIdx);
  if (tail) elements.push({ tag: 'markdown', content: stripInlineCode(tail) });
  // 追加来自 tool_result 的图片 (没有对应 markdown 链接, 直接挂在末尾):
  // 调用方已经把它们 upload 拿到 image_key, 这里只负责拼 element。
  if (appendImageKeys && appendImageKeys.length > 0) {
    for (const key of appendImageKeys) {
      elements.push({
        tag: 'img',
        img_key: key,
        alt: { tag: 'plain_text', content: '' },
      });
    }
  }
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '_(空回复)_' });
  }
  return { schema: '2.0', config: { update_multi: true }, body: { elements } };
}
