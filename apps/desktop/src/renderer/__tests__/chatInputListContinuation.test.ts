import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

/**
 * ChatInput 列表接续接线契约:
 * - Shift/Alt+Enter 优先处理结构化列表，再兼容旧纯文本列表;
 * - 普通 Enter 一律保持"发送"语义,绝不被列表接续拦截(2026-07 产品定案:
 *   Enter=发送的肌肉记忆优先);
 * - 守住 IME composition 边界。
 * 结构化与旧纯文本接续行为由各自的编辑器测试覆盖。
 */
describe('ChatInput list continuation wiring contract', () => {
  it('imports both structured-list commands and the legacy plain-text fallback', () => {
    expect(chatInputSource).toContain('handleStructuredListBackspace');
    expect(chatInputSource).toContain('handleStructuredListBreak');
    expect(chatInputSource).toContain('applyListBackspace');
    expect(chatInputSource).toContain('applyListContinuation');
  });

  it('tries structured and legacy continuation on Shift/Alt+Enter', () => {
    const block = extractBetween(
      chatInputSource,
      '// Shift/Alt+Enter — split or exit a structured item.',
      '// Plain Enter keeps the existing queue semantics.',
    );
    expect(block).toContain('(event.shiftKey || event.altKey) &&');
    expect(block).toContain('!event.metaKey');
    expect(block).toContain('!event.ctrlKey');
    expect(block).toContain('!event.isComposing');
    expect(block).toContain(
      'if (handleStructuredListBreak(view) || applyListContinuation(view)) {',
    );
    // 非列表行必须放行给 ComposerHardBreak 默认换行
    expect(block).toContain('return false;');
  });

  it('intercepts bare Backspace for empty-item deletion, leaving modified backspace alone', () => {
    const block = extractBetween(
      chatInputSource,
      '// Backspace — structured list items exit through the schema command;',
      '// Shift/Alt+Enter — split or exit a structured item.',
    );
    expect(block).toContain("event.key === 'Backspace'");
    expect(block).toContain('!event.metaKey');
    expect(block).toContain('!event.ctrlKey');
    expect(block).toContain('!event.altKey');
    expect(block).toContain('!event.shiftKey');
    expect(block).toContain('!event.isComposing');
    // 三段 fallback 依次尝试:结构化列表 → 旧纯文本列表 → 意识指令胶囊整体删。
    // 顺序即优先级:意识指令排最后,只在自身命中时接管,不抢列表的退格语义。
    expect(block).toContain('handleStructuredListBackspace(view) ||');
    expect(block).toContain('applyListBackspace(view) ||');
    expect(block).toContain('applyGhostCommandBackspace(view)');
    expect(block.indexOf('handleStructuredListBackspace(view)')).toBeLessThan(
      block.indexOf('applyListBackspace(view)'),
    );
    expect(block.indexOf('applyListBackspace(view)')).toBeLessThan(
      block.indexOf('applyGhostCommandBackspace(view)'),
    );
  });

  it('never intercepts plain Enter — send semantics stay untouched', () => {
    const plainEnterBlock = extractBetween(
      chatInputSource,
      '// Plain Enter keeps the existing queue semantics.',
      "void dispatchSendRef.current(wantsSteer ? 'steer' : 'queue');",
    );
    expect(plainEnterBlock).not.toContain('handleStructuredListBreak');
    expect(plainEnterBlock).not.toContain('applyListContinuation');
  });

  it('keeps tabular-nums on the editor so multi-line list prefixes align', () => {
    const attributesBlock = extractBetween(
      chatInputSource,
      "'w-full min-h-[22px] max-h-[186px] overflow-y-auto py-[3px] -my-[3px] pr-[11px]',",
      "'focus:outline-none',",
    );
    expect(attributesBlock).toContain('tabular-nums');
  });
});

function extractBetween(source: string, start: string, end: string): string {
  const startIdx = source.indexOf(start);
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = source.indexOf(end, startIdx);
  expect(endIdx).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx);
}
