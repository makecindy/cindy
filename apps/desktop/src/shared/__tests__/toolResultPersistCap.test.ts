import { describe, expect, it } from 'vitest';
import { extractToolResultDiagnostics } from '@cindy/maker-shared/tool-result-compaction';
import { extractPayloadToolResultFiles } from '@cindy/maker-shared/payload-summary';

import {
  TOOL_RESULT_PERSIST_CONTENT_LIMIT,
  TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX,
  capImportedToolResultContent,
  capToolResultTextForPersist,
} from '../toolResultPersistCap';

describe('capToolResultTextForPersist', () => {
  // #5930: cutting the body leaves invalid JSON, so the reopen/device-link scan
  // finds no declared file and the card disappears. Declarations survive as references.
  it('keeps declared files as valid bounded JSON when the body is oversized', () => {
    const body = 'x'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);
    const text = JSON.stringify({
      ok: true,
      _xdt_model_files: [{ url: 'xdt-file:///out/report.pdf', name: 'report.pdf' }],
      body,
    });
    const stored = capToolResultTextForPersist(text);
    expect(stored.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(stored).not.toContain(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX);
    const payload = JSON.parse(stored);
    expect(payload._xdt_model_files).toEqual([{ url: 'xdt-file:///out/report.pdf', name: 'report.pdf' }]);
    expect(payload.ok).toBe(true);
    expect(payload.truncated).toBe(true);
    expect(payload.preview.length).toBeGreaterThan(0);
    expect(capToolResultTextForPersist(stored)).toBe(stored);
  });

  it('keeps produced .glb references and drops URLs outside the file alphabet', () => {
    const glb = `cindy-media://blobs/${'a'.repeat(64)}.glb`;
    const text = JSON.stringify({ xdt_media_produced: [glb, 'https://example.com/x.zip'], body: 'y'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(JSON.parse(stored).xdt_media_produced).toEqual([glb]);
  });

  it('dedupes declarations and keeps a declaration-only payload capped', () => {
    const url = 'xdt-file:///out/a.zip';
    const text = JSON.stringify({ xdt_media_produced: [url, url], _xdt_model_files: [{ url }], body: 'z'.repeat(20000) });
    const payload = JSON.parse(capToolResultTextForPersist(text));
    const kept = [...(payload._xdt_model_files ?? []).map((f: { url: string }) => f.url), ...(payload.xdt_media_produced ?? [])];
    expect(kept).toEqual([url]);
  });

  // 整链路：落库截断后的正文，必须仍能被消费方解析出文件声明。
  it('keeps the file visible to extractPayloadToolResultFiles end to end', () => {
    const url = 'xdt-file:///out/report.pdf';
    const text = JSON.stringify({ ok: true, _xdt_model_files: [{ url, name: 'report.pdf' }], body: 'q'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(extractPayloadToolResultFiles(stored).map((file) => file.url)).toEqual([url]);
    // 旧行为（纯文本截断）下同一份正文解析不出文件，这正是 #5930。
    expect(extractPayloadToolResultFiles(text.slice(0, TOOL_RESULT_PERSIST_CONTENT_LIMIT))).toEqual([]);
  });

  // ghost_call 信封：消费方会展开成功的 result，摘要必须按同一规则读取。
  it('reads declarations inside the documented ghost_call envelope', () => {
    const url = 'xdt-file:///out/nested.pdf';
    const text = JSON.stringify({ ok: true, result: { _xdt_model_files: [{ url, name: 'nested.pdf' }] }, body: 'n'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(extractPayloadToolResultFiles(stored).map((file) => file.url)).toEqual([url]);
  });

  it('keeps a suppressed file card suppressed after truncation', () => {
    const glb = `cindy-media://blobs/${'b'.repeat(64)}.glb`;
    const hidden = JSON.stringify({ _xdt_render_image: false, xdt_media_produced: [glb], body: 'h'.repeat(20000) });
    expect(extractPayloadToolResultFiles(hidden)).toEqual([]);
    const stored = capToolResultTextForPersist(hidden);
    expect(JSON.parse(stored)._xdt_render_image).toBe(false);
    expect(extractPayloadToolResultFiles(stored)).toEqual([]);

    const innerHidden = JSON.stringify({ ok: true, result: { _xdt_render_image: false, xdt_media_produced: [glb] }, body: 'h'.repeat(20000) });
    expect(extractPayloadToolResultFiles(innerHidden)).toEqual([]);
    expect(extractPayloadToolResultFiles(capToolResultTextForPersist(innerHidden))).toEqual([]);
  });

  // 授权回路：失败/隐藏的结果不能借摘要拿到交付字段（sharedTaskFileReferences 用落库内容判权）。
  it('drops declared files for a failed result and keeps the denial signal', () => {
    const url = 'xdt-file:///out/secret.pdf';
    const failed = JSON.stringify({ ok: false, status: 'FAILED', _xdt_model_files: [{ url }], body: 'f'.repeat(20000) });
    const payload = JSON.parse(capToolResultTextForPersist(failed));
    expect(payload._xdt_model_files).toBeUndefined();
    expect(payload.xdt_media_produced).toBeUndefined();
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe('failed');
  });

  it('drops declared files when only the envelope reports failure', () => {
    const url = 'xdt-file:///out/secret.pdf';
    const text = JSON.stringify({ ok: true, result: { ok: false, _xdt_model_files: [{ url }] }, body: 'g'.repeat(20000) });
    const payload = JSON.parse(capToolResultTextForPersist(text));
    expect(payload._xdt_model_files).toBeUndefined();
    expect(payload.ok).toBe(false);
  });

  // 审查 P1：否决口径要与 sharedTaskFileReferences.toolResultFailed 对齐——
  // 外层 error/errors/exception 键非空，以及沿 ok===true 的 result 链每一层的
  // status/success/isError/exitCode 都算失败，否则失败声明会被摘要洗成交付授权。
  it.each([
    ['outer error string', { error: 'boom' }],
    ['outer errors array', { errors: ['boom'] }],
    ['outer exception flag', { exception: true }],
    ['inner status', { ok: true, result: { status: 'failed' } }],
    ['inner isError', { ok: true, result: { isError: true } }],
    ['inner error key', { ok: true, result: { error: 'boom' } }],
    ['nested failure three levels deep', { ok: true, result: { ok: true, result: { status: 'denied' } } }],
  ])('drops declared files when the failure only shows as %s', (_label, failure) => {
    const url = 'xdt-file:///out/secret.pdf';
    const text = JSON.stringify({ ...failure, _xdt_model_files: [{ url }], body: 'k'.repeat(20000) });
    const payload = JSON.parse(capToolResultTextForPersist(text));
    expect(payload._xdt_model_files).toBeUndefined();
    expect(payload.xdt_media_produced).toBeUndefined();
    // 同一口径复核：摘要仍被判失败，回不到成功交付路径。
    expect(payload.ok === false || payload.success === false || payload.isError === true
      || ['failed', 'denied', 'error'].includes(payload.status)).toBe(true);
    expect(extractPayloadToolResultFiles(JSON.stringify(payload))).toEqual([]);
  });

  // 审查 P1（message 型失败）：`sharedTaskFileReferences.toolResultFailed` 在没有显式成功
  // 信号时还会按 message 首行判失败；摘要丢掉 message 却留声明，等于把失败洗成交付授权。
  it.each([
    ['an unqualified error message', { message: 'Error: failed to open /out/secret.pdf' }],
    ['a tool_use_error marker', { message: '<tool_use_error>operation stopped</tool_use_error>' }],
    ['a Chinese failure sentence', { message: '读取失败：目录不存在' }],
    ['an error record inside the message', { message: JSON.stringify({ ok: false, error: 'boom' }) }],
    ['a nested unqualified error message', { ok: true, result: { message: 'request failed 500' } }],
    ['a message failure next to a card id', { message: 'ENOENT: no such file', xdt_card_id: 'card_secret' }],
  ])('drops declared files when the failure only shows as %s', (_label, failure) => {
    const url = 'xdt-file:///out/secret.pdf';
    const text = JSON.stringify({ ...failure, _xdt_model_files: [{ url }], body: 'p'.repeat(20000) });
    const payload = JSON.parse(capToolResultTextForPersist(text));
    expect(payload._xdt_model_files).toBeUndefined();
    expect(payload.xdt_media_produced).toBeUndefined();
    expect(payload.message).toBeUndefined();
    // 摘要本身仍被判失败（与 toolResultFailed 同口径），回不到成功交付路径。
    expect(payload.isError).toBe(true);
    expect(extractPayloadToolResultFiles(JSON.stringify(payload))).toEqual([]);
  });

  // 对照：message 不是失败诊断，或已有显式成功信号时，不能误伤文件声明。
  it.each([
    ['a delivery message', { message: 'File written to /out/report.pdf' }],
    ['a message that only mentions errors', { message: 'Report saved. error count: 0' }],
    ['a success flag beside an error-shaped message', { ok: true, message: 'Error: 0 items skipped' }],
    ['a completed status beside an error-shaped message', { status: 'completed', message: 'Failed to parse 0 lines' }],
  ])('keeps declared files when %s', (_label, envelope) => {
    const url = 'xdt-file:///out/report.pdf';
    const text = JSON.stringify({ ...envelope, _xdt_model_files: [{ url }], body: 'm'.repeat(20000) });
    expect(extractPayloadToolResultFiles(capToolResultTextForPersist(text)).map((file) => file.url)).toEqual([url]);
  });

  it('keeps an error-free envelope delivering its declared files', () => {
    const url = 'xdt-file:///out/report.pdf';
    // 对照：成功结果与无 ok 字段的声明仍要保住卡片，否决不能误伤。
    for (const envelope of [{ ok: true }, { status: 'completed' }, {}]) {
      const text = JSON.stringify({ ...envelope, _xdt_model_files: [{ url }], body: 'm'.repeat(20000) });
      expect(extractPayloadToolResultFiles(capToolResultTextForPersist(text)).map((file) => file.url)).toEqual([url]);
    }
  });

  // 字节预算：文件装不下时退回卡片摘要，不能把父提交能保留的 card id 一起丢掉。
  it('keeps the card reference when declared files cannot fit the budget', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({
      url: `xdt-file:///out/${'x'.repeat(180)}-${index}.pdf`,
      name: 'n'.repeat(200),
    }));
    const text = JSON.stringify({ ok: true, xdt_card_id: 'card_keep', _xdt_model_files: files, body: 'b'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(stored.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    const payload = JSON.parse(stored);
    expect(payload.xdt_card_id).toBe('card_keep');
    expect((payload._xdt_model_files ?? []).length).toBeLessThan(files.length);
  });

  // 诊断保留：纯文件摘要没有 card id，归档时也必须能读回它的 diagnostics。
  it('keeps diagnostics readable for a summary that only declares files', () => {
    const url = 'xdt-file:///out/report.pdf';
    const text = JSON.stringify({ ok: true, _xdt_model_files: [{ url }],
      afterSnapshot: { ok: false, errorCode: 'ACT_INVALID_REQUEST', message: 'PRIVATE' }, body: 'd'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(extractPayloadToolResultFiles(stored).map((file) => file.url)).toEqual([url]);
    expect(extractToolResultDiagnostics(stored))
      .toEqual({ ok: true, afterSnapshotOk: false, afterSnapshotErrorCode: 'ACT_INVALID_REQUEST' });
  });

  // `ok` 只是附带字段：没有卡片、文件或否决信号时，普通结果必须保留原有的前 8KB。
  it('keeps the first 8KB for an ordinary oversized result that only reports ok', () => {
    const text = JSON.stringify({ ok: true, body: 'k'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(stored.length).toBe(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(stored.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(stored.startsWith('{"ok":true,"body":"kkk')).toBe(true);
  });

  it('keeps the first 8KB when the body only mentions a declaration field', () => {
    const text = JSON.stringify({ ok: true, body: `${'m'.repeat(9000)} xdt_media_produced` });
    expect(capToolResultTextForPersist(text).endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('keeps the first 8KB when the declared file arrays are empty', () => {
    const text = JSON.stringify({ ok: true, xdt_media_produced: [], _xdt_model_files: [], body: 'e'.repeat(20000) });
    expect(capToolResultTextForPersist(text).endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('still truncates payloads that declare nothing', () => {
    const text = JSON.stringify({ body: 'w'.repeat(20000) });
    const stored = capToolResultTextForPersist(text);
    expect(stored.length).toBe(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(stored.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('returns short text unchanged', () => {
    expect(capToolResultTextForPersist('hello')).toBe('hello');
    const exact = 'x'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capToolResultTextForPersist(exact)).toBe(exact);
  });

  it('caps oversized text to the limit with a truncation suffix', () => {
    const big = 'a'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT + 1);
    const capped = capToolResultTextForPersist(big);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(capped.startsWith('aaa')).toBe(true);
  });

  // CU-008: flags can appear after the discarded body; inspect the original structured result.
  it('retains only bounded diagnostic fields before truncation', () => {
    const text = JSON.stringify({ body: 'x'.repeat(9000), ok: false, errorCode: 'STALE_SNAPSHOT', message: 'PRIVATE' });
    const capped = capToolResultTextForPersist(text);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capped).not.toContain('PRIVATE');
    expect(extractToolResultDiagnostics(capped)).toEqual({ ok: false, errorCode: 'STALE_SNAPSHOT' });
    expect(capToolResultTextForPersist(capped)).toBe(capped);
    expect(extractToolResultDiagnostics(capToolResultTextForPersist(text, 100))).toBeUndefined();
  });

  it('is idempotent', () => {
    const big = 'b'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 3);
    const once = capToolResultTextForPersist(big);
    expect(capToolResultTextForPersist(once)).toBe(once);
  });

  it('does not split a surrogate pair at the cut point', () => {
    const budget = TOOL_RESULT_PERSIST_CONTENT_LIMIT - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length;
    const text = `${'x'.repeat(budget - 1)}😀${'y'.repeat(2 * TOOL_RESULT_PERSIST_CONTENT_LIMIT)}`;
    const capped = capToolResultTextForPersist(text);
    const kept = capped.slice(0, capped.length - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length);
    const lastCode = kept.charCodeAt(kept.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(kept).toBe('x'.repeat(budget - 1));
  });

  it('respects a custom limit', () => {
    const capped = capToolResultTextForPersist('c'.repeat(300), 100);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });

  // Long HTML draft read-backs used to lose their trailing card ID at 8KB.
  // Check the actual persistence entry point, including phone byte budgets.
  it('preserves card references as valid bounded JSON when the body is oversized', () => {
    const input = JSON.stringify({ ok: true, result: { bodyHtml: '你好\\"😀'.repeat(4000) },
      xdt_card_id: 'draft-card', xdt_anchor_card_id: 'original-card',
      afterSnapshot: { ok: false, errorCode: 'ACT_INVALID_REQUEST', message: 'PRIVATE' } });
    const stored = capToolResultTextForPersist(input);
    expect(JSON.parse(stored)).toMatchObject({ ok: true, xdt_card_id: 'draft-card', xdt_anchor_card_id: 'original-card' });
    expect(stored).not.toContain('PRIVATE');
    expect(extractToolResultDiagnostics(stored)).toEqual({ ok: true, afterSnapshotOk: false, afterSnapshotErrorCode: 'ACT_INVALID_REQUEST' });
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(8192);
    expect(capToolResultTextForPersist(stored)).toBe(stored);
  });
});

describe('capImportedToolResultContent', () => {
  it('caps string tool_result and leaves other roles alone', () => {
    const huge = 'z'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);
    const capped = capImportedToolResultContent('tool_result', huge);
    expect(typeof capped).toBe('string');
    expect((capped as string).length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capImportedToolResultContent('assistant', huge)).toBe(huge);
    expect(capImportedToolResultContent('tool_result', { text: huge })).toEqual({ text: huge });
  });
});
