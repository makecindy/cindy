/**
 * cindy-docs/docxStyles.ts —— Word 的体面默认值:标题层级、封面、表格色带。
 *
 * 不嵌字体:OOXML 正文是 Unicode,中文字形由用户打开时的 Word / WPS / Pages 决定。
 * 这里只定字号、粗细、颜色、间距和表格铬件。
 */

import {
  AlignmentType,
  BorderStyle,
  Footer,
  HeadingLevel,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  ShadingType,
  TextRun,
  VerticalAlign,
  WidthType,
  type IParagraphStyleOptions,
  type ISectionOptions,
  type IStylesOptions,
  type ITableBordersOptions,
  type ParagraphChild,
} from 'docx';

import { formatDocsDate, type DocsTheme } from './themes.js';

const PAGE_TWIPS = { top: 1134, right: 1134, bottom: 1134, left: 1134 } as const;
/*
  封面上边距收回到 1 英寸 —— 顶部那条强调带要贴着版心上沿,压住整页;边距留 2 英寸
  的话带子悬在半空,压不住任何东西。标题块改由 COVER_TITLE_DROP_TWIPS 单独下压。
*/
const COVER_PAGE_TWIPS = { top: 1440, right: 1440, bottom: 1440, left: 1440 } as const;
/**
 * 标题块相对强调带再往下推多少(twips,1440 = 1 英寸)。
 *
 * A4 高 16838 twips。上边距 1 英寸 + 这里 2.3 英寸,标题落在离纸顶约 3.4 英寸处,
 * 即页面上三分之一 —— 视线的自然落点。落在纸的最上沿只会显得像一张便签。
 */
const COVER_TITLE_DROP_TWIPS = 3300;

function thinBorder(theme: DocsTheme): ITableBordersOptions {
  const edge = { style: BorderStyle.SINGLE, size: 4, color: theme.line, space: 0 };
  return {
    top: edge,
    bottom: edge,
    left: edge,
    right: edge,
    insideHorizontal: edge,
    insideVertical: edge,
  };
}

function headingStyle(
  id: string,
  name: string,
  size: number,
  color: string,
  before: number,
  after: number,
  outlineLevel: number,
): IParagraphStyleOptions {
  return {
    id,
    name,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    paragraph: { spacing: { before, after }, outlineLevel },
    run: { size, bold: true, color, font: 'Calibri' },
  };
}

export function docxDocumentStyles(theme: DocsTheme): IStylesOptions {
  return {
    default: {
      document: {
        run: { font: 'Calibri', size: 22, color: theme.body },
        paragraph: { spacing: { after: 160, line: 276 } },
      },
      title: {
        run: { size: 56, bold: true, color: theme.title, font: 'Calibri' },
        paragraph: { spacing: { after: 240 } },
      },
    },
    paragraphStyles: [
      headingStyle('Heading1', 'Heading 1', 32, theme.title, 360, 160, 0),
      headingStyle('Heading2', 'Heading 2', 26, theme.accent, 280, 120, 1),
      headingStyle('Heading3', 'Heading 3', 24, theme.title, 240, 100, 2),
      headingStyle('Heading4', 'Heading 4', 22, theme.body, 200, 80, 3),
      headingStyle('Heading5', 'Heading 5', 22, theme.muted, 180, 80, 4),
      headingStyle('Heading6', 'Heading 6', 20, theme.muted, 160, 80, 5),
    ],
  };
}

/**
 * 封面。
 *
 * 上一版是三段文字堆在页面顶端:小标题、大标题、日期,全落在上方 15%,底下 2/3
 * 是纯空白 —— 和 PPT 封面之前那个「白底加几行字」是同一个毛病,只有结构没有构图。
 * 目检一眼就能看出来,而「XML 里有 Title 样式」这种自检永远看不出来。
 *
 * 现在的构图:顶部一条实心强调带压住版面 → 标题块下压到上三分之一(读者视线的
 * 落点,不是纸的边缘)→ 日期沉到页脚。三样东西各就各位,页面才有重心。
 */
export function docxCoverSection(
  theme: DocsTheme,
  options: { title: string; subtitle?: string; date?: string },
): ISectionOptions {
  const date = options.date ?? formatDocsDate();
  const subtitle = options.subtitle?.trim() ?? '';
  return {
    properties: {
      page: { margin: COVER_PAGE_TWIPS },
    },
    // 日期沉到页脚才是真的在页底。原来它跟在标题下面,靠段间距悬在半空 ——
    // 标题一长就跟着往下挪,位置永远不稳。
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            children: [new TextRun({ text: date, color: theme.muted, size: 18 })],
          }),
        ],
      }),
    },
    children: [
      // 顶部实心强调带。用段落底纹画,不用边框 —— 边框只有线,填不出面积,
      // 而封面缺的正是面积(PPT 封面那次的结论一样)。
      new Paragraph({
        shading: { type: ShadingType.SOLID, fill: theme.accent, color: theme.accent },
        spacing: { after: 0, line: 240 },
        children: [new TextRun({ text: ' ', size: 16, color: theme.accent })],
      }),
      // 把标题块推到上三分之一。空段落 + 段前距,不用手数换行。
      new Paragraph({
        spacing: { before: COVER_TITLE_DROP_TWIPS, after: 0 },
        children: [],
      }),
      new Paragraph({
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 16, space: 8, color: theme.accent },
        },
        spacing: { after: 280 },
        children: [
          new TextRun({
            text: subtitle.length > 0 ? subtitle : ' ',
            color: theme.muted,
            size: 20,
          }),
        ],
      }),
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: options.title, color: theme.title })],
        spacing: { before: 200, after: 200 },
      }),
    ],
  };
}

export function docxBodySectionProperties(): ISectionOptions['properties'] {
  return {
    page: { margin: PAGE_TWIPS },
  };
}

export function docxBodyFooter(theme: DocsTheme): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            children: [PageNumber.CURRENT],
            color: theme.muted,
            size: 16,
          }),
        ],
      }),
    ],
  });
}

/**
 * 一列有多宽,按这一列真正要放的字数分。
 *
 * 不给列宽时 docx 生成的 `tblGrid` 每列都是 `w=100`,Word 只能按等分排 ——
 * 于是「严重度」这种只放「中 / 高」两个字的列,和「建议」那种要放一整句的列
 * 一样宽:一边空一大片,一边挤成三行。这是「表格很破」最常见的一种。
 *
 * 上下限是为了不让极端值毁掉版面:一列最少占 8%(再窄中文标题都竖排了),
 * 最多占 40%(再宽其余列就没法看了)。
 */
const MIN_COL_PCT = 8;
const MAX_COL_PCT = 40;

export function columnPercents(columnTextWidths: readonly number[]): number[] {
  const n = columnTextWidths.length;
  if (n === 0) return [];
  const floor = Math.min(MIN_COL_PCT, 100 / n);
  const ceil = Math.max(MAX_COL_PCT, 100 / n);
  const safe = columnTextWidths.map((w) => Math.max(1, w));
  const total = safe.reduce((a, b) => a + b, 0);
  const raw = safe.map((w) => Math.min(ceil, Math.max(floor, (w / total) * 100)));
  // 钳到上下限之后总和会偏离 100,按比例拉回去,免得表格宽度对不上。
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => Math.round((v / sum) * 1000) / 10);
}

export function styledDocxTable(
  theme: DocsTheme,
  rows: TableRow[],
  columnPercentages?: readonly number[],
): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: thinBorder(theme),
    ...(columnPercentages && columnPercentages.length > 0
      ? // docx 的 columnWidths 走 dxa;A4 正文宽约 9638 twips(11906 - 2×1134)。
        { columnWidths: columnPercentages.map((pct) => Math.round((pct / 100) * 9638)) }
      : {}),
    rows,
  });
}

export function styledDocxHeaderCell(
  theme: DocsTheme,
  children: ParagraphChild[],
  alignment?: (typeof AlignmentType)[keyof typeof AlignmentType],
): TableCell {
  return new TableCell({
    shading: { fill: theme.accent },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [
      new Paragraph({
        children,
        ...(alignment ? { alignment } : {}),
      }),
    ],
  });
}

export function styledDocxBodyCell(
  theme: DocsTheme,
  zebra: boolean,
  children: ParagraphChild[],
  alignment?: (typeof AlignmentType)[keyof typeof AlignmentType],
): TableCell {
  return new TableCell({
    shading: { fill: zebra ? theme.zebra : theme.background },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 50, bottom: 50, left: 80, right: 80 },
    children: [
      new Paragraph({
        children,
        ...(alignment ? { alignment } : {}),
      }),
    ],
  });
}
