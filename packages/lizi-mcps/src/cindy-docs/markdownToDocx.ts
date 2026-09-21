/**
 * cindy-docs/markdownToDocx.ts —— Markdown → docx 文档树。
 *
 * 链路:marked 只做词法解析(lexer,不生成 HTML),我们自己把 token 映射成 docx
 * 的段落/表格对象。不走「markdown → HTML → docx」是因为中间那层 HTML 会把
 * 结构信息压扁成样式,再还原回 Word 的语义样式(标题级别、列表编号、表格)就只能靠猜。
 *
 * 覆盖:标题(h1-h6)、段落、粗体/斜体/删除线、行内代码、链接、代码块、
 * 有序/无序列表(含嵌套)、表格、引用、分隔线,以及显式分页符约定
 * `<!-- pagebreak -->`(独占一行)。
 *
 * 未覆盖(有意):图片、脚注、HTML 内联。这些要么需要外部资源解析(与路径边界
 * 冲突),要么在 Word 里没有对应的语义结构;遇到时降级成纯文本,不静默丢内容。
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableRow,
  TextRun,
  ExternalHyperlink,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import { marked, type Token, type Tokens } from 'marked';

import {
  docxBodyFooter,
  docxBodySectionProperties,
  docxCoverSection,
  docxDocumentStyles,
  styledDocxBodyCell,
  styledDocxHeaderCell,
  styledDocxTable,
  columnPercents,
} from './docxStyles.js';
import {
  DEFAULT_DOCS_THEME,
  resolveDocsTheme,
  type DocsTheme,
  type DocsThemeName,
} from './themes.js';

/** 有序列表 numbering reference 的前缀;每个列表独立配置起始数字并重新编号。 */
const ORDERED_REF_PREFIX = 'cindy-docs-ordered';
const MONO_FONT = 'Courier New';

const HEADING_BY_DEPTH = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** 独占一行的分页符约定。大小写不敏感,允许注释内前后空格。 */
const PAGE_BREAK_RE = /^<!--\s*pagebreak\s*-->$/i;

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  color?: string;
}

/** 把 marked 的 inline token 递归摊成 docx run。未知类型降级为纯文本,不丢内容。 */
function inlineRuns(
  tokens: Token[] | undefined,
  theme: DocsTheme,
  style: InlineStyle = {},
): ParagraphChild[] {
  if (!tokens || tokens.length === 0) return [];
  const out: ParagraphChild[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        out.push(
          ...inlineRuns((token as Tokens.Strong).tokens, theme, {
            ...style,
            bold: true,
          }),
        );
        break;
      case 'em':
        out.push(
          ...inlineRuns((token as Tokens.Em).tokens, theme, {
            ...style,
            italics: true,
          }),
        );
        break;
      case 'del':
        out.push(
          ...inlineRuns((token as Tokens.Del).tokens, theme, {
            ...style,
            strike: true,
          }),
        );
        break;
      case 'codespan':
        out.push(
          new TextRun({
            text: (token as Tokens.Codespan).text,
            font: MONO_FONT,
            shading: { fill: theme.surface },
            ...style,
          }),
        );
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const children = inlineRuns(link.tokens, theme, style);
        out.push(
          new ExternalHyperlink({
            link: link.href,
            children:
              children.length > 0
                ? children
                : [new TextRun({ text: link.text ?? link.href, ...style })],
          }),
        );
        break;
      }
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'image': {
        // 图片不内嵌(要读外部字节,与路径边界冲突),降级成「alt (url)」文本,
        // 让用户至少知道这里原本有张图、图在哪。
        const image = token as Tokens.Image;
        const label = image.text && image.text.length > 0 ? image.text : image.href;
        out.push(new TextRun({ text: `[图片: ${label}]`, italics: true, ...style }));
        break;
      }
      default: {
        const nested = (token as { tokens?: Token[] }).tokens;
        if (nested && nested.length > 0) {
          out.push(...inlineRuns(nested, theme, style));
          break;
        }
        const text =
          (token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? '';
        if (text.length > 0) out.push(new TextRun({ text, ...style }));
        break;
      }
    }
  }
  return out;
}

/** 跨整篇文档共享的编号配置状态;每个有序列表保留自己的起始数字与编号引用。 */
interface BlockContext {
  theme: DocsTheme;
  nextOrderedListId: number;
  orderedLists: Array<{ reference: string; level: number; start: number }>;
}

function quoteParagraphStyle(theme: DocsTheme) {
  return {
    indent: { left: 360 },
    border: {
      left: {
        style: BorderStyle.SINGLE,
        size: 12,
        space: 8,
        color: theme.muted,
      },
    },
  } as const;
}

function listParagraphs(
  list: Tokens.List,
  depth: number,
  ctx: BlockContext,
): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  const level = Math.min(depth, 3);
  const orderedReference = list.ordered
    ? `${ORDERED_REF_PREFIX}-${ctx.nextOrderedListId++}`
    : undefined;
  if (orderedReference) {
    const start =
      Number.isInteger(list.start) && (list.start as number) >= 0 ? (list.start as number) : 1;
    ctx.orderedLists.push({ reference: orderedReference, level, start });
  }
  for (const item of list.items) {
    const numbering: IParagraphOptions['numbering'] = orderedReference
      ? { reference: orderedReference, level, instance: 0 }
      : undefined;
    const marker = numbering ? { numbering } : { bullet: { level } };
    let markerWritten = false;
    const writeMarker = (children: ParagraphChild[]): void => {
      out.push(new Paragraph({ children, ...marker, spacing: { after: 60 } }));
      markerWritten = true;
    };

    for (const child of item.tokens ?? []) {
      if (child.type === 'space') continue;
      if (child.type === 'list') {
        // 极端输入可以让列表项直接从子列表开始；仍需保留父级项目符号。
        if (!markerWritten) writeMarker([]);
        out.push(...listParagraphs(child as Tokens.List, depth + 1, ctx));
        continue;
      }
      if (!markerWritten && (child.type === 'paragraph' || child.type === 'text')) {
        const paragraph = child as Tokens.Paragraph;
        const children = inlineRuns(paragraph.tokens, ctx.theme);
        writeMarker(
          children.length > 0
            ? children
            : [new TextRun({ text: (child as { text?: string }).text ?? '' })],
        );
        continue;
      }
      if (!markerWritten) writeMarker([]);
      // 后续正文块各自保持独立段落，并留在嵌套列表前后的原始位置。
      out.push(...blocksFromTokens([child], ctx));
    }
    if (!markerWritten) writeMarker([]);
  }
  return out;
}

function codeParagraphs(code: Tokens.Code, theme: DocsTheme): Paragraph[] {
  const lines = code.text.split('\n');
  return lines.map(
    (line, index) =>
      new Paragraph({
        children: [
          new TextRun({
            // Word 会把空段落压成零高,补一个空格让代码块的空行仍然可见。
            text: line.length > 0 ? line : ' ',
            font: MONO_FONT,
            size: 20,
          }),
        ],
        shading: { fill: theme.surface },
        spacing: {
          before: index === 0 ? 120 : 0,
          after: index === lines.length - 1 ? 120 : 0,
        },
      }),
  );
}

function alignmentFor(
  align: 'center' | 'left' | 'right' | null,
): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  if (align === 'left') return AlignmentType.LEFT;
  return undefined;
}

/** 估算一格占多宽:CJK 与全角记两格,其余一格。与 make_xlsx 的口径一致。 */
function cellDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function tableBlock(table: Tokens.Table, theme: DocsTheme): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: table.header.map((cell, col) =>
      styledDocxHeaderCell(
        theme,
        inlineRuns(cell.tokens, theme, { bold: true, color: theme.accentOn }),
        alignmentFor(table.align?.[col] ?? null),
      ),
    ),
  });
  const bodyRows = table.rows.map(
    (row, rowIndex) =>
      new TableRow({
        children: row.map((cell, col) =>
          styledDocxBodyCell(
            theme,
            rowIndex % 2 === 1,
            inlineRuns(cell.tokens, theme),
            alignmentFor(table.align?.[col] ?? null),
          ),
        ),
      }),
  );
  /*
    列宽按这一列真正要放的字数分。量的是**纯文本**长度(CJK 记两格),不含加粗、
    链接这些不影响占位的修饰;表头也算进去,免得一个长表头被自己那列挤成两行。
  */
  const columnTextWidths = table.header.map((cell, col) => {
    const widths = [cellDisplayWidth(cell.text)];
    for (const row of table.rows) widths.push(cellDisplayWidth(row[col]?.text ?? ''));
    return Math.max(...widths);
  });
  return styledDocxTable(theme, [headerRow, ...bodyRows], columnPercents(columnTextWidths));
}

/** inQuote 单独传参而不是塞进 ctx:它是随递归深度变化的位置信息,不是文档级状态。 */
function blocksFromTokens(
  tokens: Token[],
  ctx: BlockContext,
  inQuote = false,
): Array<Paragraph | Table> {
  const quoteStyle = inQuote ? quoteParagraphStyle(ctx.theme) : {};
  const out: Array<Paragraph | Table> = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        const level = HEADING_BY_DEPTH[Math.min(Math.max(heading.depth, 1), 6) - 1]!;
        out.push(
          new Paragraph({
            heading: level,
            children: inlineRuns(heading.tokens, ctx.theme),
            spacing: { before: 240, after: 120 },
            ...quoteStyle,
          }),
        );
        break;
      }
      case 'paragraph':
      case 'text': {
        // blockquote 内的单行会被 marked 归成 'text' 而不是 'paragraph',
        // 两者同构处理,否则引用块只剩空段。
        const paragraph = token as Tokens.Paragraph;
        const children = inlineRuns(paragraph.tokens, ctx.theme);
        out.push(
          new Paragraph({
            children:
              children.length > 0
                ? children
                : [
                    new TextRun({
                      text: (token as { text?: string }).text ?? '',
                    }),
                  ],
            spacing: { after: 120 },
            ...quoteStyle,
          }),
        );
        break;
      }
      case 'list': {
        out.push(...listParagraphs(token as Tokens.List, 0, ctx));
        break;
      }
      case 'code':
        out.push(...codeParagraphs(token as Tokens.Code, ctx.theme));
        break;
      case 'table':
        out.push(tableBlock(token as Tokens.Table, ctx.theme));
        // Word 里表格紧跟正文会粘在一起,补一个空段落当间距。
        out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      case 'blockquote':
        out.push(...blocksFromTokens((token as Tokens.Blockquote).tokens ?? [], ctx, true));
        break;
      case 'hr':
        out.push(
          new Paragraph({
            children: [],
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                space: 1,
                color: ctx.theme.line,
              },
            },
            spacing: { before: 120, after: 120 },
          }),
        );
        break;
      case 'html': {
        const raw = ((token as Tokens.HTML).raw ?? '').trim();
        if (PAGE_BREAK_RE.test(raw)) {
          out.push(new Paragraph({ children: [new PageBreak()] }));
        } else if (raw.length > 0) {
          // 其它 HTML 不解释,原样落成文本,避免静默吞掉用户写的内容。
          out.push(new Paragraph({ children: [new TextRun({ text: raw })] }));
        }
        break;
      }
      case 'space':
        break;
      default: {
        const text = (token as { text?: string }).text ?? '';
        if (text.trim().length > 0) {
          out.push(new Paragraph({ children: [new TextRun({ text })], ...quoteStyle }));
        }
        break;
      }
    }
  }
  return out;
}

export interface MarkdownToDocxOptions {
  /** 文档标题:写进 core properties;cover=true 时做独立封面,否则插在正文最前。 */
  title?: string;
  /** 封面副题 / 密级 / 来源一行。 */
  subtitle?: string;
  /** 是否生成独立封面页。给了 title 时默认 true。 */
  cover?: boolean;
  theme?: DocsThemeName;
}

/** 把 Markdown 编成 .docx 字节。纯函数,不碰文件系统。 */
export async function markdownToDocxBuffer(
  markdown: string,
  options: MarkdownToDocxOptions = {},
): Promise<Buffer> {
  const theme = resolveDocsTheme(options.theme ?? DEFAULT_DOCS_THEME);
  const title = options.title?.trim() ?? '';
  const useCover = Boolean(title) && (options.cover ?? true);
  const tokens = marked.lexer(markdown ?? '');
  const ctx: BlockContext = { theme, nextOrderedListId: 0, orderedLists: [] };
  const body = blocksFromTokens(tokens, ctx);

  const children: Array<Paragraph | Table> = [];
  if (title.length > 0 && !useCover) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: title, color: theme.title })],
        spacing: { after: 240 },
      }),
    );
  }
  children.push(...body);
  if (children.length === 0) {
    children.push(new Paragraph({ children: [] }));
  }

  const bodySection = {
    properties: docxBodySectionProperties(),
    footers: { default: docxBodyFooter(theme) },
    children,
  };

  const doc = new Document({
    ...(title.length > 0 ? { title } : {}),
    background: { color: theme.background },
    styles: docxDocumentStyles(theme),
    numbering: {
      config: ctx.orderedLists.map(({ reference, level: startLevel, start }) => ({
        reference,
        levels: [0, 1, 2, 3].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          ...(level === startLevel ? { start } : {}),
          style: {
            paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
          },
        })),
      })),
    },
    sections: useCover
      ? [
          docxCoverSection(theme, {
            title,
            ...(options.subtitle ? { subtitle: options.subtitle } : {}),
          }),
          bodySection,
        ]
      : [bodySection],
  });
  return Packer.toBuffer(doc);
}
