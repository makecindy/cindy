/**
 * cindy-docs/make_pptx.ts —— 结构化幻灯片 → PowerPoint(.pptx)。
 *
 * 版式走 pptxgenjs 母版(封面 / 分节 / 内容 / 对比 / 指标 / 大图),色板走 themes.ts。
 * 模型只选命名主题和结构化版式,不喂色号、不喂自由坐标、不捆图片字体。页脚页码
 * 登记在母版上,由 PowerPoint 自己递增。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as pptxgenModule from 'pptxgenjs';
import type pptxgen from 'pptxgenjs';
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
import { artifactMetadata, errorPayload, okPayload } from './_payload.js';
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

type PptxGenConstructor = new () => pptxgen;

/**
 * pptxgenjs 是 CommonJS 包：Vitest / 打包后 ESM 会直接给构造器，tsx 按源码
 * 运行时可能给一层或两层 default wrapper。只写 default import 会让
 * 单测通过、真实工具运行却在 `new` 处失败。这里做有界的 CJS/ESM 归一。
 */
export function resolvePptxGenConstructor(moduleValue: unknown): PptxGenConstructor {
  let candidate = moduleValue;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== 'object' || !('default' in candidate)) break;
    candidate = (candidate as { default: unknown }).default;
  }
  if (typeof candidate !== 'function') {
    throw new TypeError('pptxgenjs did not expose a constructor');
  }
  return candidate as PptxGenConstructor;
}

const DESCRIPTION = [
  '把结构化的幻灯片内容生成为 PowerPoint 演示文稿(.pptx)。',
  '',
  '【何时用】用户要 PPT / 演示文稿 / 汇报材料 / 「几页讲清楚」。',
  '',
  '【每页可给】title(标题,必填)、layout(cover 封面 / section 分节 / content 内容 / comparison 双栏对比 / metrics 数据强调 / image 大图,默认 content)、',
  'subtitle(封面副题或分节导语)、bullets(要点数组)、body(整段正文)、',
  'notes(演讲者备注,只在演讲者视图可见)、imagePath(工作目录内的 png / jpg / gif)。',
  'comparison 必须给 columns(恰好两栏,每栏含 title + bullets/body);metrics 必须给 metrics(2–4 个 value + label + 可选 detail);image 必须给 imagePath,图片会自动裁切铺满主体区,body 可作题注。',
  '',
  '【主题】theme: "light"(浅色,默认,适合打印和明亮会议室)、"dark"(深色,适合投影)、',
  '"navy"(商务蓝,适合正式汇报)。三套都是克制色板,不要指望自定义配色。',
  '',
  '【版式】封面、分节和普通内容页用于叙事骨架;真正的左右比较用 comparison;关键数字用 metrics;一张图承担主体时用 image。',
  'footer 默认 true,会在分节页和除封面外的内容类页面显示页脚标签(用 title)和页码;封面始终不显示页码。',
  '',
  '【写作建议】每页只表达一个结论;标题写结论而不是名词短语。首页用 cover,章节切换用 section,不要把“左右对比”或“核心数据”硬塞成普通要点。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const ComparisonColumnSchema = z.object({
  title: z.string().min(1).describe('这一栏的短标题。'),
  bullets: z.array(z.string().min(1)).max(5).optional().describe('这一栏的 1–5 条要点。'),
  body: z.string().optional().describe('这一栏的补充正文。'),
});

const MetricSchema = z.object({
  value: z.union([z.string(), z.number()]).describe('醒目的指标值,如 98% 或 4。'),
  label: z.string().min(1).describe('指标名称。'),
  detail: z.string().optional().describe('一句口径或解释。'),
});

const SlideSchema = z
  .object({
    title: z.string().min(1).describe('本页标题。'),
    layout: z
      .enum(PPTX_LAYOUT_NAMES)
      .default(DEFAULT_PPTX_LAYOUT)
      .describe(
        '版式:cover 封面 / section 分节 / content 内容 / comparison 双栏对比 / metrics 数据强调 / image 大图。默认 content。',
      ),
    subtitle: z.string().optional().describe('封面副题、分节导语或内容页标题下的一行说明。'),
    bullets: z.array(z.string()).optional().describe('要点数组,建议 3-5 条。'),
    body: z.string().optional().describe('整段正文。与 bullets 可并存(正文排在要点之后)。'),
    notes: z.string().optional().describe('演讲者备注。'),
    imagePath: z.string().optional().describe('工作目录内的图片路径(png/jpg/gif)。content 放右半区,image 放通栏主体。'),
    columns: z
      .array(ComparisonColumnSchema)
      .length(2)
      .optional()
      .describe('comparison 专用的两栏内容。固定两栏,不接收坐标。'),
    metrics: z.array(MetricSchema).min(2).max(4).optional().describe('metrics 专用的 2–4 个指标卡。'),
  })
  .superRefine((slide, ctx) => {
    if (slide.layout === 'comparison' && !slide.columns) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns'],
        message: 'comparison 版式需要恰好两栏 columns。',
      });
    }
    if (slide.layout === 'metrics' && !slide.metrics) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics'],
        message: 'metrics 版式需要 2–4 个 metrics。',
      });
    }
    if (slide.layout === 'image' && !slide.imagePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imagePath'],
        message: 'image 版式需要 imagePath。',
      });
    }
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
      outPath: z
        .string()
        .min(1)
        .describe('输出 .pptx 路径,工作目录内的相对路径或绝对路径。'),
      title: z
        .string()
        .optional()
        .describe('可选演示文稿标题,写进文件属性,并作为页脚标签。'),
      theme: z
        .enum(['light', 'dark', 'navy'])
        .default('light')
        .describe('配色主题:light / dark / navy。'),
      footer: z
        .boolean()
        .default(true)
        .describe('分节页和除封面外的内容类页面是否显示页脚与页码。封面始终不显示页码。默认 true。'),
      overwrite: z
        .boolean()
        .default(false)
        .describe('目标文件已存在时是否覆盖。默认 false。'),
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

        const PptxGen = resolvePptxGenConstructor(pptxgenModule);
        const pptx = new PptxGen();
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
            valign: layout === 'cover' || layout === 'section' ? 'top' : 'middle',
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

          if (layout === 'comparison') {
            const columns = slide.columns ?? [];
            const gap = 0.36;
            const cardW = (slots.body.w - gap) / 2;
            for (const [columnIndex, column] of columns.entries()) {
              const x = slots.body.x + columnIndex * (cardW + gap);
              page.addShape('rect', {
                x,
                y: slots.body.y,
                w: cardW,
                h: slots.body.h,
                fill: { color: palette.surface },
                line: { color: palette.line, width: 1 },
              });
              page.addShape('rect', {
                x,
                y: slots.body.y,
                w: cardW,
                h: 0.08,
                fill: { color: palette.accent },
                line: { color: palette.accent, width: 0 },
              });
              page.addText(column.title, {
                x: x + 0.34,
                y: slots.body.y + 0.34,
                w: cardW - 0.68,
                h: 0.5,
                fontSize: 20,
                bold: true,
                color: palette.title,
                margin: 0,
              });
              const columnBullets = column.bullets ?? [];
              if (columnBullets.length > 0) {
                page.addText(
                  columnBullets.map((text) => ({
                    text,
                    options: { bullet: true, breakLine: true },
                  })),
                  {
                    x: x + 0.34,
                    y: slots.body.y + 1.05,
                    w: cardW - 0.68,
                    h: column.body ? slots.body.h - 2.15 : slots.body.h - 1.4,
                    fontSize: bodyFontSize(16, columnBullets.length),
                    color: palette.body,
                    lineSpacingMultiple: 1.35,
                    valign: 'top',
                    margin: 0,
                  },
                );
              }
              if (column.body?.trim()) {
                page.addText(column.body.trim(), {
                  x: x + 0.34,
                  y: slots.body.y + slots.body.h - 0.92,
                  w: cardW - 0.68,
                  h: 0.58,
                  fontSize: 13,
                  color: palette.muted,
                  margin: 0,
                  valign: 'bottom',
                });
              }
            }
          } else if (layout === 'metrics') {
            const metrics = slide.metrics ?? [];
            const columns = metrics.length <= 3 ? metrics.length : 2;
            const rows = Math.ceil(metrics.length / columns);
            const gapX = 0.3;
            const gapY = 0.28;
            const cardW = (slots.body.w - gapX * (columns - 1)) / columns;
            const cardH = (slots.body.h - gapY * (rows - 1)) / rows;
            for (const [metricIndex, metric] of metrics.entries()) {
              const column = metricIndex % columns;
              const row = Math.floor(metricIndex / columns);
              const x = slots.body.x + column * (cardW + gapX);
              const y = slots.body.y + row * (cardH + gapY);
              page.addShape('rect', {
                x,
                y,
                w: cardW,
                h: cardH,
                fill: { color: palette.surface },
                line: { color: palette.line, width: 1 },
              });
              page.addText(String(metric.value), {
                x: x + 0.3,
                y: y + 0.36,
                w: cardW - 0.6,
                h: Math.min(0.95, cardH * 0.4),
                fontSize: metrics.length <= 3 ? 32 : 27,
                bold: true,
                color: palette.accent,
                margin: 0,
              });
              page.addText(metric.label, {
                x: x + 0.3,
                y: y + Math.min(1.36, cardH * 0.48),
                w: cardW - 0.6,
                h: 0.42,
                fontSize: 16,
                bold: true,
                color: palette.title,
                margin: 0,
              });
              if (metric.detail?.trim()) {
                page.addText(metric.detail.trim(), {
                  x: x + 0.3,
                  y: y + Math.min(1.92, cardH * 0.7),
                  w: cardW - 0.6,
                  h: Math.max(0.36, cardH * 0.22),
                  fontSize: 12,
                  color: palette.muted,
                  margin: 0,
                  valign: 'top',
                });
              }
            }
          } else if (layout === 'image') {
            if (imageAbs && slots.image) {
              page.addShape('rect', {
                x: slots.image.x,
                y: slots.image.y,
                w: slots.image.w,
                h: slots.image.h,
                fill: { color: palette.surface },
                line: { color: palette.line, width: 1 },
              });
              page.addImage({
                path: imageAbs,
                x: slots.image.x,
                y: slots.image.y,
                w: slots.image.w,
                h: slots.image.h,
                sizing: { type: 'cover', w: slots.image.w, h: slots.image.h },
              });
            }
            if (slide.body?.trim()) {
              page.addText(slide.body.trim(), {
                x: slots.body.x,
                y: slots.body.y,
                w: slots.body.w,
                h: slots.body.h,
                fontSize: slots.body.fontSize,
                color: palette.muted,
                align: 'right',
                margin: 0,
              });
            }
          } else {
            const hasBullets = Boolean(slide.bullets && slide.bullets.length > 0);
            const hasBody = Boolean(slide.body && slide.body.trim().length > 0);
            if (hasBullets || hasBody) {
              const bulletBlockH = hasBullets
                ? Math.min(
                    slots.body.h * 0.72,
                    0.42 * (slide.bullets?.length ?? 0) + 0.25,
                  )
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
                      : bodyFontSize(
                          slots.body.fontSize,
                          slide.bullets?.length ?? 0,
                        ),
                    color: palette.body,
                    // 行距放到 1.5:1.3 在实机目检里几行要点糊成一坨,读起来很挤。
                    lineSpacingMultiple: 1.5,
                    valign: 'top',
                    margin: 0,
                  },
                );
              }
              if (hasBody) {
                const bodyY = hasBullets
                  ? slots.body.y + bulletBlockH + 0.12
                  : slots.body.y;
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
          }

          if (layout !== 'image' && imageAbs && slots.image) {
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

        const buffer = (await pptx.write({
          outputType: 'nodebuffer',
        })) as Buffer;
        await writeOutputFile(abs, buffer, overwrite);
        return okPayload({
          ...(await describeOutput(root, abs)),
          format: 'pptx',
          theme,
          footer,
          slides: slides.length,
          layouts: usedLayouts,
          artifact: artifactMetadata({
            format: 'pptx',
            ...(title?.trim()
              ? { title: title.trim() }
              : slides[0]?.title
                ? { title: slides[0].title }
                : {}),
            theme,
            cover: slides.some(
              (slide) => (slide.layout ?? DEFAULT_PPTX_LAYOUT) === 'cover',
            ),
            summary: { kind: 'slides', value: slides.length },
          }),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return errorPayload(
          'PPTX_BUILD_FAILED',
          `生成演示文稿失败:${message}`,
          { message },
        );
      }
    },
  });
}
