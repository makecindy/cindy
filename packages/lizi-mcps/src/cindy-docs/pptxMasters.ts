/**
 * cindy-docs/pptxMasters.ts —— pptxgenjs 母版版式(纯几何 + 色板,不捆图不捆字体)。
 *
 * 三套版式:
 *  - cover   封面:左侧强调条、大标题、无页码
 *  - section 分节:左侧强调条、居中偏上标题、页脚页码
 *  - content 内容:标题区 + 正文区 + 页脚页码;有图时文字收窄到左半
 *
 * 母版只放「每一页都一样」的铬件(底色、强调条、页脚线、页码)。标题和正文仍由
 * 调用方按本文件给出的槽位往 slide 上写 —— 占位符在 pptxgenjs 里不好测,也容易
 * 让文字落到母版层导致解包断言扑空。
 */

import type pptxgen from 'pptxgenjs';

import type { DocsTheme } from './themes.js';

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;

export const PPTX_LAYOUT_NAMES = ['cover', 'section', 'content'] as const;
export type PptxLayoutName = (typeof PPTX_LAYOUT_NAMES)[number];
export const DEFAULT_PPTX_LAYOUT: PptxLayoutName = 'content';

export const PPTX_LAYOUT_IDS = {
  cover: 'CINDY_COVER',
  section: 'CINDY_SECTION',
  content: 'CINDY_CONTENT',
} as const;

export interface PptxBox {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

export interface PptxLayoutSlots {
  title: PptxBox;
  subtitle?: PptxBox;
  body: PptxBox;
  image?: Omit<PptxBox, 'fontSize'>;
  /** 内容页标题下的强调短线;封面/分节没有。 */
  accentLine?: Omit<PptxBox, 'fontSize'>;
}

export interface DefineCindyPptxMastersOptions {
  theme: DocsTheme;
  footer: boolean;
  footerLabel?: string;
}

function footerLabelText(label: string | undefined): string {
  const trimmed = (label ?? '').trim();
  if (trimmed.length === 0) return '';
  return trimmed.length > 42 ? `${trimmed.slice(0, 41)}…` : trimmed;
}

/**
 * 给一份演示文稿登记三套母版。同一份 deck 只应调一次;主题在登记时固化。
 */
export function defineCindyPptxMasters(
  pptx: pptxgen,
  options: DefineCindyPptxMastersOptions,
): void {
  const { theme, footer } = options;
  const label = footer ? footerLabelText(options.footerLabel) : '';
  const pageNumber = footer
    ? { x: 12.15, y: 7.12, w: 0.55, h: 0.28, fontSize: 10, color: theme.muted, align: 'right' as const }
    : undefined;

  const footerChrome = footer
    ? [
        {
          rect: {
            x: 0.7,
            y: 7.02,
            w: 11.93,
            h: 0.012,
            fill: { color: theme.line },
          },
        },
        ...(label.length > 0
          ? [
              {
                text: {
                  text: label,
                  options: {
                    x: 0.7,
                    y: 7.12,
                    w: 11.2,
                    h: 0.28,
                    fontSize: 10,
                    color: theme.muted,
                    margin: 0,
                  },
                },
              },
            ]
          : []),
      ]
    : [];

  pptx.defineSlideMaster({
    title: PPTX_LAYOUT_IDS.cover,
    background: { color: theme.background },
    objects: [
      { rect: { x: 0, y: 0, w: 0.16, h: SLIDE_H, fill: { color: theme.accent } } },
    ],
  });

  pptx.defineSlideMaster({
    title: PPTX_LAYOUT_IDS.section,
    background: { color: theme.background },
    ...(pageNumber ? { slideNumber: pageNumber } : {}),
    objects: [
      { rect: { x: 0, y: 0, w: 0.16, h: SLIDE_H, fill: { color: theme.accent } } },
      ...footerChrome,
    ],
  });

  pptx.defineSlideMaster({
    title: PPTX_LAYOUT_IDS.content,
    background: { color: theme.background },
    ...(pageNumber ? { slideNumber: pageNumber } : {}),
    objects: [...footerChrome],
  });
}

/** 按版式 + 是否有图算出这一页内容该落在哪。几何是唯一真相,make_pptx 不要再手写坐标。 */
export function layoutSlots(
  layout: PptxLayoutName,
  opts: { hasImage: boolean; hasSubtitle: boolean },
): PptxLayoutSlots {
  const { hasImage, hasSubtitle } = opts;

  if (layout === 'cover') {
    return {
      title: { x: 0.95, y: hasSubtitle ? 2.15 : 2.45, w: 11.5, h: 1.7, fontSize: 40 },
      ...(hasSubtitle
        ? { subtitle: { x: 0.95, y: 4.0, w: 11.5, h: 0.7, fontSize: 18 } }
        : {}),
      body: { x: 0.95, y: hasSubtitle ? 4.85 : 4.4, w: 11.5, h: 1.7, fontSize: 16 },
    };
  }

  if (layout === 'section') {
    return {
      title: { x: 0.95, y: hasSubtitle ? 2.55 : 2.85, w: 11.5, h: 1.15, fontSize: 32 },
      ...(hasSubtitle
        ? { subtitle: { x: 0.95, y: 3.8, w: 11.5, h: 0.5, fontSize: 16 } }
        : {}),
      body: { x: 0.95, y: hasSubtitle ? 4.5 : 4.2, w: 11.5, h: 2.2, fontSize: 16 },
    };
  }

  const textW = hasImage ? SLIDE_W / 2 - 0.7 : 11.93;
  const titleH = hasSubtitle ? 0.56 : 0.72;
  return {
    title: { x: 0.7, y: 0.38, w: 11.93, h: titleH, fontSize: 26 },
    ...(hasSubtitle
      ? { subtitle: { x: 0.7, y: 0.96, w: textW, h: 0.32, fontSize: 13 } }
      : {}),
    accentLine: { x: 0.7, y: hasSubtitle ? 1.34 : 1.16, w: 1.55, h: 0.045 },
    body: {
      x: 0.7,
      y: hasSubtitle ? 1.55 : 1.42,
      w: textW,
      h: hasSubtitle ? 5.25 : 5.4,
      fontSize: 18,
    },
    ...(hasImage
      ? { image: { x: SLIDE_W / 2 + 0.15, y: 1.42, w: SLIDE_W / 2 - 0.85, h: 5.2 } }
      : {}),
  };
}
