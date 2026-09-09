/**
 * cindy-docs/pptxMasters.ts —— pptxgenjs 母版版式(纯几何 + 色板,不捆图不捆字体)。
 *
 * 六套版式:
 *  - cover   封面:左侧强调条、大标题、无页码
 *  - section 分节:左侧强调条、居中偏上标题、页脚页码
 *  - content 内容:标题区 + 正文区 + 页脚页码;有图时文字收窄到左半
 *  - comparison 双栏对比:两个结构化信息卡并排
 *  - metrics 数据强调:2–4 个指标卡
 *  - image 大图:标题区 + 通栏图片 + 可选题注
 *
 * 母版只放「每一页都一样」的铬件(底色、强调条、页脚线、页码)。标题和正文仍由
 * 调用方按本文件给出的槽位往 slide 上写 —— 占位符在 pptxgenjs 里不好测,也容易
 * 让文字落到母版层导致解包断言扑空。
 */

import type pptxgen from 'pptxgenjs';

import type { DocsTheme } from './themes.js';

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;

/** 封面左侧强调色块的宽度(英寸)。约占页宽 1/3,是封面唯一的构图元素。 */
export const COVER_PANEL_W = 4.4;

/** 分节页顶部强调带的高度(英寸)。 */
export const SECTION_BAND_H = 0.62;

export const PPTX_LAYOUT_NAMES = [
  'cover',
  'section',
  'content',
  'comparison',
  'metrics',
  'image',
] as const;
export type PptxLayoutName = (typeof PPTX_LAYOUT_NAMES)[number];
export const DEFAULT_PPTX_LAYOUT: PptxLayoutName = 'content';

export const PPTX_LAYOUT_IDS = {
  cover: 'CINDY_COVER',
  section: 'CINDY_SECTION',
  content: 'CINDY_CONTENT',
  comparison: 'CINDY_COMPARISON',
  metrics: 'CINDY_METRICS',
  image: 'CINDY_IMAGE',
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
 * 给一份演示文稿登记六套母版。同一份 deck 只应调一次;主题在登记时固化。
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

  // 封面:左侧整幅强调色块 + 右侧留白。原来只有一根 0.16" 的竖条,在实机目检里
  // 几乎看不见 —— 整页就是「白底加几行字」。色块给足面积才撑得起一页封面。
  pptx.defineSlideMaster({
    title: PPTX_LAYOUT_IDS.cover,
    background: { color: theme.background },
    objects: [
      { rect: { x: 0, y: 0, w: COVER_PANEL_W, h: SLIDE_H, fill: { color: theme.accent } } },
      // 色块右缘一道浅色窄条,让色块与白底之间有个交代,不是硬切。
      {
        rect: {
          x: COVER_PANEL_W,
          y: 0,
          w: 0.06,
          h: SLIDE_H,
          fill: { color: theme.surface },
        },
      },
    ],
  });

  // 分节:顶部一条粗强调带 + 底部细线。整页只有一个标题,靠这两条横向元素定住
  // 视觉重心,否则标题浮在中间、上下大片空白(实机目检里就是这样)。
  pptx.defineSlideMaster({
    title: PPTX_LAYOUT_IDS.section,
    background: { color: theme.background },
    ...(pageNumber ? { slideNumber: pageNumber } : {}),
    objects: [
      { rect: { x: 0, y: 0, w: SLIDE_W, h: SECTION_BAND_H, fill: { color: theme.accent } } },
      ...footerChrome,
    ],
  });

  const contentChrome = [
    // 顶部一条细强调线贯穿:内容页原来只有孤零零的标题和一小段短线,页面没有
    // 任何边界感。这条线成本极低,但让每一页都「有个头」。
    {
      rect: { x: 0, y: 0, w: SLIDE_W, h: 0.075, fill: { color: theme.accent } },
    },
    ...footerChrome,
  ];
  for (const layout of ['content', 'comparison', 'metrics', 'image'] as const) {
    pptx.defineSlideMaster({
      title: PPTX_LAYOUT_IDS[layout],
      background: { color: theme.background },
      ...(pageNumber ? { slideNumber: pageNumber } : {}),
      objects: contentChrome,
    });
  }
}

/** 按版式 + 是否有图算出这一页内容该落在哪。几何是唯一真相,make_pptx 不要再手写坐标。 */
export function layoutSlots(
  layout: PptxLayoutName,
  opts: { hasImage: boolean; hasSubtitle: boolean },
): PptxLayoutSlots {
  const { hasImage, hasSubtitle } = opts;

  if (layout === 'cover') {
    // 文字整体落在色块右侧的留白区,与色块之间留一个身位。标题放大到 44pt ——
    // 封面就这一行字,原来的 40pt 配 11.5" 宽通栏显得又小又散。
    const x = COVER_PANEL_W + 0.85;
    const w = SLIDE_W - x - 0.9;
    return {
      title: { x, y: hasSubtitle ? 2.35 : 2.75, w, h: 1.9, fontSize: 44 },
      ...(hasSubtitle ? { subtitle: { x, y: 4.45, w, h: 0.75, fontSize: 18 } } : {}),
      body: { x, y: hasSubtitle ? 5.3 : 4.75, w, h: 1.5, fontSize: 15 },
      // 标题与副题之间的短粗线,给封面一个可读的分隔。
      accentLine: { x, y: hasSubtitle ? 4.06 : 4.46, w: 1.9, h: 0.07 },
    };
  }

  if (layout === 'section') {
    // 分节页整体下压到视觉中线偏上,顶部让给强调带;标题左对齐不居中 ——
    // 居中标题配大片空白正是实机目检里最空的一页。
    return {
      title: { x: 0.95, y: hasSubtitle ? 2.75 : 3.05, w: 11.5, h: 1.25, fontSize: 34 },
      ...(hasSubtitle ? { subtitle: { x: 0.95, y: 4.5, w: 11.5, h: 0.55, fontSize: 16 } } : {}),
      body: { x: 0.95, y: hasSubtitle ? 5.15 : 4.55, w: 11.5, h: 1.7, fontSize: 16 },
      accentLine: { x: 0.95, y: hasSubtitle ? 4.14 : 4.44, w: 1.6, h: 0.06 },
    };
  }

  if (layout === 'image') {
    const titleY = 0.52;
    const titleH = hasSubtitle ? 0.6 : 0.78;
    const accentY = titleY + titleH + (hasSubtitle ? 0.44 : 0.1);
    const imageY = accentY + 0.3;
    return {
      title: { x: 0.7, y: titleY, w: 11.93, h: titleH, fontSize: 28 },
      ...(hasSubtitle
        ? {
            subtitle: {
              x: 0.7,
              y: titleY + titleH + 0.08,
              w: 11.93,
              h: 0.38,
              fontSize: 15,
            },
          }
        : {}),
      accentLine: { x: 0.7, y: accentY, w: 2.2, h: 0.06 },
      body: { x: 0.7, y: 6.35, w: 11.93, h: 0.38, fontSize: 12 },
      image: { x: 0.7, y: imageY, w: 11.93, h: 6.15 - imageY },
    };
  }

  const textW = layout === 'content' && hasImage ? SLIDE_W / 2 - 0.7 : 11.93;
  const titleH = hasSubtitle ? 0.6 : 0.78;
  // 标题下压一点,给顶部那条强调线让位。
  const titleY = 0.52;
  const accentY = titleY + titleH + (hasSubtitle ? 0.44 : 0.1);
  const bodyY = accentY + 0.3;
  return {
    title: { x: 0.7, y: titleY, w: 11.93, h: titleH, fontSize: 28 },
    ...(hasSubtitle
      ? { subtitle: { x: 0.7, y: titleY + titleH + 0.08, w: textW, h: 0.38, fontSize: 15 } }
      : {}),
    // 强调线加粗到 0.06":原来 0.045" 在实机目检里几乎看不见,等于没有。
    accentLine: { x: 0.7, y: accentY, w: 2.2, h: 0.06 },
    body: {
      x: 0.7,
      y: bodyY,
      w: textW,
      h: SLIDE_H - bodyY - 0.75,
      fontSize: 18,
    },
    ...(layout === 'content' && hasImage
      ? {
          image: {
            x: SLIDE_W / 2 + 0.15,
            y: bodyY,
            w: SLIDE_W / 2 - 0.85,
            h: SLIDE_H - bodyY - 0.85,
          },
        }
      : {}),
  };
}

/**
 * 要点少时把字号放大去占住版面,而不是把文字推到页面中间。
 *
 * 先试过「要点 ≤5 条就垂直居中」——目检一看更糟:标题、强调线,然后**裂开一大条
 * 空白**才是正文,两块彻底断开。正确做法是让内容自己长大:三四条要点用 22pt,
 * 页面自然充实;条目多了退回 18pt 保证放得下。
 *
 * 返回的是字号,不是对齐 —— 正文一律顶着标题排。
 */
export function bodyFontSize(base: number, lineCount: number): number {
  if (lineCount <= 0) return base;
  if (lineCount <= 3) return base + 4;
  if (lineCount <= 5) return base + 2;
  return base;
}
