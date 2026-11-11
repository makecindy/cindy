/**
 * vision-bridge-transform —— 视觉桥的 proxy 透明替换 transform（层 A）。
 *
 * 在请求转发上游前，把请求体里的图片（Anthropic Messages `image` block 或
 * OpenAI Responses `input_image`）用外部多模态模型转成文字描述，原地替换为文本块。
 * 这样纯文本模型（deepseek 等）收到图时不会因无视觉能力而 400 / 静默丢图。
 *
 * 设计要点（对齐 docs/vision-bridge-design.md 层 A）：
 *  - transform 本身零依赖、纯逻辑；`describeImage` / `shouldBridge` 由 host 注入
 *    （host 连到视觉通道 + 配置判定），本包不 import 任何 Electron / host 模块；
 *  - 短路：`shouldBridge(model)` 为 false（未启用 / 目标模型不含该模型 / 视觉模型）
 *    → 返回 null，字节透传，视觉模型零影响；
 *  - focus hint：取最近一条 user 文本（参考 agent-vision-toolkit vision_proxy.py 的
 *    _last_paragraph 思路）作为视觉 prompt；
 *  - 失败降级：describeImage 抛错 → 替换为显式「图片不可用」占位（对齐
 *    vision_proxy.py 的不可用降级思路），不 502、不阻塞、不静默。
 */

import type { ProxyLogger, RequestTransform } from './types.js';

export interface VisionBridgeTransformOptions {
  /** 判定当前请求的 model 是否启用视觉桥。返回 true 才处理该请求的图片。 */
  shouldBridge: (model: string) => boolean;
  /**
   * 描述一张图，返回文字描述。
   * input.imageUrl：data: URL 或 http(s) URL；input.prompt：focus hint。
   */
  describeImage: (input: { imageUrl: string; prompt: string }) => Promise<string>;
  logger?: ProxyLogger;
}

/** 失败占位：显式指令式文案（进模型输入的安全降级文本，不含原始错误细节）。 */
const VISION_UNAVAILABLE_TEXT =
  '[Image unavailable / 图片不可用: the vision bridge could not analyze this image. ' +
  'Do not infer visual details; tell the user the image could not be inspected. / ' +
  '视觉桥未能分析这张图片。不要推测图片内容；请告知用户无法查看这张图片。]';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 显式收窄为 Record<string, unknown> | null（避免 TS 对索引表达式守卫传播不佳）。 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return isPlainObject(v) ? v : null;
}

function strField(v: unknown, key: string): string {
  const rec = asRecord(v);
  return rec && typeof rec[key] === 'string' ? String(rec[key]) : '';
}

/**
 * 图片 URL 白名单：只允许 http(s): / data: 直传视觉后端。
 * 私有协议（cindy-media:// / xdt-image:// / file://）或裸本地路径是内部引用/本地文件，
 * 不透传给第三方视觉后端（防本地文件路径与内部引用外泄）。
 * 防御：先 trim 并拒绝控制字符，再按协议前缀做 allowlist——避免换行/空格混淆
 * （如 `http:\n//evil`）或 `DATA:` 大小写变体绕过前缀匹配。
 */
function isBridgeableImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  // 拒绝控制字符（换行/回车/空字节等）——防止 `http:\n//evil` 之类混淆绕过协议白名单。
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return /^https?:/i.test(trimmed) || /^data:/i.test(trimmed);
}

function arrField(v: unknown, key: string): unknown[] | null {
  const rec = asRecord(v);
  return rec && Array.isArray(rec[key]) ? (rec[key] as unknown[]) : null;
}

// ── focus hint：最近 user 文本 ──────────────────────────────────────────────

function lastAnthropicUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = asRecord(messages[i]);
    if (!msg || msg.role !== 'user') continue;
    const content = arrField(msg, 'content');
    if (!content) continue;
    const texts: string[] = [];
    for (const b of content) {
      const rec = asRecord(b);
      if (rec && rec.type === 'text') texts.push(strField(rec, 'text'));
    }
    if (texts.length > 0) return texts.join('\n').trim();
  }
  return '';
}

function lastResponsesUserText(input: unknown[]): string {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = asRecord(input[i]);
    if (!item || item.type !== 'message' || item.role !== 'user') continue;
    const content = arrField(item, 'content');
    if (!content) continue;
    const texts: string[] = [];
    for (const b of content) {
      const rec = asRecord(b);
      if (rec && rec.type === 'input_text') texts.push(strField(rec, 'text'));
    }
    if (texts.length > 0) return texts.join('\n').trim();
  }
  return '';
}

// ── Anthropic Messages ──────────────────────────────────────────────────────

interface AnthropicImageJob {
  container: unknown[];
  index: number;
  imageUrl: string | null;
}

/** 收集 messages[].content[] 里的 image block（含 tool_result 内嵌）。 */
function collectAnthropicImages(messages: unknown[]): AnthropicImageJob[] {
  const jobs: AnthropicImageJob[] = [];
  const scan = (content: unknown[]): void => {
    for (let index = 0; index < content.length; index += 1) {
      const block = asRecord(content[index]);
      if (!block) continue;
      if (block.type === 'image') {
        const source = asRecord(block.source);
        let imageUrl: string | null = null;
        if (source) {
          if (source.type === 'url') imageUrl = strField(source, 'url') || null;
          else if (source.type === 'base64' && typeof source.data === 'string') {
            const mt = strField(source, 'media_type') || 'image/png';
            imageUrl = `data:${mt};base64,${source.data}`;
          }
        }
        jobs.push({ container: content, index, imageUrl });
      } else if (block.type === 'tool_result') {
        const inner = arrField(block, 'content');
        if (inner) scan(inner);
      }
    }
  };
  for (const msg of messages) {
    const m = asRecord(msg);
    const content = m ? arrField(m, 'content') : null;
    if (content) scan(content);
  }
  return jobs;
}

function replaceAnthropicImage(job: AnthropicImageJob, text: string): void {
  job.container[job.index] = { type: 'text', text };
}

// ── OpenAI Responses ────────────────────────────────────────────────────────

interface ResponsesImageJob {
  container: unknown[];
  index: number;
  imageUrl: string | null;
}

/** 收集 input[].content / input[].output 里的 input_image 项。 */
function collectResponsesImages(input: unknown[]): ResponsesImageJob[] {
  const jobs: ResponsesImageJob[] = [];
  const scan = (content: unknown[]): void => {
    for (let index = 0; index < content.length; index += 1) {
      const item = asRecord(content[index]);
      if (!item || item.type !== 'input_image') continue;
      const raw = item.image_url;
      // image_url 既可以是字符串（data: / http），也可以是 { url } 对象形态
      // （Responses 协议允许，responses-chat-bridge 同源支持，见其 translate-request）。
      let imageUrl: string | null = null;
      if (typeof raw === 'string') {
        imageUrl = raw;
      } else {
        const rec = asRecord(raw);
        if (rec && typeof rec.url === 'string') imageUrl = rec.url;
      }
      jobs.push({ container: content, index, imageUrl });
    }
  };
  for (const item of input) {
    const it = asRecord(item);
    if (!it) continue;
    const content = arrField(it, 'content');
    if (content) scan(content);
    const output = arrField(it, 'output');
    if (output) scan(output);
  }
  return jobs;
}

function replaceResponsesImage(job: ResponsesImageJob, text: string): void {
  job.container[job.index] = { type: 'input_text', text };
}

// ── transform ───────────────────────────────────────────────────────────────

export function createVisionBridgeTransform(opts: VisionBridgeTransformOptions): RequestTransform {
  const { shouldBridge, describeImage, logger } = opts;
  // 外层是**同步**函数：所有 no-op 分支（非 object / 无 model / shouldBridge 不命中 /
  // 无图片）同步 return null，不创建 Promise（热路径零额外微任务）。只有命中且有图片
  // 才进入 async 内部（返回 Promise 由 runTransforms 用 isPromiseLike await）。
  return (body, ctx) => {
    if (!isPlainObject(body)) return null;
    const model = typeof body.model === 'string' ? body.model : '';
    if (model.length === 0) return null;
    // 短路：未启用 / 目标模型不含该模型 → 字节透传（视觉模型零影响）。
    if (!shouldBridge(model)) return null;

    const messages = Array.isArray(body.messages) ? body.messages : null;
    const input = Array.isArray(body.input) ? body.input : null;

    if (messages) {
      const jobs = collectAnthropicImages(messages);
      if (jobs.length === 0) return null;
      const focusHint = lastAnthropicUserText(messages);
      return (async () => {
        let replaced = 0;
        for (const job of jobs) {
          // 无可用 source / 非白名单协议：不透传给第三方视觉后端（防本地文件与内部引用
          // 外泄），显式降级为「图片不可用」占位，避免把无效图静默透传给纯文本模型。
          if (!job.imageUrl) {
            logger?.warn?.('vision bridge: image block has no usable source, omitting', {
              reqId: ctx.reqId,
              url: ctx.url,
              model,
            });
            replaceAnthropicImage(job, VISION_UNAVAILABLE_TEXT);
            replaced += 1;
            continue;
          }
          if (!isBridgeableImageUrl(job.imageUrl)) {
            logger?.warn?.('vision bridge: image url scheme not allowed for vision backend, omitting', {
              reqId: ctx.reqId,
              url: ctx.url,
              model,
            });
            replaceAnthropicImage(job, VISION_UNAVAILABLE_TEXT);
            replaced += 1;
            continue;
          }
          try {
            const text = await describeImage({ imageUrl: job.imageUrl, prompt: focusHint });
            replaceAnthropicImage(job, text);
          } catch (err) {
            // 占位文本不进原始错误细节（err.message 可能含本地路径/后端 URL，会进入模型
            // 输入）。用通用脱敏文案，避免泄漏；原始错误只进内部日志供诊断。
            logger?.warn?.('vision bridge transform failed (image described as unavailable)', {
              reqId: ctx.reqId,
              url: ctx.url,
              model,
              error: err instanceof Error ? err.message : String(err),
            });
            replaceAnthropicImage(job, VISION_UNAVAILABLE_TEXT);
          }
          replaced += 1;
        }
        if (replaced === 0) return null;
        return { ...body, messages };
      })();
    }
    if (input) {
      const jobs = collectResponsesImages(input);
      if (jobs.length === 0) return null;
      const focusHint = lastResponsesUserText(input);
      return (async () => {
        let replaced = 0;
        for (const job of jobs) {
          if (!job.imageUrl) {
            logger?.warn?.('vision bridge: image block has no usable source, omitting', {
              reqId: ctx.reqId,
              url: ctx.url,
              model,
            });
            replaceResponsesImage(job, VISION_UNAVAILABLE_TEXT);
            replaced += 1;
            continue;
          }
          if (!isBridgeableImageUrl(job.imageUrl)) {
            logger?.warn?.('vision bridge: image url scheme not allowed for vision backend, omitting', {
              reqId: ctx.reqId,
              url: ctx.url,
              model,
            });
            replaceResponsesImage(job, VISION_UNAVAILABLE_TEXT);
            replaced += 1;
            continue;
          }
          try {
            const text = await describeImage({ imageUrl: job.imageUrl, prompt: focusHint });
            replaceResponsesImage(job, text);
          } catch (err) {
            logger?.warn?.('vision bridge transform failed (image described as unavailable)', {
              reqId: ctx.reqId,
              url: ctx.url,
              model,
              error: err instanceof Error ? err.message : String(err),
            });
            replaceResponsesImage(job, VISION_UNAVAILABLE_TEXT);
          }
          replaced += 1;
        }
        if (replaced === 0) return null;
        return { ...body, input };
      })();
    }
    return null;
  };
}
