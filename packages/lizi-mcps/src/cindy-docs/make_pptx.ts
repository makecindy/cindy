/**
 * cindy-docs/make_pptx.ts —— 结构化幻灯片 → PowerPoint(.pptx)。
 *
 * 主题只给浅、深两套,且都很克制(一条标题分隔线 + 一种强调色)。理由:模型自由
 * 配色几乎必然出车祸(对比度不足、七种色号混用),而汇报场景真正要的是「不丑、
 * 能投出去」。两套主题都在浅底/深底投影仪上验证过对比度。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import pptxgen from 'pptxgenjs';
import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  describeOutput,
  DocsPathError,
  prepareInputPath,
  prepareOutputPath,
  resolveSessionRoot,
} from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import type { DocsMcpSessionCtx } from './types.js';

interface PptTheme {
  background: string;
  title: string;
  body: string;
  accent: string;
  muted: string;
}

const THEMES: Record<'light' | 'dark', PptTheme> = {
  light: {
    background: 'FFFFFF',
    title: '1B1F24',
    body: '2E3440',
    accent: '2F6FEB',
    muted: '6B7280',
  },
  dark: {
    background: '14181D',
    title: 'F5F7FA',
    body: 'D6DBE3',
    accent: '6AA6FF',
    muted: '9AA3B0',
  },
};

/** 16:9 版面(英寸)。留白按 0.6" 边距,标题区独立在上方。 */
const SLIDE_W = 13.333;
const MARGIN = 0.7;
const TITLE_Y = 0.55;
const TITLE_H = 0.9;
const BODY_Y = 1.75;

/** 主题色板对外可见,让测试断言真实取值而不是硬编码色号(实现漂移能被测出来)。 */
export const PPTX_THEMES = THEMES;

/**
 * pptxgenjs 按扩展名决定内嵌资源的 content-type,不认的格式会生成一个 PowerPoint
 * 打不开的坏包。支持面在这里登记一次,工具描述与运行期校验共用。
 */
export const PPTX_SUPPORTED_IMAGE_EXT: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
]);

export function isSupportedPptxImage(filePath: string): boolean {
  return PPTX_SUPPORTED_IMAGE_EXT.has(path.extname(filePath).toLowerCase());
}

const DESCRIPTION = [
  '把结构化的幻灯片内容生成为 PowerPoint 演示文稿(.pptx)。',
  '',
  '【何时用】用户要 PPT / 演示文稿 / 汇报材料 / 「几页讲清楚」。',
  '',
  '【每页可给】title(标题,必填)、bullets(要点数组)、body(整段正文,与 bullets 二选一或并存)、',
  'notes(演讲者备注,只在演讲者视图可见)、imagePath(工作目录内的 png / jpg / gif,放在右半区)。',
  '',
  '【主题】theme: "light"(浅色,默认,适合打印和明亮会议室)或 "dark"(深色,适合投影)。',
  '两套主题都是克制排版,不要指望自定义配色 —— 需要精细版式请改用 render_pdf 出 PDF。',
  '',
  '【写作建议】每页 3-5 条要点、每条一行以内;标题写结论而不是名词短语。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const SlideSchema = z.object({
  title: z.string().min(1).describe('本页标题。'),
  bullets: z.array(z.string()).optional().describe('要点数组,建议 3-5 条。'),
  body: z.string().optional().describe('整段正文。与 bullets 可并存(正文排在要点之后)。'),
  notes: z.string().optional().describe('演讲者备注。'),
  imagePath: z
    .string()
    .optional()
    .describe('工作目录内的图片路径(png/jpg/gif)。给了图,文字会收窄到左半区。'),
});

export function registerMakePptxTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
): void {
  registry.register({
    name: 'make_pptx',
    category: 'author',
    description: DESCRIPTION,
    inputShape: {
      slides: z.array(SlideSchema).min(1).describe('幻灯片列表,至少一页。'),
      outPath: z.string().min(1).describe('输出 .pptx 路径,工作目录内的相对路径或绝对路径。'),
      title: z.string().optional().describe('可选演示文稿标题,写进文件属性。'),
      theme: z.enum(['light', 'dark']).default('light').describe('配色主题。'),
      overwrite: z.boolean().default(false).describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({ slides, outPath, title, theme, overwrite }) => {
      try {
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const palette = THEMES[theme];

        // 图片路径先全部过边界闸再开始生成:与其出到第三页才失败留下半成品,
        // 不如一次性告诉模型哪张图不行。
        const imageAbsByIndex = new Map<number, string>();
        for (const [index, slide] of slides.entries()) {
          if (!slide.imagePath) continue;
          const imageAbs = await prepareInputPath(root, slide.imagePath);
          // pptxgenjs 只按扩展名决定内嵌的 content-type,喂个 .webp 进去会生成一个
          // PowerPoint 打不开的坏包 —— 那正是「看着成功、其实交了坏文件」,必须先拦。
          if (!isSupportedPptxImage(imageAbs)) {
            return errorPayload(
              'UNSUPPORTED_IMAGE',
              `第 ${index + 1} 页的图片格式不支持。演示文稿只能内嵌 ${[...PPTX_SUPPORTED_IMAGE_EXT].join(' / ')};请先把它转成 PNG 或 JPG。`,
              { slide: index + 1, imagePath: imageAbs },
            );
          }
          imageAbsByIndex.set(index, imageAbs);
        }

        const pptx = new pptxgen();
        pptx.layout = 'LAYOUT_16x9';
        if (title) pptx.title = title;
        pptx.author = 'Cindy';

        for (const [index, slide] of slides.entries()) {
          const page = pptx.addSlide();
          page.background = { color: palette.background };

          const imageAbs = imageAbsByIndex.get(index);
          const textW = imageAbs ? SLIDE_W / 2 - MARGIN : SLIDE_W - MARGIN * 2;

          page.addText(slide.title, {
            x: MARGIN,
            y: TITLE_Y,
            w: SLIDE_W - MARGIN * 2,
            h: TITLE_H,
            fontSize: 28,
            bold: true,
            color: palette.title,
            valign: 'middle',
          });
          // 标题下的强调分隔线:唯一的装饰元素,靠它把标题区与正文区分开。
          page.addShape('line', {
            x: MARGIN,
            y: TITLE_Y + TITLE_H + 0.08,
            w: 1.6,
            h: 0,
            line: { color: palette.accent, width: 3 },
          });

          let cursorY = BODY_Y;
          if (slide.bullets && slide.bullets.length > 0) {
            page.addText(
              slide.bullets.map((text) => ({
                text,
                options: { bullet: true, breakLine: true },
              })),
              {
                x: MARGIN,
                y: cursorY,
                w: textW,
                h: 4.2,
                fontSize: 18,
                color: palette.body,
                lineSpacingMultiple: 1.3,
                valign: 'top',
              },
            );
            cursorY += Math.min(4.2, 0.42 * slide.bullets.length + 0.3);
          }
          if (slide.body && slide.body.trim().length > 0) {
            page.addText(slide.body, {
              x: MARGIN,
              y: cursorY,
              w: textW,
              h: Math.max(0.8, 6.4 - cursorY),
              fontSize: 15,
              color: palette.muted,
              lineSpacingMultiple: 1.35,
              valign: 'top',
            });
          }
          if (imageAbs) {
            page.addImage({
              path: imageAbs,
              x: SLIDE_W / 2 + 0.2,
              y: BODY_Y,
              w: SLIDE_W / 2 - MARGIN - 0.2,
              h: 4.2,
              sizing: { type: 'contain', w: SLIDE_W / 2 - MARGIN - 0.2, h: 4.2 },
            });
          }
          if (slide.notes && slide.notes.length > 0) page.addNotes(slide.notes);
        }

        const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
        await fs.writeFile(abs, buffer);
        return okPayload({
          ...(await describeOutput(root, abs)),
          format: 'pptx',
          theme,
          slides: slides.length,
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorPayload('PPTX_BUILD_FAILED', `生成演示文稿失败:${message}`, { message });
      }
    },
  });
}
