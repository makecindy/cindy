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

  it('synthetic 查询选择条目时替换完整查询段而不是只替换到光标', () => {
    const start = source.indexOf('const resolveEffectiveAtRange = useCallback');
    const end = source.indexOf('const insertAtResource', start);
    const resolver = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain(
      "const triggerOffset = effectiveAt.activation === 'typed' ? 1 : 0;",
    );
    expect(resolver).toContain('let runEnd = from + triggerOffset;');
    expect(resolver).toContain('const offset = from - parentStart + triggerOffset;');
    expect(resolver).not.toContain('const to = editor.state.selection.from;');
  });

  it('synthetic 空查询保持零长度替换范围', () => {
    const start = source.indexOf('const resolveEffectiveAtRange = useCallback');
    const end = source.indexOf('const insertAtResource', start);
    const resolver = source.slice(start, end);
    const emptyQueryGuard =
      "if (effectiveAt.activation === 'synthetic' && effectiveAt.query.length === 0) {";

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain(emptyQueryGuard);
    expect(resolver).toContain('return { from, to: from };');
    expect(resolver.indexOf(emptyQueryGuard)).toBeLessThan(
      resolver.indexOf('editor.state.doc.resolve(from)'),
    );
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
    expect(handler).toContain('setSyntheticAtAnchor(editor.state.selection.from);');
  });
});
