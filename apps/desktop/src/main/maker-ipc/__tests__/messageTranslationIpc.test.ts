/**
 * 测试价值
 * - 生产入口与可观察结果：`maker:translate-message` handler；用户看到的译文里代码块与组件块
 *   原样保留，模型丢失占位符时不显示残缺译文，切换账号后的迟到结果被丢弃。
 * - Bug／规则依据：electron-security-and-process-boundaries.md §5（新 IPC 校验 sender 与 payload）；
 *   翻译只换显示、不得改动代码与 cindy-ui 块（本功能的核心契约）。
 * - 现有覆盖缺口：新增 handler，无既有覆盖。
 * - 最小失败输入：含一个 ``` 代码块的回复，模型返回时漏掉占位符；引用内（`> ````）或结尾未闭合的代码块。
 * - tier：unit（进程内 fake 辅助模型）。
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { MessageTranslationResult } from '../../../shared/messageTranslation.js';

const h = vi.hoisted(() => ({
  handler: null as null | ((event: unknown, request: unknown) => Promise<MessageTranslationResult>),
  request: vi.fn(), trust: vi.fn(), owner: 'owner', boundary: false,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (_channel: string, handler: typeof h.handler) => { h.handler = handler; } } }));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({}) }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: h.trust }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.request }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.owner, isAppSessionBoundaryPending: () => h.boundary }));
import { registerMessageTranslationIpc } from '../messageTranslation.js';

const reply = [
  'Run this command:',
  '',
  '```bash',
  'pnpm install # do not translate',
  '```',
  '',
  'Then restart.',
].join('\n');
const invoke = (text = reply) => h.handler!({}, { text, locale: 'zh-CN' });
/** Fake model: translates the prose and echoes the placeholder it was given. */
const translateProse = (prompt: string) => prompt.replace('Run this command:', '运行这条命令：').replace('Then restart.', '然后重启。');

beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 'owner'; h.boundary = false;
  registerMessageTranslationIpc();
  h.request.mockImplementation(async (_maker: unknown, prompt: string) => ({ ok: true, text: translateProse(prompt) }));
});

it('sends prose without code to the model and restores fenced blocks verbatim', async () => {
  expect(await invoke()).toEqual({
    ok: true,
    text: ['运行这条命令：', '', '```bash', 'pnpm install # do not translate', '```', '', '然后重启。'].join('\n'),
  });
  const [, prompt, opts] = h.request.mock.calls[0];
  expect(prompt).not.toContain('pnpm install');
  expect(opts.systemPrompt).toContain('Simplified Chinese');
  expect(opts.validateResponse(translateProse(prompt))).toBe(true);
  expect(opts.validateResponse('运行这条命令：然后重启。')).toBe(false);
});

it('never shows a translation that lost a protected block', async () => {
  h.request.mockResolvedValue({ ok: true, text: '运行这条命令：然后重启。' });
  expect(await invoke()).toEqual({ ok: false, reason: 'failed' });
});

// The renderer shows these as code too, so the model must never see their contents.
it.each([
  ['inside a quote', ['Run this command:', '', '> ```bash', '> pnpm install # do not translate', '> ```', '', 'Then restart.'].join('\n')],
  ['left unclosed at the end', ['Run this command:', '', '```bash', 'pnpm install # do not translate'].join('\n')],
])('protects a code block %s and restores it verbatim', async (_name, text) => {
  const result = await invoke(text);
  const [, prompt, opts] = h.request.mock.calls[0];
  expect(prompt).not.toContain('pnpm install');
  expect(opts.rejectTruncated).toBe(true);
  expect(result).toMatchObject({ ok: true });
  const translated = (result as { text: string }).text;
  expect(translated).toContain('运行这条命令：');
  expect(translated).toContain(text.slice(text.indexOf('```')).split('\n\nThen')[0]!);
});

it('distinguishes a missing auxiliary model from a failed attempt', async () => {
  h.request.mockResolvedValue({ ok: false, reason: 'no_candidate', attempts: [] });
  expect(await invoke()).toEqual({ ok: false, reason: 'unavailable' });
  h.request.mockResolvedValue({ ok: false, reason: 'timeout', attempts: [] });
  expect(await invoke()).toEqual({ ok: false, reason: 'failed' });
});

it('drops a result that arrives after the account changed', async () => {
  h.request.mockImplementation(async (_maker: unknown, prompt: string) => {
    h.owner = 'other';
    return { ok: true, text: translateProse(prompt) };
  });
  expect(await invoke()).toEqual({ ok: false, reason: 'failed' });
});

it('rejects untrusted callers and malformed payloads before any model call', async () => {
  await expect(h.handler!({}, { text: reply, locale: 'xx' })).rejects.toThrow();
  await expect(h.handler!({}, { text: reply, locale: 'zh-CN', sessionId: 'x' })).rejects.toThrow();
  h.trust.mockImplementationOnce(() => { throw new Error('untrusted'); });
  await expect(invoke()).rejects.toThrow('untrusted');
  expect(await invoke('x'.repeat(40_001))).toEqual({ ok: false, reason: 'too_long' });
  expect(h.request).not.toHaveBeenCalled();
});
