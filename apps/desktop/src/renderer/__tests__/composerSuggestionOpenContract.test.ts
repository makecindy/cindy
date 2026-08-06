import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/new-chat/ChatInput.tsx', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

describe('composer synthetic suggestion open contract', () => {
  it('device-link 远程草稿没有工作目录时仅为空查询跳过资源扫描', () => {
    const start = source.indexOf('const runAtScan = useCallback');
    const end = source.indexOf('const syntheticAtQuery', start);
    const scanner = source.slice(start, end);
    const normalizedQuery = "const normalizedQuery = query?.trim() ?? '';";
    const guard = 'if (remoteDeviceId && !workingDir?.trim() && !normalizedQuery) {';

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(scanner).toContain(normalizedQuery);
    expect(scanner).toContain(guard);
    expect(scanner.indexOf(normalizedQuery)).toBeLessThan(scanner.indexOf(guard));
    expect(scanner.indexOf(guard)).toBeLessThan(scanner.indexOf('scanAtResources('));
    expect(scanner).toContain("setAtState({ kind: 'ready', items: [], truncated: false });");
  });

  it('SSH 远程面板跳过扫描时作废旧的异步扫描', () => {
    const start = source.indexOf('const runAtScan = useCallback');
    const end = source.indexOf('const syntheticAtQuery', start);
    const scanner = source.slice(start, end);
    const guardStart = scanner.indexOf('if (isRemoteSession) {');
    const guardEnd = scanner.indexOf('\n      }', guardStart);
    const guard = scanner.slice(guardStart, guardEnd);

    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(guard).toContain('atScanSeqRef.current += 1;');
    expect(guard.indexOf('atScanSeqRef.current += 1;')).toBeLessThan(
      guard.indexOf("setAtState({ kind: 'ready', items: [], truncated: false });"),
    );
  });

  it('synthetic 查询使用映射后的独立范围，typed @ 才向后扫描完整 run', () => {
    const start = source.indexOf('const resolveEffectiveAtRange = useCallback');
    const end = source.indexOf('const insertAtResource', start);
    const resolver = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain("if (effectiveAt.activation === 'synthetic') {");
    expect(resolver).toContain('const to = syntheticAtRangeEndRef.current;');
    expect(resolver).toContain('return to !== null && to >= from ? { from, to } : null;');
    expect(resolver).toContain('const triggerOffset = 1;');
    expect(resolver).toContain('let runEnd = from + triggerOffset;');
    expect(resolver).toContain('const offset = from - parentStart + triggerOffset;');
  });

  it('synthetic 空查询保持零长度替换范围', () => {
    const stateStart = source.indexOf('const syntheticAtAnchorRef = useRef');
    const stateEnd = source.indexOf('const [isDragOver', stateStart);
    const state = source.slice(stateStart, stateEnd);

    expect(stateStart).toBeGreaterThanOrEqual(0);
    expect(stateEnd).toBeGreaterThan(stateStart);
    expect(state).toContain('const syntheticAtRangeEndRef = useRef<number | null>(null);');
    expect(state).toContain('syntheticAtRangeEndRef.current = next;');
  });

  it('synthetic 输入范围随文档 transaction 映射', () => {
    const start = source.indexOf('onUpdate: ({ editor: ed, transaction }) => {');
    const end = source.indexOf('const nextRenderSnapshot', start);
    const updater = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(updater).toContain('transaction.docChanged');
    expect(updater).toContain('transaction.mapping.map(syntheticRangeEnd, 1)');
  });

  it('已有文本选区时 + 仍以选区起点打开空查询面板', () => {
    const deriveStart = source.indexOf('function deriveSyntheticAtQuery');
    const deriveEnd = source.indexOf('\n}\n\nexport function ChatInput', deriveStart);
    const derive = source.slice(deriveStart, deriveEnd);
    const handlerStart = source.indexOf('const handleComposerSuggestionOpenChange = useCallback');
    const handlerEnd = source.indexOf('const composerSuggestionFocusTarget', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(deriveStart).toBeGreaterThanOrEqual(0);
    expect(deriveEnd).toBeGreaterThan(deriveStart);
    expect(derive).toContain("if (!selection.empty) return selection.from === anchor ? '' : null;");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('setSyntheticAtAnchor(editor.state.selection.from);');
  });

  it('打开 + 时保留同一 typed @ run 的 Esc suppression', () => {
    const start = source.indexOf('const handleComposerSuggestionOpenChange = useCallback');
    const end = source.indexOf('const composerSuggestionFocusTarget', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('setSuppressedAtAt(trigger.from);');
    expect(handler).not.toContain('setSuppressedAtAt(null);');
    expect(handler).not.toContain('if (atOpen)');
    expect(handler).toContain('setSyntheticAtAnchor(editor.state.selection.from);');
  });
});
