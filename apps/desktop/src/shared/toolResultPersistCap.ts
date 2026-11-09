/**
 * tool_result 落库正文上限(chat-data perf):全文不再无界写进 messages.content。
 *
 * 背景:7GB 级本地库里 tool_result 占了绝对大头(单条可达 MB 级、177 万行里
 * 4.5GB),而它既不进 FTS、不进嵌入、不做侧栏预览,device-link 同步到手机也早已
 * 截到 8KB(dispatch.ts REMOTE_TOOL_RESULT_CONTENT_LIMIT)。本地持久化对齐同一
 * 阈值:重开任务仍能看到开头 8K 字符;含卡片关联的结果保留关联及短预览的合法 JSON,
 * 避免截断破坏卡片配对。当前 turn 的完整内容继续走内存
 * resolvedContent,Agent 续跑走 SDK transcript,不依赖这张表。
 *
 * 媒体挂账契约:截断丢弃的尾部可能含首次出现的 cindy-media blob URL,调用方
 * 必须**先对原文扫 URL 挂账、再截断**(见 messagePersistBroadcaster 的
 * persistableToolResultContent),否则生成产物会被 recycler 判零引用回收。
 *
 * 纯函数:main 侧 broadcaster、Claude 导入准备层与 DB worker importer
 * (tx.ts / inline worker fallback)共用同一份,保证所有写入口一个口径。
 * 导入路径的媒体挂账在 main 侧对原文执行(worker 碰不到 cindy-media ledger)。
 */

import { extractToolResultDiagnostics, type ToolResultDiagnostics } from '@cindy/maker-shared/tool-result-compaction';

export const TOOL_RESULT_PERSIST_CONTENT_LIMIT = 8 * 1024;

export const TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX =
  '\n\n[tool result truncated: stored first 8KB]';

/** Keep presentation references parseable; the full card lives in the card store.
 * Self-contained so the legacy inline DB worker can use the same implementation. */
export function compactToolCardResult(text: string, limit: number, diagnostics?: ToolResultDiagnostics): string | null {
  if (
    !text.includes('"xdt_card_id"')
    && !text.includes('"xdt_anchor_card_id"')
    && !text.includes('_xdt_model_files')
    && !text.includes('xdt_media_produced')
  ) return null;
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const references: Record<string, unknown> = {};
    for (const key of ['xdt_card_id', 'xdt_anchor_card_id']) {
      const value = payload[key];
      if (typeof value === 'string' && value.length > 0 && value.length <= 128) references[key] = value;
    }
    // `ok` is carried along but never justifies the summary by itself: a plain
    // oversized result must keep its first 8KB instead of collapsing to a preview.
    const okReference = typeof payload.ok === 'boolean' ? { ok: payload.ok } : {};
    // Only unwrap the documented ghost_call envelope, as the consumer does.
    const inner = payload.ok === true && payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
      ? payload.result as Record<string, unknown>
      : null;
    const source = inner
      ? { ...inner, ...payload, ...(inner._xdt_render_image === false ? { _xdt_render_image: false } : {}) }
      : payload;
    // Delivery grants are decided from the persisted body (sharedTaskFileReferences):
    // a failed or hidden result must not gain file fields it never exposed, so keep the
    // denial signals and drop the declarations. The walk mirrors toolResultFailed: it
    // descends the documented ok===true result chain and treats a non-empty
    // error/errors/exception key as failure, so a nested status or inner error can no
    // longer be laundered into a delivery grant by the summary.
    const denial: Record<string, unknown> = {};
    if (source._xdt_render_image === false) denial._xdt_render_image = false;
    const failureStatuses = ['error', 'failed', 'failure', 'denied', 'declined'];
    const noteFailure = (envelope: Record<string, unknown>) => {
      if (envelope.ok === false) denial.ok = false;
      if (envelope.success === false) denial.success = false;
      if (envelope.isError === true || envelope.is_error === true) denial.isError = true;
      const status = typeof envelope.status === 'string' ? envelope.status.toLowerCase() : '';
      if (failureStatuses.includes(status)) denial.status = status;
      for (const key of ['exitCode', 'exit_code']) {
        const code = envelope[key];
        if (typeof code === 'number' && Number.isFinite(code) && code !== 0) denial[key] = code;
      }
      // An error field carries no display value we can keep, so it collapses into the
      // explicit error flag the consumer already reads.
      const hasError = ['error', 'errors', 'exception'].some((key) => {
        const error = envelope[key];
        if (typeof error === 'string') return error.trim().length > 0;
        if (Array.isArray(error)) return error.length > 0;
        return error === true || (typeof error === 'number' && error !== 0)
          || (!!error && typeof error === 'object');
      });
      if (hasError) denial.isError = true;
    };
    for (let cursor: unknown = payload;;) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) break;
      const envelope = cursor as Record<string, unknown>;
      noteFailure(envelope);
      if (envelope.ok !== true || !envelope.result || typeof envelope.result !== 'object'
        || Array.isArray(envelope.result)) break;
      cursor = envelope.result;
    }
    const denied = Object.keys(denial).length > 0;
    // Declared deliverables must survive the cap as references: cutting the body
    // leaves invalid JSON, so the reopen/device-link scan finds no file card (#5930).
    // Field names and URL alphabets mirror extractPayloadToolResultFiles.
    const keepUrl = /^(?:xdt-file:\/\/[^\s]+|cindy-media:\/\/blobs\/[0-9a-f]{64}\.glb)$/;
    const seen = new Set<string>();
    const candidates: Array<{ url: string; name?: string; produced: boolean }> = [];
    const addCandidate = (produced: boolean, url: unknown, name: unknown) => {
      if (typeof url !== 'string' || url.length > 2048 || !keepUrl.test(url)) return;
      if (seen.has(url) || seen.size >= 50) return;
      seen.add(url);
      const label = typeof name === 'string' && name.length > 0 && name.length <= 200 ? name : undefined;
      candidates.push({ url, produced, ...(label ? { name: label } : {}) });
    };
    if (!denied) {
      const declared = source._xdt_model_files;
      if (Array.isArray(declared)) {
        for (const raw of declared) {
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const record = raw as Record<string, unknown>;
            addCandidate(false, record.url, record.name);
          }
        }
      }
      const producedUrls = source.xdt_media_produced;
      if (Array.isArray(producedUrls)) for (const url of producedUrls) addCandidate(true, url, undefined);
    }
    if (!Object.keys(references).length && !denied && !candidates.length) return null;
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const buildSummary = (files: Array<{ url: string; name?: string }>, producedUrls: string[]) => ({
      ...references,
      ...okReference,
      ...denial,
      ...(files.length ? { _xdt_model_files: files } : {}),
      ...(producedUrls.length ? { xdt_media_produced: producedUrls } : {}),
      truncated: true,
      ...(diagnostics ? { diagnostics } : {}),
      preview: '',
    });
    // Files are packed one by one against the remaining byte budget; whatever does
    // not fit is dropped, so a card reference that fits is never lost to them (P2).
    const files: Array<{ url: string; name?: string }> = [];
    const produced: string[] = [];
    const budget = limit - 1024;
    for (const candidate of candidates) {
      if (candidate.produced) produced.push(candidate.url);
      else files.push(candidate.name ? { url: candidate.url, name: candidate.name } : { url: candidate.url });
      if (size(buildSummary(files, produced)) > budget) {
        if (candidate.produced) produced.pop();
        else files.pop();
        break;
      }
    }
    const summary = buildSummary(files, produced);
    const overhead = size(summary);
    if (overhead > limit) return null;
    // Six bytes per code unit also covers JSON escaping and unpaired surrogates.
    summary.preview = text.slice(0, Math.min(1024, Math.floor((limit - overhead) / 6)));
    return JSON.stringify(summary);
  } catch { return null; }
}

/**
 * 把 tool_result 正文截到落库上限,超限时带截断后缀。按字符数截(不是字节):
 * 上限的意义是"有界",不追求与 device-link 的字节口径逐字节一致。切点回退一位
 * 避免劈开 surrogate pair。幂等:已截断的文本长度必然 <= 上限,不会二次截断。
 */
// Inject the extractor so the inline worker can reuse this function without module imports.
export function createToolResultTextCap(extractDiagnostics: typeof extractToolResultDiagnostics) {
  return function capToolResultTextForPersist(
    text: string,
    limit = TOOL_RESULT_PERSIST_CONTENT_LIMIT,
  ): string {
    if (text.length <= limit) return text;
    const diagnostics = extractDiagnostics(text);
    const cardSummary = compactToolCardResult(text, limit, diagnostics);
    if (cardSummary !== null) return cardSummary;
    const diagnosticFooter = diagnostics ? `\n\n[tool result diagnostics: ${JSON.stringify(diagnostics)}]` : '';
    const suffix = (diagnosticFooter.length + TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length <= limit
      ? diagnosticFooter : '') + TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX;
    let cut = Math.max(0, limit - suffix.length);
    const lastKept = text.charCodeAt(cut - 1);
    if (cut > 0 && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
    return `${text.slice(0, cut)}${suffix}`;
  };
}

export const capToolResultTextForPersist = createToolResultTextCap(extractToolResultDiagnostics);

/** 导入行与 live 落库同一上限:只有字符串 tool_result 会被截;其它 role 原样返回。 */
export function capImportedToolResultContent(role: string, content: unknown): unknown {
  if (role !== 'tool_result' || typeof content !== 'string') return content;
  return capToolResultTextForPersist(content);
}
