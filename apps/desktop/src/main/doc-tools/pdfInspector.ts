/**
 * doc-tools/pdfInspector.ts —— cindy_docs `inspect_pdf` 的宿主实现。
 *
 * 只是一层薄适配:把 MCP 侧的入参转成 reviewer 那条**已经打包好的**一次性 PDF
 * utility process 请求。
 *
 * 为什么复用 reviewer 的进程而不是在 main 里直接 import pdfjs:
 *  1. 打包体积 —— pdfjs 打进 main bundle 是 +1.62 MB(minified),而它已经作为
 *     独立 forge entry 随包发出去了一份,再来一份纯属重复;
 *  2. 安全与稳定 —— 正式包关闭 RunAsNode,解析「模型刚生成/用户给的」PDF 属于
 *     处理不可信输入,不该在 Electron main 进程里做;那个 utility process 有
 *     128MB 堆上限、中性 cwd、最小 env,超时直接 kill;
 *  3. 零打包改动 —— forge entry 与 vite 配置都已存在且被 packaging 契约测试守着。
 *
 * 代价是 doc-tools 依赖了 reviewer 目录下的模块。那个模块本质是「有界 PDF 读取
 * 设施」而非 reviewer 业务逻辑,协议里已按 kind 分成 extract / inspect 两种作业。
 */

import type { InspectPdfFn } from '@cindy/mcps';

import { inspectPdfPagesInChild } from '../reviewer/reviewPdfProcess.js';

/** 与 MCP 工具侧的 MAX_INPUT_BYTES 对齐;子进程侧还会再校验一次。 */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export const inspectPdf: InspectPdfFn = async (input) => {
  const result = await inspectPdfPagesInChild(input.data, {
    timeoutMs: input.timeoutMs,
    maxPages: input.maxPages,
    maxInputBytes: MAX_INPUT_BYTES,
    previewChars: input.previewChars,
    pages: input.pages,
  });
  return {
    numPages: result.numPages,
    pagesInspected: result.pagesInspected,
    pages: result.pages,
  };
};
