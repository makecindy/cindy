/**
 * makerExperimentalAccepted.test.ts
 * ---------------------------------------------------------------------------
 * 项目没有 jsdom / Testing Library，这里用源码契约守住实验页 send 结果处理：
 * maker.send 返回 accepted:false 时没有启动 turn，输入框不能被当作成功发送清空。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hookSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useMakerSession.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
const viewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'maker-experimental', 'MakerExperimentalView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('Maker Experimental accepted result handling', () => {
  it('keeps the maker.send accepted result in useMakerSession', () => {
    expect(hookSource).toContain('type MakerSendResult = { accepted: boolean }');
    expect(hookSource).toContain(
      "send: (text: string, attachments?: Array<{ type: 'image' | 'file'; path: string; mimeType?: string }>) => Promise<MakerSendResult>;",
    );
    expect(hookSource).toContain(
      "send: (sid: string, message: { type: 'user'; content: unknown }) => Promise<MakerSendResult>;",
    );
    expect(hookSource).toContain(
      "const result = await api.send(sessionIdRef.current, { type: 'user', content });",
    );
    expect(hookSource).toContain('return result;');
  });

  it('does not clear the input when maker.send returns accepted:false', () => {
    const sendBlock = extractBetween(
      viewSource,
      'const handleSend = async () => {',
      'const models =',
    );

    expect(sendBlock).toContain('const result = await m.send(inputText, attachments);');
    expect(sendBlock).toContain('if (result.accepted === false) {');
    expectOrder(sendBlock, 'if (result.accepted === false) {', "setInputText('');");
    expect(sendBlock).toContain("setSendError(t('makerExperimental.sendNotAccepted'));");
  });

  it('defines the rejected-send message in every locale', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
      const raw = readFileSync(
        resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'),
        'utf8',
      );
      const json = JSON.parse(raw) as { makerExperimental?: { sendNotAccepted?: unknown } };
      expect(json.makerExperimental?.sendNotAccepted).toEqual(expect.any(String));
      expect(json.makerExperimental?.sendNotAccepted).not.toBe('');
    }
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}

function expectOrder(sourceBlock: string, firstNeedle: string, secondNeedle: string): void {
  const first = sourceBlock.indexOf(firstNeedle);
  const second = sourceBlock.indexOf(secondNeedle);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(second);
}
