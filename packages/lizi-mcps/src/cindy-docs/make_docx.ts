/**
 * cindy-docs/make_docx.ts —— Markdown → Word(.docx)。
 *
 * 结构化生成(marked lexer → docx 对象树),不是「打印成 PDF 再改名」:出来的
 * 是真 Word 文档,标题进导航窗格、表格能选中、列表能续编号,用户可以接着改。
 */

import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  assertOutputExtension,
  describeOutput,
  DocsPathError,
  prepareOutputPath,
  resolveSessionRoot,
} from './_paths.js';
import { artifactMetadata, errorPayload, okPayload } from './_payload.js';
import { markdownToDocxBuffer } from './markdownToDocx.js';
import type { DocsMcpSessionCtx, WriteDocsOutputFn } from './types.js';

export const DOCX_MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
export const DOCX_MAX_TITLE_BYTES = 4 * 1024;
export const DOCX_MAX_SUBTITLE_BYTES = 16 * 1024;

function utf8BoundedString(maxBytes: number, label: string): z.ZodString {
  return z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, {
    message: `${label}超过 ${(maxBytes / 1024).toFixed(0)} KiB 上限`,
  });
}

const DESCRIPTION = [
  '把 Markdown 正文生成为真正的 Word 文档(.docx)。',
  '',
  '【何时用】用户要 Word / doc / 「可编辑的文档」/ 需要交给别人接着改的正式文稿。',
  '只要产物要给人二次编辑,就用本工具,不要生成 PDF 再让用户想办法转回去。',
  '',
  '【支持的 Markdown】标题 #~######、段落、**粗体**、*斜体*、~~删除线~~、`行内代码`、',
  '```代码块```、有序/无序列表(含嵌套)、表格(支持列对齐)、> 引用、--- 分隔线、链接。',
  '图片不内嵌,会降级成 "[图片: 说明]" 文本。',
  '',
  '【分页】需要强制分页时,在 Markdown 里单独写一行 `<!-- pagebreak -->`。',
  '',
  '【版式】给了 title 默认出独立封面(可用 cover:false 关掉);subtitle 写在封面强调线上方。',
  'theme: "light"(默认) / "dark" / "navy"。标题层级、表格色带/斑马纹、正文页脚页码都已内置,',
  '不需要为了好看去写 HTML。',
  '',
  '【输出】outPath 必须在本任务的工作目录内(建议 documents/ 子目录,文件名带日期)。',
  '目录不存在会自动创建;同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
  'Markdown 正文最大 4 MB；超限时请拆成多份文档。',
].join('\n');

export function registerMakeDocxTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  writeDocsOutput: WriteDocsOutputFn,
): void {
  registry.register({
    name: 'make_docx',
    category: 'author',
    description: DESCRIPTION,
    inputShape: {
      markdown: utf8BoundedString(DOCX_MAX_MARKDOWN_BYTES, 'Markdown 正文')
        .min(1)
        .describe('文档正文(Markdown),UTF-8 最大 4 MB。'),
      outPath: z
        .string()
        .min(1)
        .describe(
          '输出 .docx 路径,工作目录内的相对路径或绝对路径,如 documents/报告-2026-08-19.docx。',
        ),
      title: utf8BoundedString(DOCX_MAX_TITLE_BYTES, '文档标题')
        .optional()
        .describe('可选文档标题:写进 Word 文档属性;默认再生成一页封面。'),
      subtitle: utf8BoundedString(DOCX_MAX_SUBTITLE_BYTES, '文档副题')
        .optional()
        .describe('封面副题 / 密级 / 来源一行。没给 title 时无效。'),
      cover: z
        .boolean()
        .optional()
        .describe('是否生成独立封面页。给了 title 时默认 true;没给 title 时无效。'),
      theme: z
        .enum(['light', 'dark', 'navy'])
        .default('light')
        .describe('配色主题:light / dark / navy。影响标题色、表头色带和斑马纹。'),
      overwrite: z
        .boolean()
        .default(false)
        .describe('目标文件已存在时是否覆盖。默认 false(存在即报 FILE_EXISTS)。'),
    },
    handler: async ({ markdown, outPath, title, subtitle, cover, theme, overwrite }) => {
      try {
        const root = resolveSessionRoot(sessionCtx);
        assertOutputExtension(outPath, '.docx');
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const trimmedTitle = title?.trim() ?? '';
        const useCover = trimmedTitle.length > 0 && (cover ?? true);
        const buffer = await markdownToDocxBuffer(markdown, {
          theme,
          cover: useCover,
          ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
          ...(subtitle ? { subtitle } : {}),
        });
        await writeDocsOutput({ root, path: abs, data: buffer, overwrite });
        return okPayload({
          ...describeOutput(root, abs, buffer.byteLength),
          format: 'docx',
          theme,
          cover: useCover,
          artifact: artifactMetadata({
            format: 'docx',
            ...(trimmedTitle ? { title: trimmedTitle } : {}),
            ...(subtitle?.trim() ? { subtitle: subtitle.trim() } : {}),
            theme,
            cover: useCover,
            summary: { kind: 'bytes', value: buffer.byteLength },
          }),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorPayload('DOCX_BUILD_FAILED', `生成 Word 文档失败:${message}`, { message });
      }
    },
  });
}
