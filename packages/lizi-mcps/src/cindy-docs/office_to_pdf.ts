/**
 * cindy-docs/office_to_pdf.ts —— 已有 Office 文件 → PDF(增强层)。
 *
 * 这是整个 cindy_docs 里**唯一有系统依赖**的工具。判断很直接:Word/PPT/Excel
 * 的完整版式还原需要一个真正的 Office 排版引擎,Chromium 做不到,自己写更不可能。
 * 所以做成增强层:装了 LibreOffice 就真转,没装就明说 + 给安装指引。
 *
 * 诚实降级的边界:未安装返回 SOFFICE_NOT_FOUND(带人话指引),不是「转换失败」,
 * 也不是悄悄产出一个坏文件。模型据此告诉用户「这台机器还差一个免费软件」,
 * 而不是反复重试同一个必然失败的调用。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import {
  findSoffice,
  installHintForPlatform,
  OFFICE_INPUT_EXTENSIONS,
  runSofficeConvert,
  type SofficeConvertOptions,
  type SofficeLookupOptions,
} from './soffice.js';
import type { DocsMcpSessionCtx } from './types.js';

/** 转换硬超时。大 PPT 冷启动 LibreOffice 慢,给足 2 分钟。 */
export const OFFICE_CONVERT_TIMEOUT_MS = 120_000;

const DESCRIPTION = [
  '把已有的 Office 文件(.docx/.doc/.pptx/.ppt/.xlsx/.xls/.odt/.odp/.ods/.rtf/.csv)转成 PDF。',
  '',
  '【前置】本工具依赖用户机器上装了 LibreOffice(免费开源)。没装会返回',
  'SOFFICE_NOT_FOUND 并附安装指引 —— 那时请如实告诉用户,不要反复重试。',
  '',
  '【何时用】用户手上已经有一份 Word/PPT,只想要一份 PDF 版本。',
  '如果内容还在你手里(还没生成文件),更好的做法是直接写 HTML + render_pdf,',
  '或者用 make_docx / make_pptx 生成源文件 —— 少一环转换就少一处版式走样。',
  '',
  '【输入输出】两个路径都必须在本任务的工作目录内。',
  '同名输出文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

export interface OfficeToPdfToolOptions {
  /** 测试注入点:探测与执行都可替换,免得单测依赖本机装没装 LibreOffice。 */
  lookup?: SofficeLookupOptions;
  run?: SofficeConvertOptions['run'];
}

export function registerOfficeToPdfTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  options: OfficeToPdfToolOptions = {},
): void {
  registry.register({
    name: 'office_to_pdf',
    category: 'convert',
    description: DESCRIPTION,
    inputShape: {
      path: z.string().min(1).describe('要转换的 Office 文件路径,工作目录内。'),
      outPath: z.string().min(1).describe('输出 .pdf 路径,工作目录内。'),
      overwrite: z.boolean().default(false).describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({ path: inputPath, outPath, overwrite }) => {
      let workDir: string | undefined;
      try {
        const root = resolveSessionRoot(sessionCtx);
        const abs = await prepareInputPath(root, inputPath);
        const ext = path.extname(abs).toLowerCase();
        if (!OFFICE_INPUT_EXTENSIONS.has(ext)) {
          return errorPayload(
            'UNSUPPORTED_FORMAT',
            `不支持把 "${ext}" 转成 PDF。支持的是:${[...OFFICE_INPUT_EXTENSIONS].join(' ')}。`,
            { path: abs, extension: ext },
          );
        }

        const sofficePath = await findSoffice(options.lookup ?? {});
        if (!sofficePath) {
          return errorPayload('SOFFICE_NOT_FOUND', installHintForPlatform(), {
            platform: process.platform,
            // 明确告诉模型这不是可重试的失败,避免它原地打转。
            retryable: false,
          });
        }

        const outAbs = await prepareOutputPath(root, outPath, overwrite);

        // soffice 只能指定输出目录、文件名由它决定,所以先转进任务专属临时目录,
        // 再搬到用户要的位置。临时目录按 credentials-and-local-storage 的口径放
        // os.tmpdir() 下,成功失败都清理。
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-'));
        await runSofficeConvert({
          sofficePath,
          inputPath: abs,
          outDir: workDir,
          timeoutMs: OFFICE_CONVERT_TIMEOUT_MS,
          ...(options.run ? { run: options.run } : {}),
        });

        const produced = path.join(
          workDir,
          `${path.basename(abs, path.extname(abs))}.pdf`,
        );
        let bytes = 0;
        try {
          bytes = (await fs.stat(produced)).size;
        } catch {
          bytes = 0;
        }
        if (bytes === 0) {
          // soffice 有「退出码 0 但没产出文件」的经典假成功(profile 被 GUI 占用、
          // 源文件损坏)。这里显式判产物,不看退出码。
          return errorPayload(
            'CONVERT_FAILED',
            'LibreOffice 跑完了但没产出 PDF。常见原因:源文件损坏,或用户正开着 LibreOffice 界面占用配置。请让用户关掉 LibreOffice 后重试;还不行就先用 Office 打开源文件确认它是好的。',
            { input: abs },
          );
        }
        await fs.copyFile(produced, outAbs);

        return okPayload({
          ...(await describeOutput(root, outAbs)),
          format: 'pdf',
          source: abs,
          converter: sofficePath,
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = /timed out|timeout|ETIMEDOUT/i.test(message);
        return errorPayload(
          timedOut ? 'CONVERT_TIMEOUT' : 'CONVERT_FAILED',
          timedOut
            ? `转换超过 ${OFFICE_CONVERT_TIMEOUT_MS / 1000} 秒被中止。文件可能太大或 LibreOffice 卡住了;让用户关掉 LibreOffice 界面后重试。`
            : `转换失败:${message}`,
          { message },
        );
      } finally {
        if (workDir) {
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {
            /* 临时目录清理是尽力而为,失败不影响已经产出的结果 */
          });
        }
      }
    },
  });
}
