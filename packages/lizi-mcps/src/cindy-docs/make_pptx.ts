/**
 * cindy-docs/make_pptx.ts —— 结构化幻灯片 → PowerPoint(.pptx)。
 *
 * 版式走 pptxgenjs 母版(封面 / 分节 / 内容页),色板走 themes.ts。模型只选命名
 * 主题和版式,不喂色号、不捆图片字体。页脚页码登记在母版上,由 PowerPoint 自己递增。
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
  writeOutputFile,
} from './_paths.js';
import { errorPayload, okPayload } from './_payload.js';
import {
  bodyFontSize,
  DEFAULT_PPTX_LAYOUT,
  defineCindyPptxMasters,
  layoutSlots,
  PPTX_LAYOUT_IDS,
  PPTX_LAYOUT_NAMES,
  type PptxLayoutName,
} from './pptxMasters.js';
import { DOCS_THEMES, resolveDocsTheme, type DocsThemeName } from './themes.js';
import type { DocsMcpSessionCtx } from './types.js';

/** 主题色板对外可见,让测试断言真实取值而不是硬编码色号(实现漂移能被测出来)。 */
export const PPTX_THEMES = DOCS_THEMES;

export {
  DEFAULT_PPTX_LAYOUT,
  PPTX_LAYOUT_IDS,
  PPTX_LAYOUT_NAMES,
} from './pptxMasters.js';

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
  '【每页可给】title(标题,必填)、layout(cover 封面 / section 分节 / content 内容页,默认 content)、',
  'subtitle(封面副题或分节导语)、bullets(要点数组)、body(整段正文)、',
  'notes(演讲者备注,只在演讲者视图可见)、imagePath(工作目录内的 png / jpg / gif,内容页放右半区)。',
  '',
  '【主题】theme: "light"(浅色,默认,适合打印和明亮会议室)、"dark"(深色,适合投影)、',
  '"navy"(商务蓝,适合正式汇报)。三套都是克制色板,不要指望自定义配色。',
  '',
  '【版式】封面大标题 + 左侧强调条、无页码;分节页中部标题 + 页脚页码;内容页标题短线 + 要点 + 页脚页码。',
  'footer 默认 true,会在分节/内容页显示页脚标签(用 title)和页码;封面始终不显示页码。',
  '',
  '【写作建议】每页 3-5 条要点、每条一行以内;标题写结论而不是名词短语。首页用 cover,章节切换用 section。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const SlideSchema = z.object({
  title: z.string().min(1).describe('本页标题。'),
  layout: z
    .enum(PPTX_LAYOUT_NAMES)
    .default(DEFAULT_PPTX_LAYOUT)
    .describe('版式:cover 封面 / section 分节 / content 内容页。默认 content。'),
  subtitle: z.string().optional().describe('封面副题、分节导语或内容页标题下的一行说明。'),
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
      title: z.string().optional().describe('可选演示文稿标题,写进文件属性,并作为页脚标签。'),
      theme: z
        .enum(['light', 'dark', 'navy'])
        .default('light')
        .describe('配色主题:light / dark / navy。'),
      footer: z
        .boolean()
        .default(true)
        .describe('分节页和内容页是否显示页脚与页码。封面始终不显示页码。默认 true。'),
      overwrite: z.boolean().default(false).describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({ slides, outPath, title, theme, footer, overwrite }) => {
      try {
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const palette = resolveDocsTheme(theme as DocsThemeName);

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
        // **不是 LAYOUT_16x9**:那个在 pptxgenjs 里是 10" × 5.625",而 pptxMasters 的
        // 几何常量按 13.333" × 7.5" 写(现代 PowerPoint 的宽屏默认)。两边对不上的
        // 后果不是「小一点」——页脚与页码定位在 y=7.02,整个落在页面外,**从来没
        // 显示过**;正文框也伸出页底,长内容会被裁掉。LAYOUT_WIDE 才是 13.33 × 7.5。
        pptx.layout = 'LAYOUT_WIDE';
        if (title) pptx.title = title;
        pptx.author = 'Cindy';

        defineCindyPptxMasters(pptx, {
          theme: palette,
          footer,
          ...(title ? { footerLabel: title } : {}),
        });

        const usedLayouts: PptxLayoutName[] = [];
        for (const [index, slide] of slides.entries()) {
          const layout: PptxLayoutName = slide.layout ?? DEFAULT_PPTX_LAYOUT;
          usedLayouts.push(layout);
          const page = pptx.addSlide({ masterName: PPTX_LAYOUT_IDS[layout] });
          // 幻灯片自己再刷一次底色:母版底色在 slideLayout 里,测试和解压器读 slide XML
          // 时也能直接看到主题色,两边不一致就说明登记错了。
          page.background = { color: palette.background };

          const imageAbs = imageAbsByIndex.get(index);
          const subtitle = slide.subtitle?.trim() ?? '';
          const slots = layoutSlots(layout, {
            hasImage: Boolean(imageAbs),
            hasSubtitle: subtitle.length > 0,
          });

          page.addText(slide.title, {
            x: slots.title.x,
            y: slots.title.y,
            w: slots.title.w,
            h: slots.title.h,
            fontSize: slots.title.fontSize,
            bold: true,
            color: palette.title,
            valign: layout === 'content' ? 'middle' : 'top',
            margin: 0,
          });

          if (slots.subtitle && subtitle.length > 0) {
            page.addText(subtitle, {
              x: slots.subtitle.x,
              y: slots.subtitle.y,
              w: slots.subtitle.w,
              h: slots.subtitle.h,
              fontSize: slots.subtitle.fontSize,
              color: palette.muted,
              valign: 'top',
              margin: 0,
            });
          }

          if (slots.accentLine) {
            page.addShape('rect', {
              x: slots.accentLine.x,
              y: slots.accentLine.y,
              w: slots.accentLine.w,
              h: slots.accentLine.h,
              fill: { color: palette.accent },
              line: { color: palette.accent, width: 0 },
            });
          }

          const hasBullets = Boolean(slide.bullets && slide.bullets.length > 0);
          const hasBody = Boolean(slide.body && slide.body.trim().length > 0);
          if (hasBullets || hasBody) {
            const bulletBlockH = hasBullets
              ? Math.min(slots.body.h * 0.72, 0.42 * (slide.bullets?.length ?? 0) + 0.25)
              : 0;
            if (hasBullets) {
              page.addText(
                slide.bullets!.map((text) => ({
                  text,
                  options: { bullet: true, breakLine: true },
                })),
                {
                  x: slots.body.x,
                  y: slots.body.y,
                  w: slots.body.w,
                  h: hasBody ? bulletBlockH : slots.body.h,
                  // 要点少就放大字号占住版面(见 bodyFontSize)。正文一律顶着标题排 ——
                  // 试过垂直居中,目检下来标题与正文之间裂开一条空白,更糟。
                  fontSize: hasBody
                    ? slots.body.fontSize
                    : bodyFontSize(slots.body.fontSize, slide.bullets?.length ?? 0),
                  color: palette.body,
                  // 行距放到 1.5:1.3 在实机目检里几行要点糊成一坨,读起来很挤。
                  lineSpacingMultiple: 1.5,
                  valign: 'top',
                  margin: 0,
                },
              );
            }
            if (hasBody) {
              const bodyY = hasBullets ? slots.body.y + bulletBlockH + 0.12 : slots.body.y;
              page.addText(slide.body!.trim(), {
                x: slots.body.x,
                y: bodyY,
                w: slots.body.w,
                h: Math.max(0.6, slots.body.y + slots.body.h - bodyY),
                fontSize: Math.max(13, slots.body.fontSize - 3),
                color: palette.muted,
                lineSpacingMultiple: 1.35,
                valign: 'top',
                margin: 0,
              });
            }
          }

          if (imageAbs && slots.image) {
            page.addImage({
              path: imageAbs,
              x: slots.image.x,
              y: slots.image.y,
              w: slots.image.w,
              h: slots.image.h,
              sizing: { type: 'contain', w: slots.image.w, h: slots.image.h },
            });
          }
          if (slide.notes && slide.notes.length > 0) page.addNotes(slide.notes);
        }

        const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
        await writeOutputFile(abs, buffer, overwrite);
        return okPayload({
          ...(await describeOutput(root, abs)),
          format: 'pptx',
          theme,
          footer,
          slides: slides.length,
          layouts: usedLayouts,
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
