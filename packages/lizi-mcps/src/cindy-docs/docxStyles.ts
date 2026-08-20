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
const COVER_PAGE_TWIPS = { top: 2880, right: 1440, bottom: 1440, left: 1440 } as const;

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
    children: [
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
      new Paragraph({
        children: [new TextRun({ text: date, color: theme.muted, size: 20 })],
        spacing: { before: 80 },
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

export function styledDocxTable(theme: DocsTheme, rows: TableRow[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: thinBorder(theme),
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
